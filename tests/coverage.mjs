import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'build/coverage');
mkdirSync(directory, { recursive: true });
// Remove only this runner's previous coverage artifacts, never source files.
for (const name of readdirSync(directory)) {
  if (/\.(gcda|gcno|gcov\.json\.gz)$/.test(name)) unlinkSync(resolve(directory, name));
}
const cc = process.env.CC || 'cc';
const invoke = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const sources = readdirSync(resolve(root, 'bootstrap/stage0')).filter(name => name.endsWith('.c')).sort();
const objects = sources.map(name => resolve(directory, name.replace(/\.c$/, '.o')));
for (let i = 0; i < sources.length; ++i) {
  invoke(cc, ['-std=c11', '-O0', '-g', '--coverage', '-Wall', '-Wextra', '-Wpedantic', '-Werror',
    ...(sources[i] === 'main.c' ? ['-Dmain=l_entry'] : []), '-c', `bootstrap/stage0/${sources[i]}`, '-o', objects[i]]);
}
invoke(cc, ['--coverage', ...objects, 'tests/entry.c', '-o', resolve(directory, 'l')]);
invoke('sh', ['tests/run.sh', resolve(directory, 'l')]);
invoke('node', ['tests/modules.mjs', resolve(directory, 'l')]);
invoke('node', ['tests/stage1.mjs', resolve(directory, 'l')]);
invoke('node', ['tests/stage1-expressions.mjs', resolve(directory, 'l')]);
invoke(cc, ['-std=c11', '--coverage', ...objects, 'tests/frontend.c', '-o', resolve(directory, 'frontend-test')]);
invoke(resolve(directory, 'frontend-test'), []);
for (const name of ['faults', 'verifier', 'observer', 'fuzz']) {
  if (!existsSync(resolve(root, `tests/${name}.c`))) continue;
  invoke(cc, ['-std=c11', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '--coverage', ...objects,
    `tests/${name}.c`, ...(name === 'faults' ? ['-Wl,--wrap=calloc,--wrap=fread,--wrap=ferror,--wrap=fclose,--wrap=stat'] : []),
    '-o', resolve(directory, `${name}-test`)]);
  invoke(resolve(directory, `${name}-test`), []);
}
let gcov = process.env.GCOV;
if (!gcov) {
  gcov = execFileSync(cc, ['-print-prog-name=gcov'], { encoding: 'utf8' }).trim();
  if (gcov === 'gcov') {
    const library = execFileSync(cc, ['-print-file-name=libgcov.a'], { encoding: 'utf8' }).trim();
    const candidate = resolve(dirname(library), '../../../../bin/gcov');
    if (existsSync(candidate)) gcov = candidate;
  }
}
const report = { files: [], lines: { hit: 0, total: 0 }, functions: { hit: 0, total: 0 }, branches: { hit: 0, total: 0 } };
for (const object of objects) {
  invoke(gcov, ['--json-format', '--branch-probabilities', '--branch-counts', object], { cwd: directory, stdio: 'pipe' });
  const document = JSON.parse(gunzipSync(readFileSync(resolve(directory, `${basename(object, '.o')}.gcov.json.gz`))));
  for (const file of document.files) {
    const missingLines = file.lines.filter(line => line.count === 0).map(line => line.line_number);
    const missingFunctions = file.functions.filter(fn => fn.execution_count === 0).map(fn => fn.name);
    const missingBranches = file.lines.flatMap(line => (line.branches || []).flatMap((branch, index) =>
      branch.count === 0 ? [`${line.line_number}:${index}`] : []));
    report.files.push({ file: file.file, missingLines, missingFunctions, missingBranches });
    report.lines.total += file.lines.length;
    report.lines.hit += file.lines.length - missingLines.length;
    report.functions.total += file.functions.length;
    report.functions.hit += file.functions.length - missingFunctions.length;
    report.branches.total += file.lines.reduce((sum, line) => sum + (line.branches || []).length, 0);
    report.branches.hit = report.branches.total - report.files.reduce((sum, entry) => sum + entry.missingBranches.length, 0);
  }
}
writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
let complete = true;
for (const metric of ['lines', 'functions', 'branches']) {
  const { hit, total } = report[metric];
  console.log(`${metric}: ${hit}/${total} (${(100 * hit / total).toFixed(2)}%)`);
  if (hit !== total) complete = false;
}
console.log('Full report: build/coverage/report.json (no production-source exclusions)');
process.exitCode = complete ? 0 : 1;
