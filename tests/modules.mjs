import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

try {
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
  console.log(`modules: ${checks} checks passed (32 fixed-seed dependency DAGs)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
