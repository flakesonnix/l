import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const compiler = resolve(process.argv[2]);
const work = mkdtempSync(resolve('build/modules.'));
let checks = 0, fixtures = 0;
const config = () => ({ version: 1, package: 'application', module_roots: [
  { package: 'application', prefix: 'app', path: 'src/app' },
  { package: 'stdlib', prefix: 'std', path: 'src/std' },
], dependencies: [{ from: 'application', to: 'stdlib' }] });
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function fixture(files = {}, settings = config()) {
  const directory = resolve(work, String(fixtures++));
  mkdirSync(resolve(directory, 'src/app'), { recursive: true });
  mkdirSync(resolve(directory, 'src/std'), { recursive: true });
  const sources = { 'app/main.l': 'module app.main; int main(){return 42;}', ...files };
  for (const [name, text] of Object.entries(sources)) put(resolve(directory, 'src', name), text);
  const manifest = resolve(directory, 'package.json'), input = resolve(directory, 'src/app/main.l');
  put(manifest, typeof settings === 'string' || Buffer.isBuffer(settings) ? settings : JSON.stringify(settings));
  return { directory, manifest, input };
}
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  ++checks;
  return result;
}
function source(f, status = 0, verb = 'check', extra = [], options = {}) {
  return command(status, [verb, f.input, '--manifest', f.manifest, ...extra], options);
}
function rejected(files, message, settings = config()) {
  const f = fixture(files, settings);
  assert.match(source(f, 65).stderr, message);
  const output = resolve(f.directory, 'no.lbc');
  assert.match(source(f, 65, 'compile', ['-o', output]).stderr, message);
  assert.equal(existsSync(output), false, 'rejected modules must not produce a partial artifact');
  return f;
}
function program(files, value = 42, settings = config()) {
  const f = fixture(files, settings), output = resolve(f.directory, 'program.lbc');
  source(f);
  source(f, value, 'run');
  source(f, 0, 'compile', ['-o', output]);
  command(0, ['check', output]); command(value, ['run', output]);
  const original = source(f, 0, 'inspect').stdout;
  assert.equal(command(0, ['inspect', output]).stdout, original);
  source(f, 0, 'check', [], { cwd: '/' });
  const again = resolve(f.directory, 'again.lbc');
  source(f, 0, 'compile', ['-o', again], { cwd: '/' });
  assert.deepEqual(readFileSync(output), readFileSync(again));
  return f;
}
const library = 'module std.math; int hidden(){return 40;} pub int answer(){return hidden()+2;}';
const files = main => ({ 'app/main.l': `module app.main; ${main}`, 'std/math.l': library });
const ioLibrary = readFileSync(resolve('stdlib/io.l'), 'utf8');
const ioFiles = main => ({ 'app/main.l': `module app.main; ${main}`, 'std/io.l': ioLibrary });
async function brokenPipe(args, stream) {
  const child = spawn(compiler, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdio[stream].destroy();
  let diagnostic = '';
  const other = child.stdio[stream === 1 ? 2 : 1];
  other.on('data', bytes => { diagnostic += bytes.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status, signal) => resolve({ status, signal }));
    });
    assert.equal(result.signal, null, 'broken pipes must trap instead of raising SIGPIPE');
    assert.equal(result.status, 70, diagnostic);
    if (stream === 1) assert.match(diagnostic, /VM trap: output write failure/);
    ++checks;
  } finally { clearTimeout(timer); }
}

try {
  // Explicit imports expose only the four declared stream intrinsics; bytes are never text-decoded.
  const ioBytes = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
  for (const [imports, read, write, text, error] of [
    ['import std.io;', 'std::io::read_byte', 'std::io::write_byte', 'std::io::write_string', 'std::io::write_error'],
    ['import std.io as io;', 'io::read_byte', 'io::write_byte', 'io::write_string', 'io::write_error'],
    ['import std.io::{read_byte as r,write_byte as w,write_string as s,write_error as e};', 'r', 'w', 's', 'e'],
  ]) {
    const f = fixture(ioFiles(`${imports} int main(){${text}("\\0\\xff");${error}("\\xff\\0");
      ${text}("");${error}("");int count=0;
      for(;;){int value=${read}();if(value==-1)break;${write}(byte(value));count++;}
      if(${read}()!=-1||${read}()!=-1)return 1;return count%256;}`));
    const output = resolve(f.directory, 'io.lbc'), again = resolve(f.directory, 'again.lbc');
    source(f); source(f, 0, 'compile', ['-o', output]);
    const ir = source(f, 0, 'inspect').stdout;
    assert.equal(command(0, ['inspect', output]).stdout, ir);
    for (const name of ['read_byte', 'write_byte', 'write_string', 'write_error']) assert.ok(ir.includes(`io.${name}`));
    for (const input of [Buffer.alloc(0), ioBytes, Buffer.from([0, 255, 128, 10, 13, 42])]) {
      for (const args of [['run', f.input, '--manifest', f.manifest], ['run', output]]) {
        const result = command(input.length % 256, args, { encoding: null, input, cwd: '/' });
        assert.deepEqual(result.stdout, Buffer.concat([Buffer.from([0, 255]), input]));
        assert.deepEqual(result.stderr, Buffer.from([255, 0]));
      }
    }
    source(f, 0, 'compile', ['-o', again], { cwd: '/' });
    assert.deepEqual(readFileSync(output), readFileSync(again));
  }
  program(ioFiles('import std.io;int main(){return 42;}'));
  program({ ...ioFiles('import std.io;int main(){return std::io::read_byte();}'),
    'std/io.l': 'module std.io;pub int read_byte(){return 42;}' }); // Names alone are not magic.
  program({ ...ioFiles('import std.io;int main(){return 42;}'), 'std/io.l':
    'module std.io;pub using B=byte;pub using S=string;pub using I=int;'
      + 'pub extern I read_byte();pub extern void write_byte(const B b);'
      + 'pub extern void write_string(S s);pub extern void write_error(S s);' });
  rejected(ioFiles('int main(){return std::io::read_byte();}'), /unknown/);
  rejected(ioFiles('import std.io;int main(){return read_byte();}'), /unknown/);
  rejected(ioFiles('import std.io::{println};int main(){return 0;}'), /unknown/);
  rejected(ioFiles('import std.io;int main(){std::io::write_byte(256);return 0;}'), /no matching/);
  for (const declaration of [
    'pub extern int other();', 'pub extern int reed_byte();', 'pub extern void wrong_byte(byte b);',
    'pub extern void wrong_string(string s);', 'pub extern void wrong_error(string s);',
    'pub extern void read_byte();', 'pub extern int read_byte(int n);', 'pub extern int read_byte(int a,int b);',
    'pub extern int write_byte(byte b);', 'pub extern void write_byte();', 'pub extern void write_byte(int b);',
    'pub extern void write_string(byte b);', 'pub extern void write_error(byte b);',
    'pub extern void write_string(string a,string b);',
  ]) {
    const f = rejected({ ...ioFiles('import std.io;int main(){return 0;}'),
      'std/io.l': `module std.io;\n${declaration}` }, /unsupported std.io intrinsic/);
    assert.match(source(f, 65).stderr, /std\/io.l:2:/);
  }
  for (const [declaration, message] of [
    ['extern int read_byte();', /must be public/],
    ['namespace n{pub extern int read_byte();}', /must not be declared in namespaces/],
    ['pub extern int read_byte(){}', /expected ';' after extern/],
    ['pub extern int read_byte()', /expected ';' after extern/],
    ['pub extern int read_byte();pub extern int read_byte();', /duplicate function/],
    ['pub extern void write_byte(byte b[1]);', /arrays are not supported as parameters/],
  ]) rejected({ ...ioFiles('import std.io;int main(){return 0;}'), 'std/io.l': `module std.io;${declaration}` }, message);
  rejected({ 'app/main.l': 'module app.main;pub extern int read_byte();int main(){return 0;}' }, /only supported in module std.io/);
  for (const declaration of ['pub extern int main();', 'extern pub int read_byte();',
    'extern static int n=0;', 'extern const int n=0;', 'extern int n;',
    'int main(){extern int read_byte();return 0;}', 'int extern(){return 0;}']) {
    rejected({ 'app/main.l': `module app.main;${declaration}` }, /error:/);
  }
  for (const stream of [1, 2]) {
    const name = stream === 1 ? 'write_string' : 'write_error';
    const f = fixture(ioFiles(`import std.io;int main(){for(int n=0;n<256;n++)std::io::${name}("${'x'.repeat(1024)}");return 0;}`));
    const output = resolve(f.directory, 'pipe.lbc'); source(f, 0, 'compile', ['-o', output]);
    await brokenPipe(['run', f.input, '--manifest', f.manifest], stream);
    await brokenPipe(['run', output], stream);
  }
  const demo = resolve('examples/io_demo.l'), demoManifest = resolve('examples/package.json');
  const demoResult = command(0, ['run', demo, '--manifest', demoManifest], { encoding: null, input: ioBytes });
  assert.deepEqual(demoResult.stdout, Buffer.concat([Buffer.from('Echo: '), ioBytes]));
  assert.deepEqual(demoResult.stderr, Buffer.from('Input copied.\n'));
  program(files('import std.math; int main(){return std::math::answer();}'));
  program({ 'app/main.l': '// Leading comments are not declarations.\nmodule app.main;int main(){return 42;}' });
  program(files('import std.math as m; int main(){return m::answer();}'));
  program(files('import std.math::{answer}; int main(){return answer();}'));
  program(files('import std.math::{answer as value,}; int main(){return value();}'));
  program(files('import std.math::{answer as a,answer as b}; int main(){return a()+b()-42;}'));
  program(files('import std.math::{answer}; int answer(){return 21;} int main(){return answer()*2;}'));
  program(files('import std.math::{answer}; int main(){int answer=42;return answer;}'));
  program(files('import std.math::{answer}; int twice(int answer){return answer*2;} int main(){return twice(21);}'));
  program(files('import std.math as m; int main(){int m=42;return m;}'));
  program(files('import std.math; import std.math; int main(){return std::math::answer();}'));
  program(files('import std.math as a; import std.math as b; int main(){return a::answer()+b::answer()-42;}'));
  program({ ...files('import std.math; int main(){return std::math::answer();}'),
    'std/math.l': `${library} int main(){return 7;}` });
  program({ ...files('import std.math;int main(){return std::math::main(21);}'),
    'std/math.l': 'module std.math;pub int main(int n){return n*2;}' });
  program({ ...files('import std.math;int main(){return 42;}'),
    'std/math.l': 'module std.math;int never_called(){return 1/0;}' });
  // Compilation must never truncate any reachable source or the manifest through an output alias.
  const protectedProject = { ...files('import app.bridge;int main(){return app::bridge::answer();}'),
    'app/bridge.l': 'module app.bridge;import std.math;pub int answer(){return std::math::answer();}' };
  for (const name of ['app/main.l', 'app/bridge.l', 'std/math.l', 'manifest']) {
    for (const alias of ['dot', 'parent', 'symlink', 'hardlink', 'directory', 'identical']) {
      const f = fixture(protectedProject), target = name === 'manifest' ? f.manifest : resolve(f.directory, 'src', name);
      const inputs = [f.manifest, ...Object.keys(protectedProject).map(path => resolve(f.directory, 'src', path))];
      const originals = inputs.map(path => readFileSync(path));
      let output = target;
      if (alias === 'dot') output = `${dirname(target)}/./${basename(target)}`;
      else if (alias === 'parent') output = `${dirname(target)}/../${basename(dirname(target))}/${basename(target)}`;
      else if (alias === 'symlink' || alias === 'hardlink') {
        output = resolve(f.directory, 'alias.lbc');
        if (alias === 'symlink') symlinkSync(target, output); else linkSync(target, output);
      } else if (alias === 'directory') {
        const directory = resolve(f.directory, 'alias'); symlinkSync(dirname(target), directory);
        output = resolve(directory, basename(target));
      }
      assert.match(source(f, 64, 'compile', ['-o', output], { cwd: '/' }).stderr,
        /output would overwrite compiler input|input and output must be different/);
      for (let n = 0; n < inputs.length; ++n) assert.deepEqual(readFileSync(inputs[n]), originals[n], `${name}: ${alias} changed an input`);
      source(f, 42, 'run');
    }
  }
  const outputLoop = fixture(), loopOutput = resolve(outputLoop.directory, 'loop.lbc');
  symlinkSync('loop.lbc', loopOutput);
  assert.match(source(outputLoop, 74, 'compile', ['-o', loopOutput]).stderr, /cannot inspect bytecode output/);
  source(outputLoop, 42, 'run');
  const noEntry = rejected({ 'app/main.l': 'module app.main;import std.math;',
    'std/math.l': 'module std.math;int main(){return 42;}' }, /missing entry point/);
  assert.ok(source(noEntry, 65).stderr.includes('/app/main.l:'));
  program({ ...files('import std.math; int main(){return std::math::numbers::answer(true);}'),
    'std/math.l': 'module std.math; namespace numbers{pub int answer(int n){return n*2;}} namespace numbers{pub int answer(bool active){if(active)return answer(21);return 0;}}' });
  program({ ...files('import std.math::{numbers::answer}; int main(){return answer(21);}'),
    'std/math.l': 'module std.math; namespace numbers{pub int answer(int n){return n*2;}}' });
  program({ ...files('import std.math as m; int main(){m::nop();return 42;}'),
    'std/math.l': 'module std.math;pub void nop(){return;}' });
  const reproducible = files('import std.math;int main(){return std::math::answer();}');
  const first = program(reproducible), reordered = config(); reordered.module_roots.reverse();
  const relocated = fixture(reproducible, reordered), relocatedOutput = resolve(relocated.directory, 'relocated.lbc');
  source(relocated, 0, 'compile', ['-o', relocatedOutput], { cwd: '/' });
  assert.deepEqual(readFileSync(resolve(first.directory, 'program.lbc')), readFileSync(relocatedOutput));
  const typing = rejected({ ...files('import std.math;int main(){return std::math::answer();}'),
    'std/math.l': 'module std.math;pub int answer(){return true;}' }, /expected int, got bool/);
  assert.ok(source(typing, 65).stderr.includes('/std/math.l:'));
  const initialization = rejected({ ...files('import std.math;int main(){return std::math::answer();}'),
    'std/math.l': 'module std.math;pub int answer(){switch(2){case 1:int n=42;case 2:return n;default:return 0;}}' }, /slot is uninitialized/);
  assert.ok(source(initialization, 65).stderr.includes('/std/math.l:'));
  const trapping = fixture({ ...files('import std.math;int main(){return std::math::answer();}'),
    'std/math.l': 'module std.math;pub int answer(){return 1/0;}' });
  assert.ok(source(trapping, 70, 'run').stderr.includes('/std/math.l:'));
  program({ 'app/main.l': 'module app.main;int f(int a){return a*2;}int f(bool a){if(a)return 42;return 0;}int main(){return f(true)+f(21)-42;}' });
  program({ 'app/main.l': 'module app.main;int answer(){return 42;}namespace outer{int twice(int n){return n*2;}namespace inner{int f(){return twice(21)+answer()-42;}}}int main(){return outer::inner::f();}' });
  program({ 'app/main.l': 'module app.main;namespace outer{namespace child{int f(){return 42;}}namespace inner{int g(){return child::f();}}}int main(){return outer::inner::g();}' });
  program({ 'app/main.l': 'module app.main;namespace n{int f(){return g();}}namespace n{int g(){return 42;}}int main(){return n::f();}' });
  program({ 'app/main.l': 'module app.main;int f(){return 1;}namespace n{int f(){return 42;}int g(){return f();}}int main(){return n::g();}' });
  program({ ...files('import std.math;import std.Math;int main(){return std::math::answer()+std::Math::answer();}'),
    'std/math.l': 'module std.math;pub int answer(){return 20;}', 'std/Math.l': 'module std.Math;pub int answer(){return 22;}' });
  const empty = config(); empty.module_roots.unshift({ package: 'application', prefix: '', path: 'src' });
  program(files('import std.math;int main(){return std::math::answer();}'), 42, empty);
  const longest = config();
  longest.module_roots.push({ package: 'application', prefix: 'std', path: 'src/app' },
    { package: 'stdlib', prefix: 'std.deep', path: 'src/std/deep' });
  program({ 'app/main.l': 'module app.main;import std.deep.math;int main(){return std::deep::math::answer();}',
    'std/deep/math.l': 'module std.deep.math;pub int answer(){return 42;}' }, 42, longest);
  const prefixed = config(); prefixed.module_roots.unshift({ package: 'application', prefix: 'std.math.extra', path: 'src/app' });
  program(files('import std.math;int main(){return std::math::answer();}'), 42, prefixed);
  const boundary = config(); boundary.module_roots.unshift({ package: 'application', prefix: 'st', path: 'src/app' });
  program(files('import std.math;int main(){return std::math::answer();}'), 42, boundary);
  const weaker = config(); weaker.module_roots.push({ package: 'application', prefix: '', path: 'src' });
  program(files('import std.math;int main(){return std::math::answer();}'), 42, weaker);
  const whole = config(); whole.module_roots[0] = { package: 'application', prefix: '', path: 'src' };
  program(files('import std.math;int main(){return std::math::answer();}'), 42, whole);
  const single = fixture({ 'main.l': 'module main;int main(){return 42;}' }, whole);
  single.input = resolve(single.directory, 'src/main.l'); source(single, 42, 'run');
  for (const order of [false, true]) {
    const imports = ['import std.math;', 'import std.math.child;'];
    if (order) imports.reverse();
    program({ 'app/main.l': `module app.main;${imports.join('')}int main(){return std::math::child::answer();}`,
      'std/math.l': 'module std.math;namespace child{pub int answer(){return 1;}}',
      'std/math/child.l': 'module std.math.child;pub int answer(){return 42;}' });
  }

  for (const [body, message] of [
    ['int main(){return 0;}', /exactly one module/],
    ['module app.main;module app.main;int main(){return 0;}', /must precede/],
    ['module app.main;int main(){return 0;}import std.math;', /must precede/],
    ['module app.main;namespace n{import std.math;}int main(){return 0;}', /must precede/],
    ['module app.main;pub namespace n{}int main(){return 0;}', /do not change/],
    ['module app.main;namespace {}', /namespace name/],
    ['module app.main;namespace n int main(){return 0;}', /after namespace/],
    ['module app.main;namespace n{', /after namespace/],
    ['module app.main;}', /unexpected.*module scope/],
    ['module app.main;import std.math::*;int main(){return 0;}', /wildcard/],
    ['module app.main;import std.math::{};int main(){return 0;}', /identifier/],
    ['module app.main;import std.math as;', /module alias/],
    ['module app.main;import std.math::{answer as};', /selective import alias/],
    ['module app.main;import std.math::{answer;', /after selective/],
    ['module app.main;import std.math int main(){return 0;}', /after import/],
    ['module app.main;int main(){return std::();}', /after name separator/],
    ['module app..main;int main(){return 0;}', /after name separator/],
    ['module app.main int main(){return 0;}', /after module declaration/],
  ]) rejected({ 'app/main.l': body, 'std/math.l': library }, message);
  for (const [body, message] of [
    ['import std.math;int main(){return answer();}', /unknown function/],
    ['import std.math;int main(){return std::math::hidden();}', /inaccessible symbol/],
    ['import std.math::{hidden};int main(){return 0;}', /requires pub/],
    ['import std.math::{missing};int main(){return 0;}', /unknown selectively/],
    ['import std.math as main;int main(){return 0;}', /alias conflicts/],
    ['import std.math as n;namespace n{}int main(){return 0;}', /alias conflicts/],
    ['import std.math as m;import std.math as m;int main(){return 0;}', /conflicting module aliases/],
    ['import std.math as m;import std.math::{answer as m};int main(){return 0;}', /alias conflicts/],
    ['import std.math::{answer};import std.math::{answer};int main(){return 0;}', /ambiguous selective/],
    ['import std.math::{answer,answer};int main(){return 0;}', /ambiguous selective/],
    ['import std.math as m;int main(){int m=0;return m::answer();}', /local binding/],
    ['import std.math::{answer};int main(){int answer=0;return answer();}', /local binding/],
    ['int answer(){return 42;}int main(){return missing::answer();}', /no unqualified fallback/],
    ['import std.math;int main(){return std::mathx::answer();}', /no unqualified fallback/],
    ['namespace n{}int answer(){return 42;}int main(){return n::answer();}', /unknown function or qualified/],
    ['int answer(){return 42;}namespace n{int answer(bool b){return 0;}int g(){return answer();}}int main(){return n::g();}', /no matching function overload/],
    ['namespace n{}int n(){return 0;}int main(){return 0;}', /conflicts with namespace/],
    ['int f(int n){return n;}bool f(int n){return true;}int main(){return 0;}', /duplicate function signature/],
    ['namespace n{int f(){return 1;}}namespace n{int f(){return 2;}}int main(){return 0;}', /duplicate function signature/],
    ['namespace n{int main(){return 42;}}', /missing entry point/],
    ['pub import std.math;int main(){return 0;}', /must precede/],
  ]) rejected(files(body), message);
  rejected({ ...files('import std.math;int main(){return std::math::answer(1);}'),
    'std/math.l': 'module std.math;int answer(int n){return n;}pub int answer(bool b){return 0;}' }, /inaccessible symbol/);
  rejected({ ...files('import std.math;int main(){return std::math::answer();}'),
    'std/math.l': 'module std.math;int answer(int n){return n;}pub int answer(bool b){return 0;}' }, /no matching function overload/);
  rejected({ ...files('import std.math;int main(){return std::math::answer();}'),
    'std/math.l': 'module std.math;int answer(int n){return n;}' }, /inaccessible symbol/);
  rejected({ ...files('import std.math;int main(){return std::math::answer(1);}'),
    'std/math.l': 'module std.math;int answer(int n){return n;}int answer(bool b){return 0;}int answer(int a,int b){return 0;}' }, /inaccessible symbol/);
  rejected({ 'app/main.l': 'module app.main;import app.bridge;int main(){return app::bridge::answer();}',
    'app/bridge.l': 'module app.bridge;import std.math::{answer};', 'std/math.l': library }, /unknown function or qualified/);
  rejected(files('import missing.math;int main(){return 0;}'), /no registered module prefix/);
  rejected(files('import std.missing;int main(){return 0;}'), /module not found/);
  rejected(files('import std.Math;int main(){return 0;}'), /module not found/);
  rejected(files('import std;int main(){return 0;}'), /no implicit index/);
  rejected({ ...files('import std.math;int main(){return 0;}'), 'std/math.l': 'module std.wrong;' }, /invalid module declaration/);
  rejected({ 'app/main.l': 'module app.main;import app.other;int main(){return 0;}',
    'app/other.l': 'module app.main;' }, /duplicate module definition/);
  rejected({ 'app/main.l': 'module app.wrong;int main(){return 0;}' }, /invalid module declaration/);
  const ambiguous = config(); ambiguous.module_roots.push({ package: 'application', prefix: 'std', path: 'src/app' });
  rejected(files('import std.math;int main(){return 0;}'), /ambiguous module resolution/, ambiguous);
  const noDependency = config(); noDependency.dependencies = [];
  rejected(files('import std.math;int main(){return 0;}'), /has not declared this dependency/, noDependency);
  const transitive = config(); transitive.module_roots.push({ package: 'bridge', prefix: 'bridge', path: 'src/std' });
  transitive.dependencies = [{ from: 'application', to: 'bridge' }, { from: 'bridge', to: 'stdlib' }];
  rejected(files('import std.math;int main(){return 0;}'), /has not declared this dependency/, transitive);
  const wrongEntry = config(); wrongEntry.package = 'stdlib';
  rejected({}, /entry is not in the configured package/, wrongEntry);
  const notDirectory = config(); notDirectory.module_roots[1].path = 'src/std/math.l';
  rejected(files('import std.other;int main(){return 0;}'), /module not found/, notDirectory);
  const loop = fixture(files('import std.loop;int main(){return 0;}'));
  symlinkSync('loop.l', resolve(loop.directory, 'src/std/loop.l'));
  assert.match(source(loop, 65).stderr, /inaccessible module/);
  const link = fixture(files('import std.link;int main(){return 0;}'));
  put(resolve(link.directory, 'external.l'), 'module std.link;pub int f(){return 0;}');
  symlinkSync(resolve(link.directory, 'external.l'), resolve(link.directory, 'src/std/link.l'));
  assert.match(source(link, 65).stderr, /not canonical/);
  for (const [project, cycle, settings] of [
    [{ 'app/main.l': 'module app.main;import app.main;int main(){return 0;}' }, 'app.main -> app.main', config()],
    [{ 'app/main.l': 'module app.main;import app.a;int main(){return 0;}', 'app/a.l': 'module app.a;import app.b;', 'app/b.l': 'module app.b;import app.a;' }, 'app.a -> app.b -> app.a', config()],
    [{ 'app/main.l': 'module app.main;import app.a;int main(){return 0;}', 'app/a.l': 'module app.a;import app.b;', 'app/b.l': 'module app.b;import app.c;', 'app/c.l': 'module app.c;import app.a;' }, 'app.a -> app.b -> app.c -> app.a', config()],
    [{ 'app/main.l': 'module app.main;import std.math;int main(){return true;}', 'std/math.l': 'module std.math;import app.main;' }, 'app.main -> std.math -> app.main', { ...config(), dependencies: [...config().dependencies, { from: 'stdlib', to: 'application' }] }],
  ]) {
    const f = rejected(project, /Module dependency cycle detected/, settings);
    assert.ok(source(f, 65).stderr.includes(cycle));
  }

  // Fixed-seed generated DAGs exercise shared dependencies and every import form.
  let state = 0x4d4f4455;
  const random = bound => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % bound; };
  for (let test = 0; test < 32; ++test) {
    const project = {}, values = [];
    for (let n = 0; n < 8; ++n) {
      let text = `module app.n${n};`, body = '', value = 1 + random(10);
      const delta = value;
      for (let p = 0; p < n; ++p) if (random(3) === 0) {
        const kind = random(3);
        if (!kind) { text += `import app.n${p};`; body += `+app::n${p}::value()`; }
        else if (kind === 1) { text += `import app.n${p} as m${p};`; body += `+m${p}::value()`; }
        else { text += `import app.n${p}::{value as v${p}};`; body += `+v${p}()`; }
        value += values[p];
      }
      project[`app/n${n}.l`] = `${text}int hidden(){return ${delta};}pub int value(){return hidden()${body};}`;
      values.push(value);
    }
    project['app/main.l'] = `module app.main;import app.n7;int main(){if(app::n7::value()==${values[7]})return 42;return 1;}`;
    program(project);
  }
  const maximum = {};
  for (let n = 0; n < 255; ++n) maximum[`app/n${n}.l`] = `module app.n${n};${n ? `import app.n${n - 1};` : ''}pub int value(){return ${n ? `app::n${n - 1}::value()` : '42'};}`;
  maximum['app/main.l'] = 'module app.main;import app.n254;int main(){return app::n254::value();}';
  program(maximum);
  const excessive = { 'app/main.l': `module app.main;${Array.from({ length: 256 }, (_, n) => `import app.n${n};`).join('')}int main(){return 0;}` };
  for (let n = 0; n < 256; ++n) excessive[`app/n${n}.l`] = `module app.n${n};`;
  rejected(excessive, /too many source modules/);
  rejected({ 'app/main.l': `module app.main;${'import std.math;'.repeat(1025)}int main(){return 0;}` }, /too many imports/);
  rejected(files(`int f(){return 0;}int main(){return f(${Array(1025).fill('0').join(',')});}`), /too many function arguments/);
  rejected({ 'app/main.l': `module app.main;${'namespace n{'.repeat(257)}${'}'.repeat(257)}int main(){return 0;}` }, /nesting limit/);
  rejected({ 'app/main.l': 'module app.main;import app.a;import app.b;int main(){return 0;}',
    'app/a.l': `module app.a;${Array.from({ length: 128 }, (_, n) => `int f${n}(){return 0;}`).join('')}`,
    'app/b.l': `module app.b;${Array.from({ length: 128 }, (_, n) => `int f${n}(){return 0;}`).join('')}` }, /too many functions across modules/);

  // Strings are immutable binary values, including empty strings and embedded NULs.
  const stringProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const literal = bytes => `"${Array.from(bytes, n => `\\x${n.toString(16).padStart(2, '0')}`).join('')}"`;
  const stringFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/text.l': String.raw`module std.text;using Internal=string;pub using Text=Internal;
      pub const Text first=later;const string later="A\0\xff";pub static Text current=first;
      pub struct P{Text text;int length;};pub Text swap(Text value){Text old=current;current=value;return old;}` });
  for (const body of [
    'int main(){string s="*";return int(s[0]);}',
    'int main(){auto s="*";const string copy=s;s="";return int(copy[0])+s.length;}',
    'string id(const string s){return s;}int main(){return int(id("*")[0]);}',
    'string walk(string s,int n){if(n==0)return s;return walk(s,n-1);}int main(){return int(walk("*",20)[0]);}',
    'using Text=string;using Value=Text;int main(){Value s="*";Text t=s;return int(t[0]);}',
    'const int length=text.length;const byte b=text[length-1];const string text=next;const string next="a*";int main(){return int(b);}',
    'const string empty="";static string state=empty;int main(){if(state!="")return 1;state="*";return int(state[0]);}',
    'int main(){if(""==""&&"a"!=""&&"a"!="b"&&"a"=="a")return 42;return 1;}',
    String.raw`const bool a="a\0x"=="\x61\x00x";const bool b="a\0x"!="a\0y";const bool c="a"!="a\0";int main(){if(a&&b&&c)return 42;return 1;}`,
    String.raw`int main(){string s="\n\r\t\0\\\"\xaF\xFA";if(s.length!=8)return 1;if(int(s[0])!=10||int(s[1])!=13||int(s[2])!=9||int(s[3])!=0||int(s[4])!=92||int(s[5])!=34||int(s[6])!=175||int(s[7])!=250)return 1;return 42;}`,
    String.raw`int main(){string s="\x001\01";if(s.length==4&&s[0]==byte(0)&&s[1]==byte(49)&&s[2]==byte(0)&&s[3]==byte(49))return 42;return 1;}`,
    'int main(){if(" // /* */ ~ ".length==12)return 42;return 1;}',
    'const bool a=false&&(""[0]==byte(0));const bool b=true||("x"[-1]==byte(0));int main(){if(!a&&b)return 42;return 1;}',
    'int main(){if(false&&(""[0]==byte(0)))return 1;if(true||("x"[-1]==byte(0)))return 42;return 1;}',
    'const string s="abc";enum E{N=s.length};int main(){byte a[s.length];a[2]="*"[0];switch(E::N){case E::N:return int(a[2]);default:return 1;}}',
    'const string s="*";int main(){switch(s[0]){case "*"[0]:return 42;default:return 1;}}',
    'int main(){switch(3){case "abc".length:return 42;default:return 1;}}',
    'struct P{string text;int length;};P change(P p){p.text="*";p.length=0;return p;}int main(){P p=P{"keep",42};P q=change(p);if(p.text!="keep"||p.length!=42||q.length!=0)return 1;return int(q.text[0]);}',
    'struct P{string s;};int main(){P p=P{"*"};string old=p.s;p.s="";return int(old[0])+p.s.length;}',
    'struct P{string s;};int main(){return int(P{"*"}.s[0]);}',
    'int f(string s){return 20;}int f(byte b){return 22;}int main(){return f("*")+f("*"[0]);}',
    'void change(string s){s="";}int main(){string s="*";change(s);return int(s[0]);}',
    'int main(){string s="abc";int n=0;byte b=s[n++];if(n==1&&b==byte(97))return 42;return 1;}',
    'static int n=0;string next(){n++;return "*";}int main(){int a=next().length;byte b=next()[0];return int(b)+a+n-3;}',
    'static string s="*";int index(){s="";return 0;}int main(){byte b=s[index()];return int(b)+s.length;}',
    'static string s="x";string next(){s="*";return s;}int index(){if(s=="*")return 0;return 1;}int main(){return int(next()[index()]);}',
    'int pair(string a,string b){if(a=="a"&&b=="*")return 42;return 1;}int main(){string s="a";return pair(s,s="*");}',
    'int main(){string s="a";if(s==(s="b"))return 1;if(s=="b")return 42;return 1;}',
    'int main(){string s="a";if(false&&((s="b")=="b"))return 1;if(true||((s="c")=="c")){}if(s=="a")return 42;return 1;}',
    'const string s="*";int main(){string s="x";{string s="*";if(s!="*")return 1;}if(s=="x")return 42;return 1;}',
    'int main(){"";for(string s="*";s.length>0;s=""){return int(s[0]);}return 1;}',
  ]) stringProgram(body);
  for (const [imports, type, first] of [
    ['import std.text;', 'std::text::Text', 'std::text::first'],
    ['import std.text as t;', 't::Text', 't::first'],
    ['import std.text::{Text as T,first};', 'T', 'first'],
  ]) program(stringFiles(`${imports}const int n=${first}.length;int main(){${type} s=${first};if(n==3&&int(s[1])==0&&int(s[2])==255)return 42;return 1;}`));
  const stringInspection = program(stringFiles('import std.text::{P,swap,current};int main(){P p=P{swap("*"),42};if(p.text.length==3&&current=="*")return int(current[0]);return 1;}'));
  const stringIR = source(stringInspection, 0, 'inspect').stdout;
  assert.match(stringIR, /LIR 1\.8; bytecode 1\.8/); assert.match(stringIR, /string\.length/); assert.match(stringIR, /string\.index/);
  assert.match(stringIR, /string k0 length=3 hex=4100ff/); assert.match(stringIR, /field 0 text: string/);
  assert.equal(readFileSync(resolve(stringInspection.directory, 'program.lbc')).readUInt32LE(28), 2);
  const octets = literal(Array.from({ length: 256 }, (_, n) => n));
  stringProgram(`const string all=${octets};int main(){if(all.length!=256)return 1;for(int n=0;n<256;n++){if(int(all[n])!=n)return 1;}return 42;}`);
  const printable = Array.from({ length: 95 }, (_, n) => String.fromCharCode(n + 32)).join('').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  stringProgram(`int main(){string s="${printable}";for(int n=0;n<s.length;n++){if(int(s[n])!=n+32)return 1;}return 42;}`);
  for (const [body, message] of [
    ['int main(){string s=42;return 42;}', /expected string, got int/],
    ['int main(){int s="*";return 42;}', /expected int, got string/],
    ['int main(){byte s="*";return 42;}', /expected byte, got string/],
    ['int main(){return "*";}', /expected int, got string/],
    ['int main(){string s;return 42;}', /require an initializer/],
    ['int main(){return int("*");}', /expected byte, got string/],
    ['int main(){return int(byte("*"));}', /expected int, got string/],
    ['int main(){string s=string("*");return 42;}', /expected expression/],
    ['using Text=string;int main(){Text s=Text("*");return 42;}', /type alias is not callable/],
    ['int main(){string s="a"+"b";return 42;}', /expected int, got string/],
    ['int main(){if("a"<"b")return 42;return 1;}', /expected int, got string/],
    ['int main(){if("a"==byte(97))return 42;return 1;}', /matching scalar types/],
    ['int main(){if("")return 42;return 1;}', /expected bool, got string/],
    ['int main(){string s="a";s++;return 42;}', /expected int, got string/],
    ['int main(){string s[1];return 42;}', /array element type/],
    ['using Text=string;int main(){Text s[1];return 42;}', /array element type/],
    ['int main(){switch("*"){default:return 42;}}', /switch selector/],
    ['int main(){return "a".size;}', /only a length property/],
    ['int main(){return "a".lengtx;}', /only a length property/],
    ['int main(){return "a".length();}', /direct function calls/],
    ['int main(){return int("*"[true]);}', /expected int, got bool/],
    ['int main(){return int("*"[byte(0)]);}', /expected int, got byte/],
    ['int main(){return int("*"[0][0]);}', /expected string, got byte/],
    ['int main(){const string s="*";s="x";return 42;}', /cannot modify const/],
    ['const string s="*";int main(){s="x";return 42;}', /cannot modify module constant/],
    ['int main(){string s="*";s[0]=byte(0);return 42;}', /not an array/],
    ['int main(){string s="*";s[0]++;return 42;}', /not an array/],
    ['int main(){"*"[0]=byte(0);return 42;}', /indexed through a variable/],
    ['int main(){string s="*";s.length=0;return 42;}', /requires a struct value/],
    ['struct P{string s;};int main(){const P p=P{"*"};p.s="";return 42;}', /cannot modify const/],
    ['struct P{string s;};int main(){P p=P{"*"};p.s[0]=byte(0);return 42;}', /indexed through a variable/],
    ['static string s="*";const int n=s.length;int main(){return 42;}', /mutable static/],
    ['static string s="*";const byte b=s[0];int main(){return 42;}', /mutable static/],
    ['const string s=t;const string t=s;int main(){return 42;}', /constant dependency cycle/],
    ['const string s="*";int main(){const string s="x";int a[s.length];return 42;}', /local binding is not a compile-time/],
    ['const string s="*";int f(string s){int a[s.length];return 42;}int main(){return 42;}', /local binding is not a compile-time/],
    ['string text(){return "*";}const int n=text().length;int main(){return 42;}', /function call/],
    ['const bool b=true||(missing.length==0);int main(){return 42;}', /unknown local/],
    ['const bool b=true||("*"[false]==byte(0));int main(){return 42;}', /expected int, got bool/],
    ['static string s="*";const bool b=true||(s[0]==byte(0));int main(){return 42;}', /mutable static/],
    ['const string s="*";const bool b=true||((s="")=="");int main(){return 42;}', /assignment is not/],
    ['int main(){switch(byte(42)){case "*"[0]:return 42;case byte(42):return 1;default:return 0;}}', /duplicate case value/],
    ['string main(){return "*";}', /entry point/],
    ['using Text=string;int f(Text s){return 42;}int f(string s){return 1;}int main(){return 42;}', /duplicate function signature/],
    ['int main(){int string=42;return 42;}', /variable name/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const body of ['import std.text;int main(){return std::text::later.length;}',
    'import std.text::{later};int main(){return 42;}',
    'import std.text as t;int main(){t::Internal s="*";return 42;}']) rejected(stringFiles(body), /inaccessible symbol/);
  for (const text of ['', '*']) for (const index of [-2147483648, -1, text.length, 2147483647]) {
    for (const kind of ['const', 'static']) rejected({ 'app/main.l': `module app.main;${kind} byte b="${text}"[${index}];int main(){return 42;}` }, /string index out of bounds/);
    const f = fixture({ 'app/main.l': `module app.main;int read(string s,int n){const byte b=s[n];return int(b);}int main(){return read("${text}",${index});}` });
    const output = resolve(f.directory, 'trap.lbc');
    assert.match(source(f, 70, 'run').stderr, /string index out of bounds/);
    source(f, 0, 'compile', ['-o', output]); assert.match(command(70, ['run', output]).stderr, /string index out of bounds/);
  }
  for (const [text, message] of [
    ['"', /unterminated string literal/], ['"abc', /unterminated string literal/], ['"\\', /unterminated string escape/],
    ['"\\x', /two hexadecimal digits/], ['"\\x0', /two hexadecimal digits/], ['"\\x0"', /two hexadecimal digits/],
    ['"\\xg0"', /two hexadecimal digits/], ['"\\x0G"', /two hexadecimal digits/], ['"\\x/0"', /two hexadecimal digits/],
    ['"\\u0041"', /unsupported string escape/], ['"\\a"', /unsupported string escape/],
    ['"\n"', /printable ASCII/], ['"\r"', /printable ASCII/], ['"\t"', /printable ASCII/],
    ['"\0"', /printable ASCII/], ['"\x7f"', /printable ASCII/], ['"é"', /printable ASCII/],
    [`"${'a'.repeat(65536)}"`, /exceeds 65535 bytes/],
  ]) rejected({ 'app/main.l': `module app.main;int main(){string s=${text}` }, message);
  const columnPrefix = String.raw`module app.main;int main(){"\x00\n\"";return `;
  const columns = rejected({ 'app/main.l': `${columnPrefix}missing;}` }, /unknown local/);
  assert.ok(source(columns, 65).stderr.includes(`:1:${columnPrefix.length + 1}:`));
  function stringLimit(body, count) {
    const f = fixture({ 'app/main.l': `module app.main;int main(){${body}return 42;}` }), output = resolve(f.directory, 'limit.lbc');
    source(f); source(f, 42, 'run'); source(f, 0, 'compile', ['-o', output]); command(42, ['run', output]);
    assert.equal(readFileSync(output).readUInt32LE(28), count);
  }
  const distinct = Array.from({ length: 1024 }, (_, n) => `"${n}";`).join('');
  stringLimit(`${distinct}"0";`, 1024);
  rejected({ 'app/main.l': `module app.main;int main(){${distinct}"extra";return 42;}` }, /too many distinct strings/);
  stringLimit(`if("${'\\x41'.repeat(65535)}".length!=65535)return 1;`, 1);
  const fullPool = Array.from({ length: 16 }, (_, n) => `"${String.fromCharCode(65 + n).repeat(65535)}";`).join('');
  stringLimit(`${fullPool}"${'z'.repeat(16)}";`, 17);
  rejected({ 'app/main.l': `module app.main;int main(){${fullPool}"${'z'.repeat(17)}";return 42;}` }, /string table exceeds/);
  let stringConstantModels = 0;
  state = 0x53545243;
  for (let batch = 0; batch < 8; ++batch) {
    let declarations = `const string all=${octets};`, comparisons = '';
    for (let n = batch * 32; n < (batch + 1) * 32; ++n) {
      const a = Buffer.from(Array.from({ length: random(13) }, () => random(256)));
      const b = n % 3 ? Buffer.from(a) : Buffer.concat([a, Buffer.from([0])]);
      if (n % 3 === 2 && b.length) b[b.length - 1] ^= 255;
      declarations += `const byte b${n}=all[${n}];const int n${n}=${literal(a)}.length;const bool e${n}=${literal(a)}==${literal(b)};const bool d${n}=${literal(a)}!=${literal(b)};`;
      comparisons += `if(int(b${n})!=${n}||n${n}!=${a.length}||e${n}!=${a.equals(b)}||d${n}!=${!a.equals(b)})return 1;`;
      ++stringConstantModels;
    }
    stringProgram(`${declarations}int main(){${comparisons}return 42;}`);
  }
  state = 0x53545244;
  for (let test = 0; test < 32; ++test) {
    const values = [Buffer.alloc(0), Buffer.from([0]), Buffer.from([255, 0, 42]), Buffer.from('alpha'), Buffer.from('beta')];
    const initial = random(values.length), start = random(values.length), nodes = [];
    const project = { 'std/strings.l': `module std.strings;pub using Text=string;pub static Text cell=${literal(values[initial])};` };
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.s${n}`, next = random(values.length), parents = [], form = (test + n) % 3;
      let imports = form === 0 ? 'import std.strings;' : form === 1 ? 'import std.strings as s;' : 'import std.strings::{Text as T,cell};';
      const type = form === 0 ? 'std::strings::Text' : form === 1 ? 's::Text' : 'T';
      const cell = form === 0 ? 'std::strings::cell' : form === 1 ? 's::cell' : 'cell';
      let body = `if(value==${cell})value=${literal(values[next])};else value=${cell};${cell}=value;`;
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        parents.push(p); imports += `import ${nodes[p].name}::{work::run as f${p}};`; body += `value=f${p}(value);`;
      }
      nodes.push({ name, next, parents });
      project[`${name.replaceAll('.', '/')}.l`] = `module ${name};${imports}namespace work{pub ${type} run(${type} value){${body}return value;}}`;
    }
    let cell = values[initial];
    function simulate(n, value) {
      value = value.equals(cell) ? values[nodes[n].next] : cell; cell = value;
      for (const parent of nodes[n].parents) value = simulate(parent, value);
      return value;
    }
    const a = simulate(7, values[start]), b = simulate(6, values[start]);
    const imports = ['import std.strings::{Text,cell};', 'import app.s7 as top;', 'import app.s6 as next;'];
    if (test % 2) imports.reverse();
    project['app/main.l'] = `module app.main;${imports.join('')}int main(){Text start=${literal(values[start])};Text a=top::work::run(start);Text b=next::work::run(start);`
      + `if(start!=${literal(values[start])}||a!=${literal(a)}||b!=${literal(b)}||cell!=${literal(cell)})return 1;return 42;}`;
    const settings = config(); if (test % 2) settings.module_roots.reverse();
    const f = program(project, 42, settings);
    assert.equal(readFileSync(resolve(f.directory, 'program.lbc')).readUInt32LE(16), 1, 'shared string cell must not be duplicated');
  }

  // Bytes are distinct scalar values; narrowing is checked, widening is explicit.
  const byteProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const byteFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/octets.l': 'module std.octets;using Internal=byte;pub using Octet=Internal;'
      + 'pub const Octet first=byte(base);const int base=41;pub static Octet current=first;'
      + 'pub struct Packet{Octet value;bool ready;};'
      + 'pub Octet swap(Octet value){Octet old=current;current=value;return old;}' });
  byteProgram('int main(){byte b=byte(42);return int(b);}');
  byteProgram('int main(){auto b=byte(42);const byte copy=b;b=byte(0);return int(copy);}');
  byteProgram('byte id(const byte value){return value;}int main(){return int(id(byte(42)));}');
  byteProgram('using Octet=byte;using Value=Octet;int main(){Value b=byte(42);Octet data[2];data[1]=b;return int(data[0])+int(data[1]);}');
  byteProgram('const byte b=byte(base);const int base=21*2;static byte cell=b;int main(){byte old=cell;cell=byte(0);return int(old);}');
  byteProgram('const bool ok=false&&(int(byte(256))==0);const bool yes=true||(int(byte(-1))==0);int main(){if(!ok&&yes)return 42;return 0;}');
  byteProgram('enum K{A=int(byte(42))};const byte size=byte(2);int main(){byte a[int(size)];switch(K::A){case K::A:a[1]=byte(42);break;default:return 1;}return int(a[0])+int(a[1]);}');
  byteProgram('struct P{byte x;byte y;bool ready;};P change(P p){p.x=byte(int(p.x)+2);p.y=byte(0);return p;}int main(){P p=P{byte(40),byte(255),true};P q=change(p);if(p.x!=byte(40)||p.y!=byte(255)||q.y!=byte(0))return 1;return int(q.x);}');
  byteProgram('enum K{A};struct P{byte b;int x;};byte f(byte a,P p,bool b,K k,int n){if(b&&k==K::A)return byte(int(a)+int(p.b)+p.x+n);return byte(0);}int main(){return int(f(byte(10),P{byte(20),5},true,K::A,7));}');
  byteProgram('int f(byte b){return 20;}int f(int n){return 22;}int main(){return f(byte(0))+f(0);}');
  byteProgram('void change(byte b){b=byte(0);return;}int main(){byte b=byte(42);change(b);return int(b);}');
  byteProgram('int main(){byte(42);int(byte(1));for(byte(0);false;int(byte(1))){}return 42;}');
  byteProgram('int main(){int n=40;byte a=byte(n++);byte b=byte(n++);if(n!=42||int(a)!=40||int(b)!=41)return 1;return n;}');
  byteProgram('int pair(byte a,int n,byte b){return int(a)+n+int(b);}int main(){int n=13;return pair(byte(n++),n++,byte(n++));}');
  byteProgram('int main(){int n=0;byte a[3];a[n++]=byte(n++);if(n!=2||a[0]!=byte(1)||a[1]!=byte(0))return 1;return 42;}');
  byteProgram('int main(){int n=0;byte b=byte(0);if(false&&((b=byte(n++))==byte(0)))return 1;if(true||int(byte(n++))>0){}if(n==0&&b==byte(0))return 42;return 1;}');
  byteProgram('const byte a=byte(7);int main(){byte b=a;switch(b){case byte(0):return 0;case a:return 42;default:return 1;}}');
  byteProgram('int main(){int n=0;switch(byte(1)){case byte(0):n=1;case byte(1):n=n+40;case byte(255):n=n+2;break;default:n=0;}return n;}');
  byteProgram('int main(){int sum=0;for(int n=0;n<2;n++){byte a[2];sum=sum+int(a[0]);a[0]=byte(42);}return sum+42;}');
  byteProgram('int main(){const byte a[65535];byte b[1];if(int(a[65534])+int(b[0])==0)return 42;return 1;}');
  byteProgram('pub using Octet=byte;pub struct P{Octet b;};pub const byte initial=byte(42);pub static Octet cell=initial;pub byte id(Octet b){return b;}int main(){P p=P{id(cell)};return int(p.b);}');
  for (const [imports, type, first] of [
    ['import std.octets;', 'std::octets::Octet', 'std::octets::first'],
    ['import std.octets as o;', 'o::Octet', 'o::first'],
    ['import std.octets::{Octet as B,first};', 'B', 'first'],
  ]) program(byteFiles(`${imports}int main(){${type} b=${first};return int(b)+1;}`));
  const byteInspection = program(byteFiles('import std.octets::{Packet,swap,current};int main(){Packet p=Packet{swap(byte(42)),true};if(p.value==byte(41))return int(current);return 0;}'));
  const byteIR = source(byteInspection, 0, 'inspect').stdout;
  assert.match(byteIR, /LIR 1\.8; bytecode 1\.8/); assert.match(byteIR, /byte\.checked/); assert.match(byteIR, /byte\.to_int/);
  assert.match(byteIR, /field 0 value: byte/); assert.match(byteIR, /global g0 .*current: byte initial=41/);
  const allBytes = Array.from({ length: 256 }, (_, n) => `case byte(${n}):return ${n};`).join('');
  byteProgram(`int read(byte b){switch(b){${allBytes}default:return -1;}}int main(){for(int n=0;n<256;n++){byte b=byte(n);if(int(b)!=n||read(b)!=n)return 1;}return 42;}`);
  for (const [body, message] of [
    ['int main(){byte b=42;return 42;}', /expected byte, got int/],
    ['int main(){int b=byte(42);return 42;}', /expected int, got byte/],
    ['int main(){bool b=byte(0);return 42;}', /expected bool, got byte/],
    ['int main(){byte b=true;return 42;}', /expected byte, got bool/],
    ['int main(){return byte(42);}', /expected int, got byte/],
    ['int main(){byte b;return 42;}', /require an initializer/],
    ['int main(){byte b=byte();return 42;}', /expected expression/],
    ['int main(){return int();}', /expected expression/],
    ['int main(){byte b=byte(1,2);return 42;}', /after conversion operand/],
    ['int main(){return int(byte(1),byte(2));}', /after conversion operand/],
    ['int main(){return int byte(42);}', /after conversion type/],
    ['int main(){return int(byte 42);}', /after conversion type/],
    ['int main(){return int(42);}', /expected byte, got int/],
    ['int main(){byte b=byte(byte(42));return 42;}', /expected int, got byte/],
    ['int main(){byte b=byte(true);return 42;}', /expected int, got bool/],
    ['int main(){return int(false);}', /expected byte, got bool/],
    ['enum K{A};int main(){byte b=byte(K::A);return 42;}', /expected int, got enum/],
    ['enum K{A};int main(){return int(K::A);}', /expected byte, got enum/],
    ['struct P{int x;};int main(){byte b=byte(P{42});return 42;}', /expected int, got struct/],
    ['struct P{int x;};int main(){return int(P{42});}', /expected byte, got struct/],
    ['int main(){byte b=byte(1);b++;return 42;}', /expected int, got byte/],
    ['int main(){return -byte(1);}', /expected int, got byte/],
    ['int main(){byte b=byte(1)+byte(2);return 42;}', /expected int, got byte/],
    ['int main(){if(byte(1)<byte(2))return 42;return 0;}', /expected int, got byte/],
    ['int main(){if(byte(1))return 42;return 0;}', /expected bool, got byte/],
    ['int main(){if(byte(1)==1)return 42;return 0;}', /matching scalar types/],
    ['int main(){byte a[2];a[0]=42;return 42;}', /expected byte, got int/],
    ['int main(){byte a[byte(2)];return 42;}', /expected int, got byte/],
    ['int main(){byte a[2];return int(a[byte(0)]);}', /expected int, got byte/],
    ['int main(){const byte a[2];a[0]=byte(42);return 42;}', /cannot modify const/],
    ['int main(){const byte b=byte(0);b=byte(42);return 42;}', /cannot modify const/],
    ['int main(){byte a[2]=byte(0);return 42;}', /cannot have an initializer/],
    ['int main(){byte b=byte(0);return b.x;}', /requires a struct value/],
    ['int main(){byte b=byte(1);switch(b){case 1:return 42;default:return 0;}}', /expected byte, got int/],
    ['int main(){switch(1){case byte(1):return 42;default:return 0;}}', /expected int, got byte/],
    ['const byte b=byte(1);int main(){switch(b){case b:return 42;case byte(1):return 0;default:return 1;}}', /duplicate case value/],
    ['int main(){switch(byte(0)){case byte(256):return 42;default:return 0;}}', /byte conversion out of range/],
    ['int main(){const byte b=byte(0);switch(b){case b:return 42;default:return 0;}}', /local binding is not a compile-time/],
    ['static byte b=byte(0);int main(){switch(b){case b:return 42;default:return 0;}}', /mutable static/],
    ['const byte b=0;int main(){return 42;}', /expected byte, got int/],
    ['static byte b=0;int main(){return 42;}', /expected byte, got int/],
    ['const byte a=byte(int(b));const byte b=a;int main(){return 42;}', /constant dependency cycle/],
    ['static int n=0;const byte b=byte(n);int main(){return 42;}', /mutable static/],
    ['int f(){return 0;}const byte b=byte(f());int main(){return 42;}', /function call/],
    ['const bool b=true||(int(byte(missing))==0);int main(){return 42;}', /unknown local/],
    ['const bool b=true||(int(byte(true))==0);int main(){return 42;}', /expected int, got bool/],
    ['using Octet=byte;int main(){Octet b=Octet(42);return 42;}', /type alias is not callable/],
    ['using Octet=byte;int f(Octet b){return 1;}int f(byte b){return 2;}int main(){return 42;}', /duplicate function signature/],
    ['byte main(){return byte(42);}', /entry point/],
    ['enum K{A=byte(0)};int main(){return 42;}', /expected int, got byte/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const value of [-2147483648, -1, 256, 2147483647]) {
    for (const kind of ['const', 'static'])
      rejected({ 'app/main.l': `module app.main;${kind} byte b=byte(${value});int main(){return 42;}` }, /byte conversion out of range/);
    const f = fixture({ 'app/main.l': `module app.main;byte narrow(int n){return byte(n);}int main(){return int(narrow(${value}));}` });
    assert.match(source(f, 70, 'run').stderr, /byte conversion out of range/);
    const output = resolve(f.directory, 'trap.lbc'); source(f, 0, 'compile', ['-o', output]);
    assert.match(command(70, ['run', output]).stderr, /byte conversion out of range/);
  }
  for (const body of [
    'int main(){byte b=byte(256);return int(b);}',
    'int main(){byte a[2];int n=-1;return int(a[n]);}',
    'int main(){byte a[2];int n=2;a[n]=byte(42);return 42;}',
    'int main(){byte a[1];int n=1;a[n]=byte(256);return 42;}',
  ]) {
    const f = fixture({ 'app/main.l': `module app.main;${body}` }), output = resolve(f.directory, 'trap.lbc');
    const message = body.startsWith('int main(){byte b') ? /byte conversion/ : /array index out of bounds/;
    assert.match(source(f, 70, 'run').stderr, message);
    source(f, 0, 'compile', ['-o', output]); assert.match(command(70, ['run', output]).stderr, message);
  }
  let byteConstantModels = 0;
  for (let batch = 0; batch < 8; ++batch) {
    let declarations = 'using Octet=byte;', comparisons = '';
    for (let n = batch * 32; n < (batch + 1) * 32; ++n) {
      const a = BigInt(n), b = BigInt(255 - n), expected = (a * 17n + b * 3n) % 256n;
      declarations += `const Octet c${n}=byte((${a}*17+${b}*3)%256);static byte s${n}=c${n};`;
      comparisons += `if(int(c${n})!=${expected}||int(s${n})!=${expected})return 1;`;
      ++byteConstantModels;
    }
    byteProgram(`${declarations}int main(){${comparisons}return 42;}`);
  }
  state = 0x42595445;
  for (let test = 0; test < 32; ++test) {
    const initial = BigInt(random(256)), start = BigInt(random(256)), nodes = [];
    const project = { 'std/bytes.l': `module std.bytes;pub using Octet=byte;pub const Octet initial=byte(${initial});pub static Octet cell=initial;` };
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.b${n}`, delta = BigInt(random(256)), parents = [], form = (test + n) % 3;
      let imports = form === 0 ? 'import std.bytes;' : form === 1 ? 'import std.bytes as b;' : 'import std.bytes::{Octet as B,cell};';
      const type = form === 0 ? 'std::bytes::Octet' : form === 1 ? 'b::Octet' : 'B';
      const cell = form === 0 ? 'std::bytes::cell' : form === 1 ? 'b::cell' : 'cell';
      let body = `value=byte((int(value)+int(${cell})+${delta})%256);${cell}=value;`;
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        parents.push(p);
        const parent = nodes[p].name, style = (test + p) % 3;
        if (!style) { imports += `import ${parent};`; body += `value=${parent.replaceAll('.', '::')}::work::run(value);`; }
        else if (style === 1) { imports += `import ${parent} as m${p};`; body += `value=m${p}::work::run(value);`; }
        else { imports += `import ${parent}::{work::run as f${p}};`; body += `value=f${p}(value);`; }
      }
      nodes.push({ name, delta, parents });
      project[`${name.replaceAll('.', '/')}.l`] = `module ${name};${imports}namespace work{pub ${type} run(${type} value){${body}return value;}}`;
    }
    let cell = initial;
    function simulate(n, value) {
      value = (value + cell + nodes[n].delta) % 256n; cell = value;
      for (const parent of nodes[n].parents) value = simulate(parent, value);
      return value;
    }
    const a = simulate(7, start), b = simulate(6, start);
    const imports = ['import std.bytes::{Octet,cell};', 'import app.b7 as top;', 'import app.b6 as next;'];
    if (test % 2) imports.reverse();
    project['app/main.l'] = `module app.main;${imports.join('')}int main(){Octet start=byte(${start});Octet a=top::work::run(start);Octet b=next::work::run(start);`
      + `if(int(start)!=${start}||int(a)!=${a}||int(b)!=${b}||int(cell)!=${cell})return 1;return 42;}`;
    const settings = config(); if (test % 2) settings.module_roots.reverse();
    const f = program(project, 42, settings);
    assert.equal(readFileSync(resolve(f.directory, 'program.lbc')).readUInt32LE(16), 1, 'shared byte cell must not be duplicated');
  }

  // Scoped enum members retain nominal types through constants, storage and calls.
  const enumProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const enumFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/kinds.l': 'module std.kinds;namespace tokens{pub enum Kind{Id,Number=7,End,Alias=7,};}'
      + 'enum Secret{Hidden};pub const tokens::Kind first=tokens::Kind::Id;pub static tokens::Kind current=first;'
      + 'pub tokens::Kind swap(tokens::Kind k){tokens::Kind old=current;current=k;return old;}' });
  enumProgram('enum K{A,B=7,C,Same=7};int main(){K k=K::B;if(k==K::Same&&k!=K::C)return 42;return 0;}');
  enumProgram('enum K{A,B};const K c=K::B;static K state=c;K change(K k){K old=state;state=k;return old;}int main(){if(change(K::A)!=K::B||state!=K::A)return 1;return 42;}');
  enumProgram('enum K{A,B};struct P{K kind;int x;};P change(P p){p.kind=K::B;return p;}int main(){P p=P{K::A,42};P q=change(p);if(p.kind!=K::A||q.kind!=K::B)return 1;p.kind=q.kind;return p.x;}');
  enumProgram('enum K{A,B};K id(K k){return k;}int main(){auto a=K::A;const K b=K::B;a=id(b);if(a==b)return 42;return 0;}');
  enumProgram('enum K{A,B,C};const K label=K::B;int score(K k){switch(k){case K::A:return 1;case label:return 42;default:return 0;}}int main(){return score(K::B);}');
  enumProgram('enum K{A,B,C};int main(){int n=0;switch(K::B){case K::A:n=1;case K::B:n=n+40;case K::C:n=n+2;break;default:n=0;}return n;}');
  enumProgram('enum K{A=0,B=7,C=-5,D,Lo=-2147483648,Hi=2147483647,Same=7,Reset=0,Next};const int v=40+2;enum Q{X=v,Y};int main(){if(K::B!=K::Same||K::Next==K::Reset||K::D==K::C||Q::X==Q::Y)return 1;return 42;}');
  enumProgram('const int forward=later*2;enum K{A=forward,B,C=-forward};const int later=21;const K choice=K::B;const bool ok=choice==K::B;int main(){if(ok)return 42;return 0;}');
  enumProgram('namespace n{enum K{A=base,B};const int base=7;K get(){return K::B;}}int main(){if(n::get()==n::K::B)return 42;return 0;}');
  enumProgram('K id(K k){return k;}enum K{K};int main(){if(id(K::K)==K::K)return 42;return 0;}');
  enumProgram('enum A{X};enum B{X};int f(A a){return 20;}int f(B b){return 22;}int main(){return f(A::X)+f(B::X);}');
  enumProgram('enum K{A,B};void f(K k){k=K::B;return;}int main(){K k=K::A;f(k);if(k==K::A)return 42;return 0;}');
  enumProgram('pub enum K{A,B};pub struct P{K k;};pub const K c=K::A;pub static K s=K::B;pub K id(K k){return k;}int main(){P p=P{id(c)};if(p.k!=s)return 42;return 0;}');
  enumProgram('enum A{X};pub enum B{X};pub B id(B k){return k;}int main(){if(id(B::X)==B::X)return 42;return 0;}');
  enumProgram('enum K{A};namespace n{enum K{A};K id(K k){return k;}}int main(){if(n::id(n::K::A)==n::K::A)return 42;return 0;}');
  for (const [imports, type, member] of [
    ['import std.kinds;', 'std::kinds::tokens::Kind', 'std::kinds::tokens::Kind::Number'],
    ['import std.kinds as k;', 'k::tokens::Kind', 'k::tokens::Kind::Number'],
    ['import std.kinds::{tokens::Kind};', 'Kind', 'Kind::Number'],
    ['import std.kinds::{tokens::Kind as K};', 'K', 'K::Number'],
    ['import std.kinds::{tokens::Kind as K,tokens::Kind::Number as number};', 'K', 'number'],
  ]) program(enumFiles(`${imports}int main(){${type} value=${member};if(value==${type}::Alias)return 42;return 0;}`));
  const enumInspection = program(enumFiles('import std.kinds as k;pub struct P{k::tokens::Kind kind;};int main(){P p=P{k::tokens::Kind::Number};if(k::swap(p.kind)==k::first&&k::current==p.kind)return 42;return 0;}'));
  const enumIR = source(enumInspection, 0, 'inspect').stdout;
  assert.match(enumIR, /enum t261 stdlib::std::kinds::tokens::Kind \(4 members\)/);
  assert.match(enumIR, /member Number = 7/); assert.match(enumIR, /field 0 kind: stdlib::std::kinds::tokens::Kind/);
  assert.match(enumIR, /global g0 .*current: stdlib::std::kinds::tokens::Kind initial=0/);
  assert.equal(readFileSync(resolve(enumInspection.directory, 'program.lbc')).readUInt32LE(24), 2);
  for (const [body, message] of [
    ['enum K{};int main(){return 42;}', /at least one member/],
    ['enum {A};int main(){return 42;}', /enum name/],
    ['enum K A;int main(){return 42;}', /after enum name/],
    ['enum K{1};int main(){return 42;}', /enum member name/],
    ['enum K{A B};int main(){return 42;}', /after enum members/],
    ['enum K{A}int main(){return 42;}', /after enum declaration/],
    ['enum K{A,A};int main(){return 42;}', /duplicate enum member name/],
    ['enum K{A};enum K{B};int main(){return 42;}', /duplicate enum declaration/],
    ['enum K{A};const int K=0;int main(){return 42;}', /enum conflicts with module constant/],
    ['enum K{A};static int K=0;int main(){return 42;}', /enum conflicts with module constant/],
    ['enum K{A};struct K{int x;};int main(){return 42;}', /enum conflicts with struct/],
    ['enum K{A};using K=int;int main(){return 42;}', /enum conflicts with type alias/],
    ['enum K{A};int K(){return 0;}int main(){return 42;}', /enum conflicts with function/],
    ['namespace K{}enum K{A};int main(){return 42;}', /enum conflicts with namespace/],
    ['enum K{A=2147483647,B};int main(){return 42;}', /integer overflow/],
    ['enum K{A=2147483647+1};int main(){return 42;}', /integer overflow/],
    ['enum K{A=-2147483648-1};int main(){return 42;}', /integer overflow/],
    ['enum K{A=1/0};int main(){return 42;}', /division by zero/],
    ['enum K{A=true};int main(){return 42;}', /expected int, got bool/],
    ['enum K{A=K::B,B=0};int main(){return 42;}', /expected int, got enum/],
    ['enum K{A=mutable};static int mutable=0;int main(){return 42;}', /mutable static/],
    ['enum K{A=f()};int f(){return 0;}int main(){return 42;}', /function call/],
    ['enum K{A};using Alias=K;int main(){return 42;}', /type alias target/],
    ['enum K{A};int main(){K a[2];return 42;}', /array element type/],
    ['enum K{A};int main(){K k=0;return 42;}', /expected enum, got int/],
    ['enum K{A};int main(){int k=K::A;return 42;}', /expected int, got enum/],
    ['enum K{A};const K k=0;int main(){return 42;}', /expected enum, got int/],
    ['enum K{A};static K k=0;int main(){return 42;}', /expected enum, got int/],
    ['enum K{A};int main(){K k=K::A;k++;return 42;}', /expected int, got enum/],
    ['enum K{A};int main(){K k=K::A;k=k+1;return 42;}', /expected int, got enum/],
    ['enum K{A};int main(){return -K::A;}', /expected int, got enum/],
    ['enum K{A};int main(){if(K::A< K::A)return 42;return 0;}', /expected int, got enum/],
    ['enum K{A};int main(){if(K::A==0)return 42;return 0;}', /matching scalar types/],
    ['enum K{A};enum Q{A};int main(){if(K::A==Q::A)return 42;return 0;}', /matching scalar types/],
    ['enum K{A};enum Q{A};int main(){K k=Q::A;return 42;}', /expected enum, got enum/],
    ['enum K{A};int main(){K::A=K::A;return 42;}', /cannot modify module constant/],
    ['enum K{A};int main(){const K k=K::A;k=K::A;return 42;}', /cannot modify const/],
    ['enum K{A};struct P{K k;};int main(){const P p=P{K::A};p.k=K::A;return 42;}', /cannot modify const/],
    ['enum K{A};int main(){return K;}', /enum type is not a value/],
    ['enum K{A};int main(){return K();}', /enum type is not callable/],
    ['enum K{A};int main(){return K{0};}', /requires a struct type/],
    ['enum K{A};int main(){K k=K::A;return k.x;}', /requires a struct value/],
    ['enum K{A};int main(){return K::missing;}', /not a scalar constant/],
    ['enum K{A};int main(){return A;}', /unknown local/],
    ['enum K{A};int main(){int K=0;auto k=K::A;return 42;}', /local binding/],
    ['enum K{A};int main(){int a[K::A];return 42;}', /expected int, got enum/],
    ['enum K{A};int main(){switch(K::A){case 0:return 42;default:return 0;}}', /expected enum, got int/],
    ['enum K{A};int main(){switch(0){case K::A:return 42;default:return 0;}}', /expected int, got enum/],
    ['enum K{A};enum Q{A};int main(){switch(K::A){case Q::A:return 42;default:return 0;}}', /expected enum, got enum/],
    ['enum K{A=7,B=7};int main(){switch(K::A){case K::A:return 42;case K::B:return 0;}}', /duplicate case value/],
    ['enum K{A};static K k=K::A;int main(){switch(K::A){case k:return 42;default:return 0;}}', /mutable static/],
    ['enum K{A};int main(){const K k=K::A;switch(K::A){case k:return 42;default:return 0;}}', /local binding is not a compile-time/],
    ['enum K{A};pub K f(){return K::A;}int main(){return 42;}', /public interface exposes a private enum/],
    ['enum K{A};pub int f(K k){return 42;}int main(){return 42;}', /public interface exposes a private enum/],
    ['enum K{A};pub const K k=K::A;int main(){return 42;}', /public interface exposes a private enum/],
    ['enum K{A};pub static K k=K::A;int main(){return 42;}', /public interface exposes a private enum/],
    ['enum K{A};pub struct P{K k;};int main(){return 42;}', /public interface exposes a private enum/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const body of ['int main(){k::Secret v=k::Secret::Hidden;return 42;}', 'int main(){return k::Secret;}',
    'int main(){return k::Secret();}', 'int main(){return k::Secret::Hidden;}'])
    rejected(enumFiles(`import std.kinds as k;${body}`), /inaccessible symbol/);
  rejected(enumFiles('import std.kinds::{Secret};int main(){return 42;}'), /requires pub/);
  rejected(enumFiles('import std.kinds::{Secret::Hidden};int main(){return 42;}'), /requires pub/);
  rejected(enumFiles('import std.kinds::{tokens::Kind as K};namespace n{enum K{Other};K f(){return K::Number;}}int main(){return 42;}'), /not a scalar constant/);
  const enumsLimit = Array.from({ length: 256 }, (_, n) => `enum E${n}{A,B};`).join('');
  enumProgram(`${enumsLimit}int main(){E255 k=E255::B;if(k!=E255::A)return 42;return 0;}`);
  rejected({ 'app/main.l': `module app.main;${enumsLimit}enum Extra{A};int main(){return 42;}` }, /too many enums/);
  rejected({ 'app/main.l': `module app.main;import app.other;${enumsLimit}int main(){return 42;}`,
    'app/other.l': 'module app.other;enum Extra{A};' }, /too many enums across modules/);
  const membersLimit = Array.from({ length: 1024 }, (_, n) => `M${n}`).join(',');
  enumProgram(`enum K{${membersLimit}};int main(){switch(K::M1023){case K::M1023:return 42;default:return 0;}}`);
  rejected({ 'app/main.l': `module app.main;enum K{${membersLimit},Extra};int main(){return 42;}` }, /too many enum members/);
  state = 0x454e554d;
  for (let test = 0; test < 32; ++test) {
    const names = ['A', 'B', 'C', 'D'], nodes = [];
    const project = { 'std/types.l': 'module std.types;pub enum Kind{A=-7,B,C=2147483647,D=-2147483648,Alias=-7};'
      + 'pub static Kind current=Kind::A;pub static int hits=0;',
    'std/other.l': 'module std.other;pub enum Kind{A=-7,B,C=2147483647,D=-2147483648};' };
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.e${n}`, map = names.map(() => random(4)), parents = [];
      let imports = 'import std.types as t;', body = 'switch(k){';
      for (let k = 0; k < 4; ++k) body += `case t::Kind::${names[k]}:k=t::Kind::${names[map[k]]};break;`;
      body += '}t::current=k;t::hits++;';
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        parents.push(p);
        const parent = nodes[p].name, form = (test + n + p) % 3;
        if (!form) { imports += `import ${parent};`; body += `k=${parent.replaceAll('.', '::')}::work::run(k);`; }
        else if (form === 1) { imports += `import ${parent} as m${p};`; body += `k=m${p}::work::run(k);`; }
        else { imports += `import ${parent}::{work::run as f${p}};`; body += `k=f${p}(k);`; }
      }
      nodes.push({ name, map, parents });
      project[`${name.replaceAll('.', '/')}.l`] = `module ${name};${imports}namespace work{pub t::Kind run(t::Kind k){${body}return k;}}`;
    }
    let current = 0, hits = 0;
    function simulate(n, input) {
      let k = nodes[n].map[input]; current = k; ++hits;
      for (const parent of nodes[n].parents) k = simulate(parent, k);
      return k;
    }
    const initial = random(4), a = simulate(7, initial), b = simulate(6, initial);
    const imports = ['import std.types::{Kind as K,current,hits};', 'import std.other as other;', 'import app.e7 as top;', 'import app.e6 as next;'];
    if (test % 2) imports.reverse();
    project['app/main.l'] = `module app.main;${imports.join('')}int f(K k){return 20;}int f(other::Kind k){return 22;}`
      + `int main(){K original=K::${names[initial]};K a=top::work::run(original);K b=next::work::run(original);`
      + `if(original!=K::${names[initial]}||a!=K::${names[a]}||b!=K::${names[b]}||hits!=${hits}||current!=K::${names[current]})return 1;`
      + 'return f(K::Alias)+f(other::Kind::A);}';
    const settings = config(); if (test % 2) settings.module_roots.reverse();
    const f = program(project, 42, settings);
    assert.equal(readFileSync(resolve(f.directory, 'program.lbc')).readUInt32LE(24), 2, 'shared enum identity must not be duplicated');
  }

  // Nominal value structs copy through locals, argument vectors and return registers.
  const structProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const structFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/pairs.l': 'module std.pairs;using Count=int;pub struct Pair{Count x;bool ready;};struct Secret{int x;};'
      + 'pub Pair make(int x){return Pair{x,true};}pub Pair change(Pair p,int x){p.x=x;return p;}' });
  structProgram('struct Pair{int x;bool ready;};int main(){Pair p=Pair{42,true};if(p.ready)return p.x;return 0;}');
  structProgram('struct Pair{int x;bool ready;};int main(){Pair p=Pair{40,true};Pair q=p;p.x++;q.x=q.x+2;q.ready=false;if(p.x!=41||p.ready!=true)return 1;return q.x;}');
  structProgram('struct Pair{int x;bool ready;};int main(){Pair p=Pair{41,false};int a=p.x++;int b=p.x--;p.ready=true;if(p.ready)return a+b-41;return 0;}');
  structProgram('struct Pair{int x;bool ready;};Pair change(Pair p){p.x=p.x+2;p.ready=!p.ready;return p;}int main(){Pair p=Pair{40,false};Pair q=change(p);if(p.x!=40||p.ready)return 1;if(q.ready)return q.x;return 0;}');
  structProgram('struct Pair{int x;bool ready;};void change(Pair p){p.x=0;p.ready=false;return;}int main(){Pair p=Pair{42,true};change(p);if(p.ready)return p.x;return 0;}');
  structProgram('struct Pair{int x;bool ready;};Pair make(){return Pair{42,true};}int main(){if(make().ready)return make().x;return 0;}');
  structProgram('struct Pair{int x;int y;};int main(){int n=20;Pair p=Pair{n++,n++};return p.x+p.y+1;}');
  structProgram('struct Pair{int x;int y;};int add(int a,int b){return a+b;}int main(){Pair p=Pair{add(10,10),add(add(5,5),12),};return p.x+p.y;}');
  structProgram('struct Pair{int x;bool ready;};Pair step(Pair p,int n){if(n==0)return p;p.x++;return step(p,n-1);}int main(){Pair p=Pair{40,true};Pair q=step(p,2);if(p.x!=40)return 1;return q.x;}');
  structProgram('struct A{int x;};struct B{bool active;int y;int z;};B f(int n,A a,bool b,B p){a.x++;p.z=n+a.x+p.y;p.active=b;return p;}int main(){B q=f(20,A{19},true,B{false,2,0});if(q.active)return q.z;return 0;}');
  structProgram('struct P{int x;};int main(){auto a=P{1};P b=P{2};P c=P{42};a=b=c;c.x=0;return a.x+b.x-42;}');
  structProgram('struct P{int x;};P copy(const P p){return p;}int main(){const P a=P{42};P b=copy(a);b.x=0;return a.x;}');
  structProgram('struct P{int x;};P f(bool active){if(active)return P{42};else return P{0};}int main(){return f(true).x;}');
  structProgram('struct P{int x;};P f(int n){switch(n){case 0:return P{42};default:return P{0};}}int main(){return f(0).x;}');
  structProgram('struct A{int x;};struct B{int x;};int f(A p){return p.x;}int f(B p){return p.x*2;}int main(){return f(A{20})+f(B{11});}');
  structProgram('namespace n{struct P{int x;};}namespace n{P make(){return P{42};}}int main(){return n::make().x;}');
  structProgram('P make(){return P{42};}struct P{int x;};int main(){return make().x;}');
  structProgram('struct P{int x;int y;bool b;};int main(){P p=P{-2147483648,2147483647,true};P q=p;q.x=0;if(p.x!=-2147483648||p.y!=2147483647||!p.b)return 1;return 42;}');
  structProgram('struct Pair{int Pair;};int main(){Pair Pair=Pair{42};return Pair.Pair;}');
  program(structFiles('import std.pairs;int main(){std::pairs::Pair p=std::pairs::make(40);return std::pairs::change(p,42).x;}'));
  program(structFiles('import std.pairs as p;int main(){p::Pair value=p::Pair{42,true};return value.x;}'));
  program(structFiles('import std.pairs::{Pair as P,make,change};P f(P p){return change(p,42);}int main(){P p=make(1);return f(p).x;}'));
  const structInspection = program(structFiles('import std.pairs;int main(){return std::pairs::make(42).x;}'));
  const structIR = source(structInspection, 0, 'inspect').stdout;
  assert.match(structIR, /struct t\d+ stdlib::std::pairs::Pair \(2 fields\)/);
  assert.match(structIR, /field 1 ready: bool/); assert.match(structIR, /struct\.make/); assert.match(structIR, /field\.load/);
  program({ 'app/main.l': 'module app.main;import std.a;import std.b;int main(){return std::a::P{20}.x+std::b::P{22}.x;}',
    'std/a.l': 'module std.a;pub struct P{int x;};', 'std/b.l': 'module std.b;pub struct P{int x;};' });
  for (const [body, message] of [
    ['struct P{};int main(){return 42;}', /at least one scalar field/],
    ['struct {int x;};int main(){return 42;}', /struct name/],
    ['struct P int x;int main(){return 42;}', /after struct name/],
    ['struct P{int;};int main(){return 42;}', /struct field name/],
    ['struct P{int x};int main(){return 42;}', /after scalar struct field/],
    ['struct P{int x; }int main(){return 42;}', /after struct declaration/],
    ['struct P{int x=1;};int main(){return 42;}', /after scalar struct field/],
    ['struct P{int x[2];};int main(){return 42;}', /after scalar struct field/],
    ['struct P{int f();};int main(){return 42;}', /after scalar struct field/],
    ['struct P{void x;};int main(){return 42;}', /fields must be scalar/],
    ['struct P{auto x;};int main(){return 42;}', /fields must be scalar/],
    ['struct P{P x;};int main(){return 42;}', /fields must be scalar/],
    ['struct P{int x;bool x;};int main(){return 42;}', /duplicate struct field/],
    ['struct P{int x;};struct P{int x;};int main(){return 42;}', /duplicate struct declaration/],
    ['struct P{int x;};const int P=42;int main(){return 42;}', /struct conflicts with module constant/],
    ['static int P=42;struct P{int x;};int main(){return 42;}', /struct conflicts with module constant/],
    ['struct P{int x;};using P=int;int main(){return 42;}', /type alias conflicts with struct/],
    ['struct P{int x;};int P(){return 42;}int main(){return 42;}', /struct conflicts with function/],
    ['namespace P{}struct P{int x;};int main(){return 42;}', /struct conflicts with namespace/],
    ['struct P{int x;};using Alias=P;int main(){return 42;}', /type alias target/],
    ['struct P{int x;};int main(){P a[2];return 42;}', /array element type/],
    ['struct P{int x;};static P p=P{42};int main(){return 42;}', /explicit int or bool/],
    ['struct P{int x;};const P p=P{42};int main(){return 42;}', /explicit int or bool/],
    ['struct P{int x;};int main(){P p;return 42;}', /require an initializer/],
    ['struct P{int x;};int main(){P p=P{};return 42;}', /number of struct initializer fields/],
    ['struct P{int x;};int main(){P p=P{1,2};return 42;}', /number of struct initializer fields/],
    ['struct P{int x;};int main(){P p=P{true};return 42;}', /expected int, got bool/],
    ['struct P{int x;};int main(){P p=P{42;return 42;}', /after struct literal/],
    ['struct P{int x;};int main(){P p=P{42};return p.;}', /field name/],
    ['struct P{int x;};int main(){P p=P{42};return p.missing;}', /unknown struct field/],
    ['int main(){int n=42;return n.x;}', /requires a struct value/],
    ['int main(){missing.x=42;return 42;}', /field mutation requires a local struct binding/],
    ['struct P{int x;};P make(){return P{42};}int main(){make().x=0;return 42;}', /field mutation requires a local struct binding/],
    ['struct P{int x;};int main(){const P p=P{42};p.x=0;return 42;}', /cannot modify const binding/],
    ['struct P{int x;};P f(const P p){p.x++;return p;}int main(){return 42;}', /cannot modify const binding/],
    ['struct P{int x;};int main(){P p=P{42};p.x=true;return 42;}', /expected int, got bool/],
    ['struct P{bool b;};int main(){P p=P{true};return p.b++;}', /expected int, got bool/],
    ['struct P{int x;};int main(){P p=P{42};return p++;}', /expected int, got struct/],
    ['struct P{int x;};int main(){P p=P{42};return p==p;}', /equality requires matching scalar/],
    ['struct P{int x;};int main(){P p=P{42};return p.x();}', /direct function calls/],
    ['struct P{int x;};int main(){return P;}', /struct type is not a value/],
    ['struct P{int x;};int main(){return P();}', /struct type is not callable/],
    ['using Count=int;int main(){Count{42};return 42;}', /struct literal requires a struct type/],
    ['int main(){(1+2){42};return 42;}', /struct literal requires a named struct type/],
    ['struct P{int x;};const int n=P{42};int main(){return 42;}', /struct literal is not a constant expression/],
    ['struct P{int x;};const int n=P{42}.x;int main(){return 42;}', /struct literal is not a constant expression/],
    ['struct A{int x;};struct B{int x;};int main(){A a=B{42};return 42;}', /expected struct, got struct/],
    ['struct A{int x;};struct B{int x;};int f(A a){return a.x;}int main(){return f(B{42});}', /no matching function overload/],
    ['struct P{int x;};pub P make(){return P{42};}int main(){return 42;}', /public signature exposes a private struct/],
    ['struct P{int x;};pub int read(P p){return p.x;}int main(){return 42;}', /public signature exposes a private struct/],
    ['struct P{int x;};int main(){int P=0;P{42};return 42;}', /local binding/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const body of ['int main(){std::pairs::Secret p=std::pairs::Secret{42};return 42;}',
    'int main(){return std::pairs::Secret{42}.x;}', 'int main(){return std::pairs::Secret;}', 'int main(){return std::pairs::Secret();}'])
    rejected(structFiles(`import std.pairs;${body}`), /inaccessible symbol/);
  rejected(structFiles('import std.pairs::{Secret};int main(){return 42;}'), /requires pub/);
  rejected(structFiles('import std.pairs as P;struct P{int x;};int main(){return 42;}'), /alias conflicts/);
  const structsLimit = Array.from({ length: 256 }, (_, n) => `struct S${n}{int x;};`).join('');
  structProgram(`${structsLimit}int main(){return S255{42}.x;}`);
  rejected({ 'app/main.l': `module app.main;${structsLimit}struct Extra{int x;};int main(){return 42;}` }, /too many structs/);
  rejected({ 'app/main.l': `module app.main;import app.other;${structsLimit}int main(){return 42;}`,
    'app/other.l': 'module app.other;struct Extra{int x;};' }, /too many structs across modules/);
  const fieldsLimit = Array.from({ length: 64 }, (_, n) => `${n % 2 ? 'bool' : 'int'} f${n};`).join('');
  const fieldValues = Array.from({ length: 64 }, (_, n) => n % 2 ? 'true' : '42').join(',');
  structProgram(`struct P{${fieldsLimit}};int main(){P p=P{${fieldValues}};if(p.f63)return p.f62;return 0;}`);
  rejected({ 'app/main.l': `module app.main;struct P{${fieldsLimit}int extra;};int main(){return 42;}` }, /too many struct fields/);
  for (const [body, message] of [
    ['struct P{int x;};int main(){P p=P{2147483647};return p.x++;}', /integer overflow/],
    ['struct P{int x;};int main(){P p=P{-2147483648};return p.x--;}', /integer overflow/],
  ]) {
    const f = fixture({ 'app/main.l': `module app.main;${body}` }), output = resolve(f.directory, 'trap.lbc');
    assert.match(source(f, 70, 'run').stderr, message);
    source(f, 0, 'compile', ['-o', output]); assert.match(command(70, ['run', output]).stderr, message);
  }
  state = 0x53545243;
  for (let test = 0; test < 32; ++test) {
    const project = { 'std/records.l': 'module std.records;pub struct Packet{int x;bool ready;};',
      'std/other.l': 'module std.other;pub struct Packet{int x;bool ready;};' }, nodes = [];
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.r${n}`, kind = (test + n) % 3;
      let imports = kind === 0 ? 'import std.records;' : kind === 1 ? 'import std.records as types;' : 'import std.records::{Packet as Value};';
      const type = kind === 0 ? 'std::records::Packet' : kind === 1 ? 'types::Packet' : 'Value';
      const delta = random(41) - 20, parents = [];
      let body = `p.x=p.x+(${delta});p.ready=!p.ready;`;
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        parents.push(p);
        const parent = nodes[p].name, form = (test + n + p) % 3;
        if (!form) { imports += `import ${parent};`; body += `p=${parent.replaceAll('.', '::')}::work::run(p);`; }
        else if (form === 1) { imports += `import ${parent} as m${p};`; body += `p=m${p}::work::run(p);`; }
        else { imports += `import ${parent}::{work::run as f${p}};`; body += `p=f${p}(p);`; }
      }
      nodes.push({ name, delta, parents });
      project[`${name.replaceAll('.', '/')}.l`] = `module ${name};${imports}namespace work{pub ${type} run(${type} p){${body}return p;}}`;
    }
    function simulate(n, input) {
      let value = { x: input.x + nodes[n].delta, ready: !input.ready };
      for (const parent of nodes[n].parents) value = simulate(parent, value);
      return value;
    }
    const original = { x: random(2001) - 1000, ready: random(2) !== 0 }, a = simulate(7, original), b = simulate(6, original);
    const imports = ['import std.records::{Packet};', 'import std.other as other;', 'import app.r7 as top;', 'import app.r6 as next;'];
    if (test % 2) imports.reverse();
    project['app/main.l'] = `module app.main;${imports.join('')}int main(){Packet original=Packet{${original.x},${original.ready}};`
      + `Packet a=top::work::run(original);Packet b=next::work::run(original);other::Packet o=other::Packet{13,true};`
      + `if(original.x!=${original.x}||original.ready!=${original.ready}||o.x!=13||!o.ready)return 1;`
      + `if(a.x!=${a.x}||a.ready!=${a.ready}||b.x!=${b.x}||b.ready!=${b.ready})return 1;return 42;}`;
    const settings = config(); if (test % 2) settings.module_roots.reverse();
    const f = program(project, 42, settings);
    assert.equal(readFileSync(resolve(f.directory, 'program.lbc')).readUInt32LE(20), 2, 'shared struct identity must not be duplicated');
  }

  // Transparent scalar type aliases share module/namespace lookup and disappear before IR.
  const aliasProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const aliasFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/types.l': 'module std.types;using Hidden=int;pub using Count=Hidden;'
      + 'namespace flags{pub using Enabled=bool;}pub Count twice(Count n){return n*2;}' });
  aliasProgram('using Count=int;Count main(){Count n=42;return n;}');
  aliasProgram('using Count=Other;using Other=int;Count main(){return 42;}');
  aliasProgram('Count main(){Count n=42;return n;}using Count=int;');
  aliasProgram('using Flag=bool;using Count=int;Count f(Count n,Flag active){if(active)return n;return 0;}Count main(){return f(42,true);}');
  aliasProgram('using Count=int;using Flag=bool;const Count initial=40;static Count count=initial;static Flag active=true;Count main(){if(active){active=false;return count++ + count++ -39;}return 0;}');
  aliasProgram('using Count=int;using Flag=bool;Count main(){Count a[2];Flag b[2];b[1]=true;a[1]=42;if(b[1]&&!b[0])return a[1];return 0;}');
  aliasProgram('using Count=int;Count main(){const Count a[1];const Count n=42;return a[0]+n;}');
  aliasProgram('using Count=int;Count main(){Count sum=0;for(Count i=0;i<7;i++)sum=sum+i;return sum*2;}');
  aliasProgram('namespace n{using Count=int;}namespace n{Count value(){return 42;}}int main(){n::Count zero=0;return zero+n::value();}');
  aliasProgram('namespace n{using Count=int;namespace nested{Count value(){return 42;}}}int main(){return n::nested::value();}');
  aliasProgram('namespace n{namespace kinds{using Count=int;}namespace use{using Number=kinds::Count;Number value(){return 42;}}}int main(){return n::use::value();}');
  aliasProgram('using Kind=int;namespace n{using Kind=bool;Kind active(){return true;}}int main(){Kind value=42;if(n::active())return value;return 0;}');
  aliasProgram('using Count=int;int main(){Count Count=42;return Count;}');
  aliasProgram('using Count=int;int main(){{int Count=0;Count++;}Count n=42;return n;}');
  aliasProgram('using Count=int;int f(int Count){return Count;}int main(){return f(42);}');
  aliasProgram('using Count=int;using Flag=bool;int f(Count n){return n*2;}int f(Flag n){if(n)return 42;return 0;}int main(){return f(21)+f(true)-42;}');
  program(aliasFiles('import std.types;std::types::Count main(){std::types::Count n=21;return std::types::twice(n);}'));
  program(aliasFiles('import std.types as t;using Number=t::Count;Number main(){return t::twice(21);}'));
  program(aliasFiles('import std.types::{Count as Number,flags::Enabled as Flag,twice};Number main(){Flag ready=true;if(ready)return twice(21);return 0;}'));
  program(aliasFiles('import std.types::{Count};using Count=bool;int main(){Count ready=true;if(ready)return 42;return 0;}'));
  program(aliasFiles('import std.types;int main(){return std::types::twice(21);}'));
  program({ ...aliasFiles('import std.types;int main(){return std::types::twice(21);}'),
    'std/types.l': 'module std.types;using Hidden=int;pub Hidden twice(Hidden n){return n*2;}' });
  const erasedSource = 'module app.main;\nusing Int=int;using Bool=bool;\nstatic Int count=40;static Bool active=true;\n'
    + 'Int next(Int n){return count++ + n;}Int main(){Bool b[1];b[0]=active;if(b[0])return next(2);return 0;}';
  const erased = program({ 'app/main.l': erasedSource });
  const primitives = program({ 'app/main.l': erasedSource.replace(/using \w+=\w+;/g, text => ' '.repeat(text.length))
    .replace(/\bInt\b/g, 'int').replace(/\bBool\b/g, 'bool') });
  assert.deepEqual(readFileSync(resolve(erased.directory, 'program.lbc')), readFileSync(resolve(primitives.directory, 'program.lbc')));
  for (const [body, message] of [
    ['using =int;int main(){return 42;}', /type alias name/],
    ['using Count int;int main(){return 42;}', /after type alias name/],
    ['using Count=int int main(){return 42;}', /after type alias/],
    ['using Count=;int main(){return 42;}', /expected Stage 0 type/],
    ['using Count=void;int main(){return 42;}', /target must be int or bool/],
    ['using Count=auto;int main(){return 42;}', /target must be int or bool/],
    ['using Count=int[2];int main(){return 42;}', /after type alias/],
    ['using Count=int();int main(){return 42;}', /after type alias/],
    ['using Count=const int;int main(){return 42;}', /expected Stage 0 type/],
    ['using namespace n;namespace n{}int main(){return 42;}', /type alias name/],
    ['using Count<T>=int;int main(){return 42;}', /after type alias name/],
    ['int main(){using Count=int;return 42;}', /expected expression/],
    ['using Count=int;using Count=int;int main(){return 42;}', /duplicate type alias/],
    ['namespace n{using Count=int;}namespace n{using Count=bool;}int main(){return 42;}', /duplicate type alias/],
    ['using Count=int;const int Count=42;int main(){return 42;}', /conflicts with module constant/],
    ['static int Count=42;using Count=int;int main(){return 42;}', /conflicts with module constant/],
    ['using Count=int;int Count(){return 42;}int main(){return 42;}', /conflicts with function/],
    ['namespace Count{}using Count=int;int main(){return 42;}', /conflicts with namespace/],
    ['using Count=int;int main(){Count n=true;return 42;}', /expected int, got bool/],
    ['using Flag=bool;int main(){Flag a[1];a[0]=42;return 42;}', /expected bool, got int/],
    ['using Count=int;const Count n=true;int main(){return 42;}', /expected int, got bool/],
    ['using Count=int;static Count n=true;int main(){return 42;}', /expected int, got bool/],
    ['using Count=int;int f(Count n){return n;}int f(int n){return n;}int main(){return 42;}', /duplicate function signature/],
    ['using Flag=bool;Flag main(){return true;}', /entry point must have signature/],
    ['using Count=int;int main(){return Count;}', /type alias is not a value/],
    ['using Count=int;int main(){Count=42;return 0;}', /type alias is not a value/],
    ['using Count=int;int main(){return Count();}', /type alias is not callable/],
    ['using Count=int;int main(){return Count(42);}', /type alias is not callable/],
    ['int value(){return 42;}using Count=value;int main(){return 42;}', /not a type alias/],
    ['const int value=42;using Count=value;int main(){return 42;}', /not a type alias/],
    ['using Count=Missing;int main(){return 42;}', /unknown/],
    ['Missing main(){return 42;}', /unknown/],
    ['int f(Missing n){return 42;}int main(){return 42;}', /unknown/],
    ['const Missing n=42;int main(){return 42;}', /unknown/],
    ['int main(){Missing n=42;return n;}', /unknown/],
    ['using Count=int;int main(){int Count=0;Count n=42;return n;}', /local binding/],
    ['using Count=int;int f(Count Count,Count n){return n;}int main(){return 42;}', /local binding/],
    ['namespace n{using Count=int;}int main(){int n=0;n::Count value=42;return value;}', /local binding/],
    ['using Count=int;namespace n{}int main(){n::Count value=42;return value;}', /not a type alias/],
    ['using Count=int;namespace n{const int Count=0;int main(){Count value=42;return value;}}int main(){return 42;}', /not a type alias/],
    ['using Count=int;int main(){Count::;}', /after name separator/],
    ['using Count=int;int main(){Count::', /after name separator/],
    ['using Count=int;int main(){for(Count::;false;){}return 42;}', /after name separator/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const [body, message] of [
    ['import std.types;int main(){Count n=42;return n;}', /unknown/],
    ['import std.types;int main(){std::types::Hidden n=42;return n;}', /inaccessible symbol/],
    ['import std.types;using Number=std::types::Hidden;int main(){return 42;}', /inaccessible symbol/],
    ['import std.types::{Hidden};int main(){return 42;}', /requires pub/],
    ['import std.types;int main(){return std::types::Hidden();}', /inaccessible symbol/],
    ['import std.types;int main(){return std::types::Hidden;}', /inaccessible symbol/],
    ['import std.types as t;using t=int;int main(){return 42;}', /alias conflicts/],
    ['import std.types as t;int main(){int t=0;t::Count n=42;return n;}', /local binding/],
    ['import std.types::{Count};import std.types::{flags::Enabled as Count};int main(){return 42;}', /ambiguous selective/],
    ['import std.types;using Number=missing::Count;int main(){return 42;}', /no unqualified fallback/],
  ]) rejected(aliasFiles(body), message);
  rejected({ 'app/main.l': 'module app.main;import app.bridge;app::bridge::Count main(){return 42;}',
    'app/bridge.l': 'module app.bridge;import std.types::{Count};', 'std/types.l': 'module std.types;pub using Count=int;' }, /not a type alias/);
  for (const [body, path] of [
    ['using A=A;', 'app::main::A -> app::main::A'],
    ['using A=B;using B=A;', 'app::main::A -> app::main::B -> app::main::A'],
    ['using A=n::B;namespace n{using B=C;using C=A;}', 'app::main::A -> app::main::n::B -> app::main::n::C -> app::main::A'],
  ]) {
    const f = rejected({ 'app/main.l': `module app.main;${body}int main(){return 42;}` }, /type alias dependency cycle/);
    assert.ok(source(f, 65).stderr.includes(path));
  }
  const aliasFailure = rejected({ ...aliasFiles('import std.types;int main(){return 42;}'),
    'std/types.l': 'module std.types;using A=B;using B=A;' }, /type alias dependency cycle/);
  assert.ok(source(aliasFailure, 65).stderr.includes('/std/types.l:'));
  const aliasChain = length => Array.from({ length }, (_, n) => `using A${n}=${n + 1 < length ? `A${n + 1}` : 'int'};`).join('');
  aliasProgram(`${aliasChain(256)}A0 main(){return 42;}`);
  rejected({ 'app/main.l': `module app.main;${aliasChain(257)}int main(){return 42;}` }, /nesting limit/);
  const aliasLimit = Array.from({ length: 1024 }, (_, n) => `using A${n}=int;`).join('');
  aliasProgram(`${aliasLimit}A1023 main(){return 42;}`);
  rejected({ 'app/main.l': `module app.main;${aliasLimit}using Extra=bool;int main(){return 42;}` }, /too many type aliases/);
  rejected({ 'app/main.l': `module app.main;import app.types;${aliasLimit}int main(){return 42;}`,
    'app/types.l': 'module app.types;using Extra=int;' }, /too many type aliases across modules/);

  state = 0x414c4941;
  for (let test = 0; test < 32; ++test) {
    const project = {}, types = [], entryImports = [];
    let main = 'int main(){';
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.a${n}`, parents = [], imports = [], references = [];
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        const parent = `${p < 4 ? 'std' : 'app'}.a${p}`, kind = (test + n + p) % 3;
        parents.push(p);
        if (!kind) { imports.push(`import ${parent};`); references.push(`${parent.replaceAll('.', '::')}::kinds::Value`); }
        else if (kind === 1) { imports.push(`import ${parent} as p${p};`); references.push(`p${p}::kinds::Value`); }
        else { imports.push(`import ${parent}::{kinds::Value as V${p}};`); references.push(`V${p}`); }
      }
      let type = random(2) ? 'int' : 'bool', target = type;
      if (parents.length && random(3) === 0) {
        const at = random(parents.length); type = types[parents[at]]; target = references[at];
      }
      const literal = type === 'int' ? String(random(10001) - 5000) : String(random(2) !== 0);
      types.push(type);
      if (test % 2) imports.reverse();
      project[`${name.replaceAll('.', '/')}.l`] = `module ${name};${imports.join('')}`
        + `namespace kinds{pub using Value=Storage;using Storage=${target};}`
        + `pub const kinds::Value seed=${literal};pub static kinds::Value cell=seed;`
        + 'pub kinds::Value identity(kinds::Value value){return value;}';
      const kind = (test + n) % 3, prefix = kind === 0 ? name.replaceAll('.', '::') : `m${n}`;
      let valueType = `${prefix}::kinds::Value`, identity = `${prefix}::identity`, seed = `${prefix}::seed`, cell = `${prefix}::cell`;
      if (kind === 2) {
        entryImports.push(`import ${name}::{kinds::Value as T${n},identity as f${n},seed as s${n},cell as c${n}};`);
        valueType = `T${n}`; identity = `f${n}`; seed = `s${n}`; cell = `c${n}`;
      } else entryImports.push(`import ${name}${kind ? ` as ${prefix}` : ''};`);
      const updated = type === 'int' ? String(BigInt(literal) + 1n) : String(literal !== 'true');
      main += `${valueType} v${n}=${identity}(${seed});if(v${n}!=${literal})return 1;`
        + `${cell}=${type === 'int' ? `v${n}+1` : `!v${n}`};if(${cell}!=${updated})return 1;`;
    }
    if (test % 2) entryImports.reverse();
    project['app/main.l'] = `module app.main;${entryImports.join('')}${main}return 42;}`;
    const settings = config(); if (test % 2) settings.module_roots.reverse();
    program(project, 42, settings);
  }

  // Module constants share normal namespace, import and visibility rules.
  const constantFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/values.l': 'module std.values;const int seed=40;pub const int answer=seed+2;pub const bool ready=answer==42;' });
  const constantProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  constantProgram('const int answer=42;int main(){return answer;}');
  constantProgram('const bool ready=true;int main(){if(ready)return 42;return 1;}');
  constantProgram('const int answer=base+2;const int base=40;int main(){return answer;}');
  constantProgram('int main(){return answer;}const int answer=42;');
  constantProgram('const int base=40;namespace n{pub const int answer=base+2;}int main(){return n::answer;}');
  constantProgram('namespace n{const int a=b+2;}namespace n{const int b=40;}int main(){return n::a;}');
  constantProgram('const int answer=7;int main(){int answer=answer+35;return answer;}');
  constantProgram('const int answer=1;namespace n{const int answer=42;int f(){return answer;}}int main(){return n::f();}');
  constantProgram('namespace n{namespace v{const int answer=42;}namespace use{const int answer=v::answer;int f(){return answer;}}}int main(){return n::use::f();}');
  constantProgram('const int index=1;int main(){int a[2];a[index]=42;return a[index];}');
  constantProgram('const int n=2;int main(){int a[n];return a[0]+42;}');
  constantProgram('const int n=21;const bool active=true;int f(int v){return v*2;}int f(bool v){if(v)return 42;return 0;}int main(){return f(n)+f(active)-42;}');
  constantProgram('const int answer=42;namespace n{int answer(){return 42;}}int main(){return answer+n::answer()-42;}');
  constantProgram('const bool a=false&&1/0==0;const bool b=true||(-2147483648/-1)==0;int main(){if(!a&&b)return 42;return 1;}');
  constantProgram('const bool a=false&&a;const bool b=true||b;int main(){if(!a&&b)return 42;return 1;}');
  program(constantFiles('import std.values;int main(){if(std::values::ready)return std::values::answer;return 1;}'));
  program(constantFiles('import std.values as v;int main(){return v::answer;}'));
  program(constantFiles('import std.values::{answer,ready as active};int main(){if(active)return answer;return 1;}'));
  program(constantFiles('import std.values::{answer as value};const int answer=value;int main(){return answer;}'));
  program(constantFiles('import std.values::{answer};const int answer=21;int main(){return answer*2;}'));
  program(constantFiles('import std.values::{answer};int twice(int answer){return answer*2;}int main(){return twice(21);}'));
  program(constantFiles('import std.values::{answer};int main(){int answer=0;answer=42;return answer;}'));
  program({ ...constantFiles('import std.values::{answer};int main(){return answer;}'),
    'std/values.l': 'module std.values;namespace v{pub const int value=42;}pub const int answer=v::value;' });
  const inlined = constantProgram('const int answer=42;int main(){return answer;}');
  assert.match(source(inlined, 0, 'inspect').stdout, /0 parameters, 0 slots, 1 registers/);
  const constantRelocation = constantFiles('import std.values;const int answer=std::values::answer;int main(){return answer;}');
  const constantOriginal = program(constantRelocation), constantConfig = config(); constantConfig.module_roots.reverse();
  const constantMoved = fixture(constantRelocation, constantConfig), constantOutput = resolve(constantMoved.directory, 'moved.lbc');
  source(constantMoved, 0, 'compile', ['-o', constantOutput]);
  assert.deepEqual(readFileSync(resolve(constantOriginal.directory, 'program.lbc')), readFileSync(constantOutput));
  for (const [body, message] of [
    ['const int answer;int main(){return 0;}', /require a scalar initializer/],
    ['const int answer=42 int main(){return 0;}', /after module constant/],
    ['const int =42;int main(){return 0;}', /module constant name/],
    ['const auto answer=42;int main(){return 0;}', /explicit int or bool/],
    ['const void answer=0;int main(){return 0;}', /explicit int or bool/],
    ['const bool answer=42;int main(){return 0;}', /expected bool, got int/],
    ['const int answer=true;int main(){return 0;}', /expected int, got bool/],
    ['const int answer=42;const bool answer=true;int main(){return 0;}', /duplicate module constant/],
    ['namespace n{const int answer=1;}namespace n{const int answer=2;}int main(){return 0;}', /duplicate module constant/],
    ['const int answer=42;int answer(){return 0;}int main(){return 0;}', /conflicts with function/],
    ['namespace n{const int answer=42;}namespace n{int answer(){return 0;}}int main(){return 0;}', /conflicts with function/],
    ['namespace n{}const int n=42;int main(){return 0;}', /conflicts with namespace/],
    ['const int answer=42;int main(){answer=1;return answer;}', /cannot modify module constant/],
    ['const int answer=42;int main(){return answer++;}', /cannot modify module constant/],
    ['namespace n{const int answer=42;}int main(){n::answer--;return 0;}', /cannot modify module constant/],
    ['const int answer=42;int main(){return answer();}', /constant is not callable/],
    ['int f(){return 42;}const int answer=f;int main(){return answer;}', /not a scalar constant/],
    ['const int answer=n;int main(){int n=42;return n;}', /unknown local variable or constant/],
    ['const int answer=1;const int value=(answer=42);int main(){return value;}', /assignment is not/],
    ['const int answer=1;const int value=answer++;int main(){return value;}', /postfix update is not/],
    ['const int answer=1;const int value=answer[0];int main(){return value;}', /expected string, got int/],
    ['int f(){return 42;}const int answer=f();int main(){return answer;}', /function call is not/],
    ['bool f(){return true;}const bool answer=false&&f();int main(){return 0;}', /function call is not/],
    ['const bool answer=false&&missing;int main(){return 0;}', /unknown local variable or constant/],
    ['const bool answer=true||42;int main(){return 0;}', /expected bool, got int/],
    ['const int a[2];int main(){return 0;}', /scalar initializer/],
    ['const int answer=42;import std.values;int main(){return answer;}', /must precede/],
    ['const int answer=42;int main(){return missing::answer;}', /no unqualified fallback/],
    ['const int answer=42;namespace n{}int main(){return n::answer;}', /not a scalar constant/],
    ['const int answer=42;namespace n{const bool answer=true;int f(){return answer;}}int main(){return n::f();}', /expected int, got bool/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const [body, message] of [
    ['import std.values;int main(){return answer;}', /unknown local variable or constant/],
    ['import std.values;int main(){return std::values::seed;}', /inaccessible symbol/],
    ['import std.values::{seed};int main(){return 0;}', /requires pub/],
    ['import std.values::{answer};int main(){return answer();}', /constant is not callable/],
    ['import std.values;int main(){return std::values::seed();}', /inaccessible symbol/],
    ['import std.values as v;const int v=42;int main(){return 0;}', /alias conflicts/],
    ['import std.values::{answer};import std.values::{ready as answer};int main(){return 0;}', /ambiguous selective/],
    ['import std.values as v;int main(){v::answer=0;return 0;}', /cannot modify module constant/],
    ['import std.values as v;int main(){int v=42;return v::answer;}', /local binding/],
    ['import std.values::{answer};int answer(){return 42;}int main(){return answer;}', /not a scalar constant/],
  ]) rejected(constantFiles(body), message);
  rejected(files('import std.math::{answer};const int answer=42;int main(){return answer();}'), /constant is not callable/);
  rejected({ 'app/main.l': 'module app.main;import app.values;int main(){return app::values::answer;}',
    'app/values.l': 'module app.values;const int answer=42;' }, /inaccessible symbol/);
  rejected({ 'app/main.l': 'module app.main;import app.bridge;const int answer=42;int main(){return app::bridge::answer;}',
    'app/bridge.l': 'module app.bridge;import std.values::{answer};', 'std/values.l': 'module std.values;pub const int answer=42;' }, /not a scalar constant/);
  for (const [body, path] of [
    ['const int a=a;', 'app::main::a -> app::main::a'],
    ['const int a=b;const int b=a;', 'app::main::a -> app::main::b -> app::main::a'],
    ['const int a=n::b;namespace n{const int b=c;const int c=a;}', 'app::main::a -> app::main::n::b -> app::main::n::c -> app::main::a'],
    ['const bool a=true&&a;', 'app::main::a -> app::main::a'],
  ]) {
    const f = rejected({ 'app/main.l': `module app.main;${body}int main(){return 42;}` }, /constant dependency cycle/);
    assert.ok(source(f, 65).stderr.includes(path));
  }
  const importedFailure = rejected({ ...constantFiles('import std.values;int main(){return 42;}'),
    'std/values.l': 'module std.values;pub const int answer=2147483647+1;' }, /invalid constant expression: integer overflow/);
  assert.ok(source(importedFailure, 65).stderr.includes('/std/values.l:'));
  const runtimeFailure = fixture({ 'app/main.l': 'module app.main;const int minimum=-2147483648;int main(){return minimum/-1;}' });
  assert.match(source(runtimeFailure, 70, 'run').stderr, /VM trap: integer overflow/);
  const runtimeOutput = resolve(runtimeFailure.directory, 'runtime.lbc');
  source(runtimeFailure, 0, 'compile', ['-o', runtimeOutput]);
  assert.match(command(70, ['run', runtimeOutput]).stderr, /VM trap: integer overflow/);
  const constantCycleConfig = config(); constantCycleConfig.dependencies.push({ from: 'stdlib', to: 'application' });
  rejected({ 'app/main.l': 'module app.main;import std.values;const bool safe=true||std::values::value;int main(){return 42;}',
    'std/values.l': 'module std.values;import app.main;pub const bool value=false;' }, /Module dependency cycle detected/, constantCycleConfig);
  const constantChain = length => Array.from({ length }, (_, n) => `const int c${n}=${n + 1 < length ? `c${n + 1}` : '42'};`).join('');
  constantProgram(`${constantChain(128)}int main(){return c0;}`);
  rejected({ 'app/main.l': `module app.main;${constantChain(129)}int main(){return c0;}` }, /nesting limit/);
  const constantLimit = Array.from({ length: 1024 }, (_, n) => `const int c${n}=42;`).join('');
  constantProgram(`${constantLimit}int main(){return c1023;}`);
  rejected({ 'app/main.l': `module app.main;${constantLimit}const int extra=0;int main(){return 42;}` }, /too many module constants/);
  rejected({ 'app/main.l': `module app.main;import app.values;${constantLimit}int main(){return 42;}`,
    'app/values.l': 'module app.values;pub const int value=42;' }, /too many module constants across modules/);

  // Independent BigInt oracle: compare full-width folded values, not exit-code residues.
  const edges = [-2147483648n, -2147483647n, -42n, -1n, 0n, 1n, 42n, 2147483646n, 2147483647n];
  const folded = [];
  let constantModels = 0, shapeModels = 0;
  const lengthBody = expression => `int main(){int a[${expression}];return 42;}`;
  const labelBody = expression => `int main(){switch(0){case ${expression}:return 42;default:return 1;}}`;
  function model(expression, type, value, error) {
    ++constantModels;
    if (error) rejected({ 'app/main.l': `module app.main;const ${type} value=${expression};int main(){return 42;}` }, error);
    else folded.push({ expression, type, value: String(value) });
    if (type === 'int') {
      ++shapeModels;
      if (error) {
        for (const body of [lengthBody, labelBody]) rejected({ 'app/main.l': `module app.main;${body(expression)}` }, error);
      } else if (value < 1n || value > 65535n) {
        rejected({ 'app/main.l': `module app.main;${lengthBody(expression)}` }, /array length must be between/);
      }
    }
  }
  for (const a of edges) for (const b of edges) {
    for (const op of ['+', '-', '*', '/', '%']) {
      const expression = `(${a})${op}(${b})`;
      if ((op === '/' || op === '%') && b === 0n) { model(expression, 'int', 0, /division by zero/); continue; }
      if ((op === '/' || op === '%') && a === -2147483648n && b === -1n) { model(expression, 'int', 0, /integer overflow/); continue; }
      const result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
      model(expression, 'int', result, result < -2147483648n || result > 2147483647n ? /integer overflow/ : null);
    }
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      const value = op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
      model(`(${a})${op}(${b})`, 'bool', value);
    }
  }
  for (const a of edges) {
    model(`-(${a})`, 'int', -a, a === -2147483648n ? /integer overflow/ : null);
    model(`+(${a})`, 'int', a);
  }
  for (const a of [false, true]) {
    model(`!${a}`, 'bool', !a);
    for (const b of [false, true]) {
      model(`${a}&&${b}`, 'bool', a && b); model(`${a}||${b}`, 'bool', a || b);
      model(`${a}==${b}`, 'bool', a === b); model(`${a}!=${b}`, 'bool', a !== b);
    }
  }
  for (let first = 0; first < folded.length; first += 64) {
    const batch = folded.slice(first, first + 64);
    const declarations = batch.map((c, n) => `const ${c.type} c${n}=${c.expression};`).join('');
    const assertions = batch.map((c, n) => `if(c${n}!=${c.value})return 1;`).join('');
    constantProgram(`${declarations}int main(){${assertions}return 42;}`);
  }
  const integerShapes = folded.filter(value => value.type === 'int');
  for (let first = 0; first < integerShapes.length; first += 64) {
    const batch = integerShapes.slice(first, first + 64);
    const functions = batch.map((value, n) => {
      const array = BigInt(value.value) >= 1n && BigInt(value.value) <= 65535n;
      return `int check${n}(){${array ? `int a[${value.expression}];a[${BigInt(value.value) - 1n}]=42;` : ''}`
        + `switch(${value.value}){case ${value.expression}:return ${array ? `a[${BigInt(value.value) - 1n}]` : '42'};default:return 1;}}`;
    }).join('');
    const assertions = batch.map((_, n) => `if(check${n}()!=42)return 1;`).join('');
    const f = constantProgram(`${functions}int main(){${assertions}return 42;}`);
    const ir = command(0, ['inspect', resolve(f.directory, 'program.lbc')]).stdout;
    const lengths = [...ir.matchAll(/slot s0: int length=(\d+)/g)].map(match => BigInt(match[1]));
    assert.deepEqual(lengths, batch.map(value => BigInt(value.value)).filter(value => value >= 1n && value <= 65535n));
    assert.deepEqual([...ir.matchAll(/  case (-?\d+) ->/g)].map(match => match[1]), batch.map(value => value.value));
  }
  state = 0x434f4e53;
  for (let test = 0; test < 32; ++test) {
    const project = {}, values = [];
    for (let n = 0; n < 8; ++n) {
      let imports = '', expression = 'seed', value = BigInt(1 + random(100));
      const seed = value;
      for (let p = 0; p < n; ++p) if (random(3) === 0) {
        const kind = random(3);
        if (!kind) { imports += `import app.c${p};`; expression += `+app::c${p}::value`; }
        else if (kind === 1) { imports += `import app.c${p} as m${p};`; expression += `+m${p}::value`; }
        else { imports += `import app.c${p}::{value as v${p}};`; expression += `+v${p}`; }
        value += values[p];
      }
      project[`app/c${n}.l`] = `module app.c${n};${imports}pub const int value=${expression};const int seed=${seed};`;
      values.push(value);
    }
    project['app/main.l'] = `module app.main;import app.c7::{value};int main(){if(value==${values[7]})return 42;return 1;}`;
    program(project);
  }

  // Lengths and labels use module-constant rules, never runtime locals or mutable storage.
  constantProgram('int main(){int a[(1+2)*2/3];a[1]=42;return a[1];}');
  constantProgram('const int n=3;int main(){int a[n+0];a[n-1]=42;switch(a[n-1]){case 6*7:return a[n-1];default:return 0;}}');
  constantProgram('int main(){int a[n];a[n-1]=42;switch(42){case answer:return a[n-1];default:return 1;}}const int n=3;const int answer=42;');
  constantProgram('namespace sizes{const int n=3;}namespace use{int value(){int a[sizes::n];a[2]=42;return a[2];}}int main(){return use::value();}');
  constantProgram('using Count=int;const Count n=2;int main(){Count a[n];bool flags[n*2/2];flags[1]=true;if(flags[1])return a[0]+42;return 1;}');
  constantProgram('const int n=2;int main(){const int a[n];return a[n-1]+42;}');
  constantProgram('const int a=3;int main(){int a[a];return a[2]+42;}');
  constantProgram('const int n=65535;int main(){int a[n];int b[65536-n];return a[n-1]+b[0]+42;}');
  constantProgram('const int n=3;int main(){int sum=0;for(int i=0;i<2;i++){int a[n];if(a[n-1]!=0)return 1;a[n-1]=42;sum=sum+a[n-1];}return sum/2;}');
  constantProgram('const int low=-2147483648;const int high=2147483647;int main(){switch(low){case high:return 1;case -2147483647-1:return 42;default:return 0;}}');
  constantProgram('const int a=1;const int b=2;int main(){int n=0;switch(a){case a:n=20;case b:n=n+22;}return n;}');
  constantProgram('const int key=2;int main(){switch(2){case 0:{int key=0;}case key:return 42;default:return 0;}}');
  constantProgram('const int key=2;int main(){int n=0;for(int i=0;i<3;i++){switch(i){case key-1:continue;case key:n=n+42;break;default:break;}}return n;}');
  program(constantFiles('import std.values;int main(){int a[std::values::answer/14];a[2]=42;switch(a[2]){case std::values::answer:return a[2];default:return 1;}}'));
  program(constantFiles('import std.values as v;int main(){int a[v::answer/14];switch(42){case v::answer+0:return a[0]+42;default:return 1;}}'));
  program(constantFiles('import std.values::{answer as n};int main(){int a[n/14];switch(42){case n:return a[0]+42;default:return 1;}}'));
  const shapeSource = 'module app.main;const int n=3;int main(){int a[n+0];a[2]=42;switch(a[2]){case (6*7):return a[2];default:return 0;}}';
  const shapeOriginal = program({ 'app/main.l': shapeSource });
  const shapeLiteral = program({ 'app/main.l': shapeSource.replace('[n+0]', '[3  ]').replace('(6*7)', '(42 )') });
  assert.deepEqual(readFileSync(resolve(shapeOriginal.directory, 'program.lbc')), readFileSync(resolve(shapeLiteral.directory, 'program.lbc')));
  for (const [declarations, locals, expression, message] of [
    ['', '', 'true', /expected int, got bool/],
    ['', '', 'false', /expected int, got bool/],
    ['', '', '1<2', /expected int, got bool/],
    ['', 'int n=3;', 'n', /local binding is not a compile-time constant/],
    ['', 'const int n=3;', 'n', /local binding is not a compile-time constant/],
    ['const int n=3;', 'int n=2;', 'n', /local binding is not a compile-time constant/],
    ['', 'int a[1];', 'a', /local binding is not a compile-time constant/],
    ['static int n=3;', '', 'n', /mutable static storage is not a constant expression/],
    ['int value(){return 3;}', '', 'value()', /function call is not/],
    ['const int n=3;', '', '(n=4)', /assignment is not/],
    ['const int n=3;', '', 'n++', /postfix update is not/],
    ['', 'int a[1];', 'a[0]', /array access is not/],
    ['bool value(){return true;}', '', 'false&&value()', /function call is not/],
    ['static bool active=true;', '', 'true||active', /mutable static storage is not/],
    ['', 'bool active=true;', 'false&&active', /local binding is not a compile-time constant/],
    ['', '', 'false&&missing', /unknown/],
    ['using Count=int;', '', 'Count', /type alias is not a value/],
  ]) {
    for (const body of [expr => `int main(){${locals}int data[${expr}];return 42;}`,
      expr => `int main(){${locals}switch(0){case ${expr}:return 42;default:return 1;}}`])
      rejected({ 'app/main.l': `module app.main;${declarations}${body(expression)}` }, message);
  }
  for (const [body, message] of [
    [lengthBody('2-2'), /array length must be between/],
    [lengthBody('-1'), /array length must be between/],
    [lengthBody('65535+1'), /array length must be between/],
    ['const int n=65535;int main(){int a[n];int b[2];return 42;}', /too many array elements/],
    ['int f(int n){int a[n];return 42;}int main(){return 42;}', /local binding is not a compile-time constant/],
    ['int f(int n){switch(0){case n:return 42;default:return 0;}}int main(){return 42;}', /local binding is not a compile-time constant/],
    ['const int n=3;int f(int n){int a[n];return 42;}int main(){return 42;}', /local binding is not a compile-time constant/],
    ['int main(){return 42;int a[1/0];}', /division by zero/],
    ['static int n=3;int main(){if(false){int a[n];}return 42;}', /mutable static storage is not/],
    ['int main(){switch(0){case 0:return 42;case 1/0:return 1;}}', /division by zero/],
    ['int main(){switch(0){case 6*7:return 42;case 42:return 0;}return 1;}', /duplicate case value/],
    ['const int n=42;int main(){switch(0){case n:return 42;case 40+2:return 0;}return 1;}', /duplicate case value/],
    ['int main(){switch(0){case -2147483648:return 42;case -2147483647-1:return 0;}return 1;}', /duplicate case value/],
    ['const int n=3;int main(){switch(0){case 0:int n=1;case n:return 42;default:return 1;}}', /local binding is not a compile-time constant/],
    ['int main(){int a[2+];return 42;}', /expected expression/],
    ['int main(){switch(0){case 2+:return 42;}}', /expected expression/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const body of [lengthBody('std::values::seed'), labelBody('std::values::seed')])
    rejected(constantFiles(`import std.values;${body}`), /inaccessible symbol/);
  rejected(constantFiles('import std.values;int main(){switch(0){case std::values::answer:return 42;case 6*7:return 0;}return 1;}'), /duplicate case value/);
  const shapeFailure = rejected({ 'app/main.l': 'module app.main;import app.bad;int main(){return 42;}',
    'app/bad.l': 'module app.bad;int value(){int a[1/0];return 42;}' }, /division by zero/);
  assert.ok(source(shapeFailure, 65).stderr.includes('/app/bad.l:'));

  // Static globals have compile-time initial values but shared mutable runtime cells.
  const staticProgram = body => program({ 'app/main.l': `module app.main;${body}` });
  const staticFiles = main => ({ 'app/main.l': `module app.main;${main}`,
    'std/state.l': 'module std.state;const int start=40;static int hidden=start;pub static int count=start;'
      + 'namespace flags{pub static bool active=true;}pub int next(){return hidden++;}pub int bump(){return count++;}' });
  staticProgram('static int count=42;int main(){return count;}');
  staticProgram('static int count=start;const int start=42;int main(){return count;}');
  staticProgram('int next(){return count++;}static int count=40;int main(){return next()+next()-39;}');
  staticProgram('static int count=42;int main(){int first=count++;int second=count--;if(count!=42)return 1;return first+second-43;}');
  staticProgram('static int count=0;static int other=0;int main(){return (count=other=21)+count;}');
  staticProgram('static int count=40;int f(int count){count++;return count;}int read(){return count;}int main(){int count=f(1);{int count=42;count++;}return read()+count;}');
  staticProgram('static int count=42;int f(int count){count=0;return count;}int main(){f(count);return count;}');
  staticProgram('static int count=20;int pair(int a,int b){return a+b;}int main(){return pair(count++,count++)+1;}');
  staticProgram('static bool active=false;void flip(){active=!active;}int main(){flip();if(active){flip();if(!active)return 42;}return 1;}');
  staticProgram('static int count=0;int main(){bool a=false&&((count=7)==7);bool b=true||((count=9)==9);return count+42;}');
  staticProgram('static int index=0;int main(){int a[2];a[index++]=index;return a[0]+index+40;}');
  staticProgram('static int count=1;int main(){switch(count++){case 1:count=count+40;break;default:return 1;}return count;}');
  staticProgram('static int count=0;int main(){for(;count<6;count++){if(count==3)continue;}return count*7;}');
  staticProgram('static int count=0;static bool active=true;int main(){while(active){count++;active=count<3;}return count*14;}');
  staticProgram('static int calls=0;int visit(int n){calls++;if(n>0)visit(n-1);return calls;}int main(){return visit(5)*7;}');
  staticProgram('static int count=40;namespace n{static int count=2;}int main(){return count+n::count;}');
  staticProgram('namespace n{static int count=40;}namespace n{int next(){return count++;}}int main(){return n::next()+n::next()-39;}');
  staticProgram('static int count=2;namespace n{const int count=40;}int main(){return count+n::count;}');
  staticProgram('namespace n{namespace values{static int count=41;}namespace use{int f(){return values::count++;}}}int main(){n::use::f();return n::values::count;}');
  staticProgram('static int value=-2147483648;int main(){if(value!=-2147483648)return 1;value=2147483647;if(value!=2147483647)return 1;return 42;}');
  staticProgram('static bool active=true||1/0==0;static int count=40+2;int main(){if(active)return count;return 1;}');
  program(staticFiles('import std.state;int main(){return std::state::next()+std::state::next()-39;}'));
  program(staticFiles('import std.state as s;int main(){s::count=40;int first=s::bump();return first+s::count-39;}'));
  program(staticFiles('import std.state::{count as n};int main(){n=41;n++;return n;}'));
  program(staticFiles('import std.state::{flags::active as active,count};int main(){active=false;count=42;if(!active)return count;return 1;}'));
  program(staticFiles('import std.state::{count};int main(){int count=42;return count;}'));
  program({ 'app/main.l': 'module app.main;import std.a;import std.b;int main(){std::a::count=2;return std::a::count+std::b::count;}',
    'std/a.l': 'module std.a;pub static int count=0;', 'std/b.l': 'module std.b;pub static int count=40;' });
  const staticRelocation = staticFiles('import std.state;int main(){return std::state::next()+std::state::next()-39;}');
  const staticOriginal = program(staticRelocation), staticConfig = config(); staticConfig.module_roots.reverse();
  const staticMoved = fixture(staticRelocation, staticConfig), staticOutput = resolve(staticMoved.directory, 'moved.lbc');
  source(staticMoved, 0, 'compile', ['-o', staticOutput], { cwd: '/' });
  assert.deepEqual(readFileSync(resolve(staticOriginal.directory, 'program.lbc')), readFileSync(staticOutput));
  const staticIR = source(staticOriginal, 0, 'inspect').stdout;
  assert.match(staticIR, /LIR 1\.8; bytecode 1\.8/);
  assert.match(staticIR, /global g\d+ stdlib::std::state::hidden: int initial=40/);
  assert.match(staticIR, /global g\d+ stdlib::std::state::flags::active: bool initial=1/);
  assert.match(staticIR, /global\.load/); assert.match(staticIR, /global\.store/);
  for (const [body, message] of [
    ['static int count;int main(){return 0;}', /constant initializer/],
    ['static int =0;int main(){return 0;}', /static storage name/],
    ['static int count=0 int main(){return 0;}', /after static declaration/],
    ['static auto count=0;int main(){return 0;}', /explicit int or bool/],
    ['static void count=0;int main(){return 0;}', /explicit int or bool/],
    ['static bool active=1;int main(){return 0;}', /expected bool, got int/],
    ['static int count=true;int main(){return 0;}', /expected int, got bool/],
    ['static int count=0;static int count=1;int main(){return 0;}', /duplicate module/],
    ['static int count=0;const int count=1;int main(){return 0;}', /duplicate module/],
    ['const int count=0;static int count=1;int main(){return 0;}', /duplicate module/],
    ['namespace n{static int count=0;}namespace n{static int count=1;}int main(){return 0;}', /duplicate module/],
    ['static int count=0;int count(){return 0;}int main(){return 0;}', /conflicts with function/],
    ['namespace n{}static int n=0;int main(){return 0;}', /conflicts with namespace/],
    ['static bool active=true;int main(){return active++;}', /expected int, got bool/],
    ['static int count=0;int main(){count=true;return 0;}', /expected int, got bool/],
    ['static int count=0;int main(){return count();}', /static storage is not callable/],
    ['static int count=0;static int other=count;int main(){return 0;}', /mutable static storage is not a constant expression/],
    ['static int count=0;const int other=count;int main(){return 0;}', /mutable static storage is not a constant expression/],
    ['static int count=count;int main(){return 0;}', /mutable static storage is not a constant expression/],
    ['static bool active=false&&active;int main(){return 0;}', /mutable static storage is not a constant expression/],
    ['static int count=f();int f(){return 42;}int main(){return 0;}', /function call is not/],
    ['static int count=0;static int other=(count=42);int main(){return 0;}', /assignment is not/],
    ['static int count=0;static int other=count++;int main(){return 0;}', /postfix update is not/],
    ['static int count=0;static int other=count[0];int main(){return 0;}', /mutable static/],
    ['static int count=2147483647+1;int main(){return 42;}', /invalid constant expression: integer overflow/],
    ['static int count=1/0;int main(){return 42;}', /invalid constant expression: division by zero/],
    ['static int count[2];int main(){return 0;}', /scalar constant initializer/],
    ['static int f(){return 42;}int main(){return f();}', /scalar constant initializer/],
    ['int count=42;int main(){return count;}', /after function name/],
    ['int main(){static int count=0;return count;}', /expected expression/],
  ]) rejected({ 'app/main.l': `module app.main;${body}` }, message);
  for (const [body, message] of [
    ['import std.state;int main(){return count;}', /unknown local variable or constant/],
    ['import std.state;int main(){return std::state::hidden;}', /inaccessible symbol/],
    ['import std.state;int main(){std::state::hidden=0;return 0;}', /inaccessible symbol/],
    ['import std.state::{hidden};int main(){return 0;}', /requires pub/],
    ['import std.state::{count};int main(){return count();}', /static storage is not callable/],
    ['import std.state as s;static int s=0;int main(){return 0;}', /alias conflicts/],
    ['import std.state as s;int main(){int s=0;return s::count;}', /local binding/],
    ['import std.state as s;int main(){int s=0;s::count=42;return 0;}', /local binding/],
    ['import std.state::{count};import std.state::{flags::active as count};int main(){return 0;}', /ambiguous selective/],
    ['import std.state;static int initial=std::state::count;int main(){return 0;}', /mutable static storage is not a constant expression/],
  ]) rejected(staticFiles(body), message);
  rejected({ 'app/main.l': 'module app.main;import app.state;int main(){return app::state::count;}',
    'app/state.l': 'module app.state;static int count=42;' }, /inaccessible symbol/);
  rejected({ 'app/main.l': 'module app.main;import app.bridge;int main(){return app::bridge::count;}',
    'app/bridge.l': 'module app.bridge;import std.state::{count};', 'std/state.l': 'module std.state;pub static int count=42;' }, /not a scalar constant/);
  for (const [body, message] of [
    ['static int count=2147483647;int main(){return count++;}', /integer overflow/],
    ['static int count=-2147483648;int main(){return count--;}', /integer overflow/],
    ['static int index=2;int f(){return 1/0;}int main(){int a[1];a[index++]=f();return 0;}', /array index out of bounds/],
  ]) {
    const f = fixture({ 'app/main.l': `module app.main;${body}` }), output = resolve(f.directory, 'trap.lbc');
    assert.match(source(f, 70, 'run').stderr, message);
    source(f, 0, 'compile', ['-o', output]); assert.match(command(70, ['run', output]).stderr, message);
  }
  const importedStaticFailure = fixture({ ...staticFiles('import std.state;int main(){return std::state::next();}'),
    'std/state.l': 'module std.state;static int count=2147483647;pub int next(){return count++;}' });
  assert.ok(source(importedStaticFailure, 70, 'run').stderr.includes('/std/state.l:'));
  const staticLimit = Array.from({ length: 1024 }, (_, n) => `static int g${n}=42;`).join('');
  staticProgram(`${staticLimit}int main(){return g1023;}`);
  const separateLimits = fixture({ 'app/main.l': `module app.main;${constantLimit}${staticLimit}int main(){return g1023;}` });
  source(separateLimits);
  source(fixture({ 'app/main.l': `module app.main;${aliasLimit}${constantLimit}${staticLimit}A1023 main(){return g1023;}` }));
  rejected({ 'app/main.l': `module app.main;${staticLimit}static int extra=0;int main(){return 42;}` }, /too many static globals/);
  rejected({ 'app/main.l': `module app.main;import app.state;${staticLimit}int main(){return 42;}`,
    'app/state.l': 'module app.state;static int other=0;' }, /too many static globals across modules/);

  // Stateful DAG oracle: every graph has diamonds, crosses packages and uses all import forms.
  state = 0x53544154;
  const stateImport = (name, n, kind) => {
    const prefix = kind === 0 ? name.replaceAll('.', '::') : `d${n}`;
    if (kind !== 2) return { text: `import ${name}${kind ? ` as ${prefix}` : ''};`,
      count: `${prefix}::cells::count`, active: `${prefix}::cells::active`,
      step: `${prefix}::step`, visits: `${prefix}::visits` };
    return { text: `import ${name}::{cells::count as count${n},cells::active as active${n},step as step${n},visits as visits${n}};`,
      count: `count${n}`, active: `active${n}`, step: `step${n}`, visits: `visits${n}` };
  };
  for (let test = 0; test < 32; ++test) {
    const nodes = [], units = [], metadata = [];
    for (let n = 0; n < 8; ++n) {
      const name = `${n < 4 ? 'std' : 'app'}.s${n}`, seed = BigInt(random(100001) - 50000), active = random(2) !== 0;
      const imports = [], edges = [];
      let body = 'int previous=cells::count++;cells::visits++;cells::count=cells::count+delta;'
        + 'cells::active=!cells::active;int total=previous;';
      for (let p = 0; p < n; ++p) if (p >= n - 2 || random(3) === 0) {
        const binding = stateImport(nodes[p].name, p, (test + n + p) % 3);
        const shift = BigInt(random(21) - 10), argument = BigInt(random(21) - 10);
        edges.push({ target: p, shift, argument }); imports.push(binding.text);
        body += `if(${binding.active})${binding.count}=${binding.count}+(${shift});else ${binding.active}=true;`
          + `total=total+${binding.step}(${argument});`;
      }
      body += 'return total+cells::count;';
      const declarations = `const int seed=${seed};namespace cells{pub static int count=seed;`
        + `pub static bool active=${active};static int visits=0;}`
        + `pub int visits(){return cells::visits;}pub int step(int delta){${body}}`;
      nodes.push({ name, seed, active, edges }); units.push({ name, imports, declarations });
      const symbol = `${n < 4 ? 'stdlib' : 'application'}::${name.replaceAll('.', '::')}::cells`;
      metadata.push(`global ${symbol}::count: int initial=${seed}`, `global ${symbol}::active: bool initial=${Number(active)}`,
        `global ${symbol}::visits: int initial=0`);
    }
    const cells = nodes.map(node => ({ count: node.seed, active: node.active, visits: 0n }));
    const checked = value => {
      assert.ok(value >= -2147483648n && value <= 2147483647n, `static DAG ${test}: model overflow`);
      return value;
    };
    function step(n, delta) {
      const cell = cells[n], previous = cell.count;
      cell.count = checked(cell.count + 1n); cell.visits = checked(cell.visits + 1n);
      cell.count = checked(cell.count + delta); cell.active = !cell.active;
      let total = previous;
      for (const { target, shift, argument } of nodes[n].edges) {
        if (cells[target].active) cells[target].count = checked(cells[target].count + shift);
        else cells[target].active = true;
        total = checked(total + step(target, argument));
      }
      return checked(total + cell.count);
    }
    const bindings = nodes.map((node, n) => stateImport(node.name, n, (test + n) % 3));
    const snapshot = () => cells.map((cell, n) => `if(${bindings[n].count}!=${cell.count}`
      + `||${bindings[n].active}!=${cell.active}||${bindings[n].visits}()!=${cell.visits})return 1;`).join('');
    let main = `int main(){${snapshot()}`;
    for (let op = 0; op < 12; ++op) {
      const n = op % 4 === 0 ? 7 : random(8), delta = BigInt(random(41) - 20), binding = bindings[n], cell = cells[n];
      switch (op % 4) {
      case 0: main += `if(${binding.step}(${delta})!=${step(n, delta)})return 1;`; break;
      case 1:
        main += `${binding.count}=${binding.count}+(${delta});${binding.active}=!${binding.active};`;
        cell.count = checked(cell.count + delta); cell.active = !cell.active; break;
      case 2:
        main += `if(${binding.count}++!=${cell.count})return 1;`; cell.count = checked(cell.count + 1n); break;
      case 3: {
        const taken = cell.active && step(n, delta) !== 0n;
        main += `bool taken${op}=${binding.active}&&${binding.step}(${delta})!=0;if(taken${op}!=${taken})return 1;`;
        break;
      }
      }
      main += snapshot();
    }
    units.push({ name: 'app.main', imports: bindings.map(binding => binding.text), declarations: `${main}return 42;}` });
    for (const reversed of [false, true]) {
      const project = {};
      for (const unit of units) project[`${unit.name.replaceAll('.', '/')}.l`] = `module ${unit.name};`
        + (reversed ? [...unit.imports].reverse() : unit.imports).join('') + unit.declarations;
      const settings = config(); if (reversed) settings.module_roots.reverse();
      const f = program(project, 42, settings), output = resolve(f.directory, 'program.lbc');
      assert.equal(readFileSync(output).readUInt32LE(16), 24, `static DAG ${test}: duplicate or missing cells`);
      const actual = command(0, ['inspect', output]).stdout.split('\n').filter(line => line.startsWith('global '))
        .map(line => line.replace(/^global g\d+ /, 'global ')).sort();
      assert.deepEqual(actual, [...metadata].sort(), `static DAG ${test}: incorrect initializer table`);
    }
  }

  // Strict manifest schema, truncations, escaping and manifest-relative roots.
  const minimal = JSON.stringify(config());
  for (let cut = 0; cut < minimal.length; ++cut) assert.match(source(fixture({}, minimal.slice(0, cut)), 65).stderr, /invalid module manifest/);
  for (const bad of [
    '{}', '[]', minimal + 'x', minimal + '\0', minimal.replace('"version":1', '"version":2'),
    minimal.replace('"version":1', '"version":10'), minimal.replace('"version":1', '"version":1,"version":1'),
    minimal.replace('"version":1,', ''), minimal.replace('"package":"application",', ''),
    minimal.replace('"version"', '"unknown"'), minimal.replace('"module_roots"', '"module_roots_bad"'),
    '{"package":"abc', '{"package":"abc\\', '{"package":"\\q"}', '{"package":"\x01"}',
    '{"package":"\\u12', '{"package":"\\uQQQQ"}', '{"package":"\\u/000"}', '{"package":"\\u:000"}', '{"package":"\\ug000"}', '{"package":"\\uD800',
    '{"package":"\\uD800x"}', '{"package":"\\uD800\\x"}', '{"package":"\\uD800\\u0000"}',
    '{"package":"\\uD800\\uFFFF"}', '{"package":"\\uDC00"}', '{"package":"\\u0000"}',
  ]) assert.match(source(fixture({}, bad), 65).stderr, /invalid module manifest/);
  const invalidSettings = [];
  for (const packageName of ['', '9bad', 'bad!', '[', '{', 'a[', 'a{']) invalidSettings.push({ ...config(), package: packageName });
  invalidSettings.push({ ...config(), module_roots: [] }, { ...config(), module_roots: [{ package: 'application', prefix: 'app' }] },
    { ...config(), module_roots: [{ package: 'application', prefix: 'app', path: '' }] },
    { ...config(), dependencies: [{ from: 'application' }] },
    { ...config(), dependencies: [{ from: 'missing', to: 'stdlib' }] },
    { ...config(), dependencies: [{ from: 'application', to: 'missing' }] });
  for (const prefix of ['.app', 'app.', 'app..x', 'app.main.extra.', 'app::x', 'pub'])
    invalidSettings.push({ ...config(), module_roots: [{ package: 'application', prefix, path: 'src/app' }] });
  for (const settings of invalidSettings) assert.match(source(fixture({}, settings), 65).stderr, /invalid module manifest/);
  source(fixture({}, { ...config(), module_roots: Array(257).fill(config().module_roots[0]) }), 65);
  source(fixture({}, { ...config(), dependencies: Array(1025).fill(config().dependencies[0]) }), 65);
  for (const bad of [
    minimal.replace('"path":"src/app"', '"path":"src/app","path":"src/app"'),
    minimal.replace('"path":"src/app"', '"other":"src/app"'),
    minimal.replace('"from":"application"', '"from":"application","from":"application"'),
    minimal.replace('"to":"stdlib"', '"other":"stdlib"'),
  ]) assert.match(source(fixture({}, bad), 65).stderr, /invalid module manifest/);
  const escaped = fixture();
  const special = 'special/quote"back\\\b\f\n\r\t';
  put(resolve(escaped.directory, special, 'main.l'), 'module app.main;int main(){return 42;}');
  const specialConfig = config(); specialConfig.module_roots[0].path = special;
  put(escaped.manifest, JSON.stringify(specialConfig).replaceAll('/', '\\/'));
  escaped.input = resolve(escaped.directory, special, 'main.l'); source(escaped, 42, 'run');
  for (const [name, escape] of [['A', '\\u0041'], ['é', '\\u00E9'], ['λ', '\\u03bb'], ['€', '\\u20ac'], ['\ue000', '\\uE000'], ['😀', '\\ud83d\\ude00']]) {
    const f = fixture(); put(resolve(f.directory, name, 'main.l'), 'module app.main;int main(){return 42;}');
    const settings = config(); settings.module_roots[0].path = name;
    put(f.manifest, JSON.stringify(settings).replace(name, escape)); f.input = resolve(f.directory, name, 'main.l');
    source(f, 42, 'run');
  }
  const absolute = fixture(), absoluteConfig = config(); absoluteConfig.module_roots[0].path = resolve(absolute.directory, 'src/app');
  put(absolute.manifest, JSON.stringify(absoluteConfig)); source(absolute);
  const packageId = fixture(), packageSettings = config(); packageSettings.package = packageSettings.module_roots[0].package = 'Pkg-2_x';
  packageSettings.dependencies[0].from = 'Pkg-2_x'; put(packageId.manifest, JSON.stringify(packageSettings)); source(packageId);
  const underscore = fixture(), underscoreConfig = config(); underscoreConfig.package = underscoreConfig.module_roots[0].package = '_AZ09az-';
  underscoreConfig.dependencies[0].from = '_AZ09az-'; put(underscore.manifest, JSON.stringify(underscoreConfig)); source(underscore);
  const rawUnicode = fixture(), rawConfig = config();
  const unicodePath = 'éλ€😀\u0800\ud7ff\u{10000}\u{10ffff}';
  put(resolve(rawUnicode.directory, unicodePath, 'main.l'), 'module app.main;int main(){return 42;}');
  rawConfig.module_roots[0].path = unicodePath; put(rawUnicode.manifest, JSON.stringify(rawConfig));
  rawUnicode.input = resolve(rawUnicode.directory, unicodePath, 'main.l'); source(rawUnicode, 42, 'run');
  for (const bytes of [[0x80], [0xc0], [0xc1], [0xf5], [0xff], [0xc2, 0x7f], [0xc2, 0xc0],
    [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const text = Buffer.concat([Buffer.from('{"package":"'), Buffer.from(bytes), Buffer.from('"}')]);
    assert.match(source(fixture({}, text), 65).stderr, /invalid UTF-8/);
  }
  assert.match(source(fixture({}, Buffer.concat([Buffer.from('{"package":"'), Buffer.from([0xc2])])), 65).stderr, /truncated UTF-8/);
  const absentRoot = config(); absentRoot.module_roots[0].path = 'absent'; source(fixture({}, absentRoot), 74);
  const noManifest = fixture(); command(65, ['check', noManifest.input]);
  command(74, ['check', noManifest.input, '--manifest', resolve(noManifest.directory, 'missing.json')]);
  for (const args of [[], ['--manifest'], ['--manifest', noManifest.manifest, '--manifest', noManifest.manifest],
    ['-o', 'out'], ['--bad'], ['--manifest', noManifest.manifest]]) {
    command(64, ['check', ...args]);
  }
  command(64, ['check', noManifest.input, '--manifest']);
  command(64, ['check', noManifest.input, '--manifest', noManifest.manifest, '--manifest', noManifest.manifest]);
  command(64, ['compile', noManifest.input, '-o']);
  command(64, ['compile', noManifest.input, '-o', 'a', '-o', 'b']);
  console.log(`modules: ${checks} checks passed (32 function DAGs, 32 string DAGs, 32 byte DAGs, 32 enum DAGs, 32 struct DAGs, 32 alias DAGs, 32 constant DAGs, 32 static DAGs in two import orders, ${constantModels} constant-expression models, ${stringConstantModels} string constant models, ${byteConstantModels} byte constant models, ${shapeModels} integer shape models)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
