import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), compiler = resolve(process.argv[2]);
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/replacement.'));
let fixtures = 0, commands = 0;
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', timeout: 30000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, '', 'these programs must not emit output');
  ++commands;
  return result;
}
function fixture(body, files = {}) {
  const directory = resolve(work, String(fixtures++));
  mkdirSync(directory);
  const input = resolve(directory, 'main.l'), manifest = resolve(directory, 'package.json');
  writeFileSync(input, `module app.main;\n${body}`);
  writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
    { package: 'tests', prefix: 'app', path: '.' },
  ], dependencies: [] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(resolve(directory, name), text);
  return { directory, input, manifest };
}
function source(f, status = 0, verb = 'check', extra = [], options = {}) {
  return command(status, [verb, f.input, '--manifest', f.manifest, ...extra], options);
}
function program(body, expected = 42, files = {}, trap) {
  const f = fixture(body, files), output = resolve(f.directory, 'answer.lbc');
  assert.equal(source(f).stderr, '', 'checking must neither execute nor warn');
  source(f, 0, 'compile', ['-o', output]);
  const bytes = readFileSync(output);
  assert.deepEqual([...bytes.subarray(0, 8)], [76, 66, 67, 0, 1, 0, 9, 0]);
  command(0, ['check', output]); // Deserialization invokes the existing verifier.
  for (let attempt = 0; attempt < 2; ++attempt) {
    for (const result of [source(f, expected, 'run'), command(expected, ['run', output])]) {
      if (trap) assert.match(result.stderr, trap);
      else assert.equal(result.stderr, '');
    }
  }
  const again = resolve(f.directory, 'again.lbc');
  source(f, 0, 'compile', ['-o', again], { cwd: '/' });
  assert.deepEqual(readFileSync(again), bytes, 'compilation must be deterministic and cwd-independent');
  return f;
}
function rejected(body, message, files = {}, marker) {
  const f = fixture(body, files), output = resolve(f.directory, 'rejected.lbc');
  for (const args of [['check'], ['run'], ['compile', '-o', output]]) {
    const result = source(f, 65, args[0], args.slice(1));
    assert.match(result.stderr, message);
    if (marker) {
      const text = readFileSync(f.input, 'utf8'), start = text.indexOf(marker);
      assert.ok(start >= 0);
      const prefix = text.slice(0, start);
      assert.ok(result.stderr.includes(`:${prefix.split('\n').length}:${start - prefix.lastIndexOf('\n')}: error:`),
        `wrong diagnostic location: ${result.stderr}`);
    }
  }
  assert.equal(existsSync(output), false, 'invalid source must not create bytecode');
  writeFileSync(output, 'preserve existing output');
  source(f, 65, 'compile', ['-o', output]);
  assert.equal(readFileSync(output, 'utf8'), 'preserve existing output');
}

// Exact acceptance target (module app.main maps to main.l under the declared root).
program(`
pub int add(int a, int b) {
    return a + b;
}
int main() {
    int value = add(20, 22);
    return let bonus = 0; in value + bonus;
}`);
program('int main(){return let in 42;}');
program('int main(){return let a:int=20;b=22;in a+b;}');
program('int main(){return let x=40;y=x+2;in y;}');
program('int main(){int x=40;return let x=x+1;in let x=x+1;in x;}');
program('int f(const int x){return let x=x+2;in x;}int main(){return f(40);}');
program('int main(){return let x=let y=40;in y+1;z=x+1;in z;}');
program('int main(){int x=40;int value=let x=x+1;in x;return value+x-39;}');
program('int main(){return let var x:int=40;in (x=x+1)+x++-40;}');
program('int main(){return let var ready:bool=false;in let value=(ready=true);in 42;}');
program('bool f(bool x){return let y=x;in !y;}int main(){if(f(false))return 42;return 0;}');
program('int main(){return 10+let x=2;in x*16;}');
program('int main(){return (let x=20;in x)+22;}');
program('int main(){int n=40;int value=let var n=n++;in n++;return value+n-39;}');
program('int main(){int x=0;int value=let unused=x++;again=x++;in x;return value+x+38;}');
program('int pair(int a,int b){return a*10+b;}int main(){int x=3;return pair((let old=x++;in old),x)+8;}');
program('int pair(int a,int b){return a*10+b;}int main(){int x=4;return pair((let x=1;in x),x)+28;}');
program('int main(){int x=0;bool a=false&&(let side=x++;in true);bool b=true||(let side=x++;in false);return x+42;}');
program('int main(){int x=0;bool a=true&&(let side=x++;in true);bool b=false||(let side=x++;in false);return x+40;}');
program('int fact(int n){if(n<2)return 1;return let prior=fact(n-1);in n*prior;}int main(){return fact(4)+18;}');
program('int choose(bool x){if(x)return 42;return 0;}int choose(int x){return x;}int main(){return choose(let b=true;in b);}');
program('int main(){return later(let n=40;in n+2);}pub int later(const int value){return value;}');
program('int main(){int sum=0;for(int i=0;i<3;i++){sum=sum+(let var x=13;in x++ + 1);}return sum;}');
program('int main(){int x=0;while(let old=x++;in old<2){}return x+39;}');
program('int main(){int x=0;let unused=(x=42);in 0;return x;}');
program('int main(){int x=40;{const int x=1;if((let y=x;in y)!=1)return 0;}return x+2;}');
program('int main(){return let x=-2147483648;y=2147483647;in x+y+43;}');
program('int main(){return let value=2147483647;in value;}', 255);
program('int main(){return let value=-2147483648;in value;}', 0);
program('int main(){return let x=1/0;unused=2147483647+1;in 42;}', 70, {}, /division by zero/);
program('int main(){return let unused=2147483647+1;x=1/0;in 42;}', 70, {}, /integer overflow/);
program('int main(){return let var x=2147483647;in x++;}', 70, {}, /integer overflow/);
program('int main(){return let x=0;in let y=42;in y/x;}', 70, {}, /division by zero/);

const library = 'module app.math;int hidden(){return 40;}pub int add(const int a,int b){return let value=a+b;in value;}';
program('import app.math as m;int main(){return let x=20;in m::add(x,22);}', 42, { 'math.l': library });
program('import app.math::{add as sum};int main(){return let x=20;in sum(x,22);}', 42, { 'math.l': library });
rejected('import app.math as m;int main(){return let x=0;in m::hidden();}', /inaccessible symbol/, { 'math.l': library });
rejected('int main(){return let x=0;in app::math::add(20,22);}', /unknown qualified name/);
rejected('import app.math as m;int main(){return let m=0;in m::add(20,22);}', /not callable or a namespace/, { 'math.l': library });

for (const [body, message, marker] of [
  ['int main(){return let x=missing;in x;}', /unknown local variable or constant/, 'missing'],
  ['int main(){return let x=x;in x;}', /unknown local variable or constant/],
  ['int main(){return let x=y;y=1;in x;}', /unknown local variable or constant/],
  ['int main(){int value=let x=1;in x;return x;}', /unknown local variable or constant/],
  ['int main(){return (let x=1;in x)+x;}', /unknown local variable or constant/],
  ['int main(){return let x=1;x=2;in x;}', /duplicate local declaration/],
  ['int main(){return let var x=1;x=2;in x;}', /duplicate local declaration/],
  ['int main(){return let x:int=true;in x;}', /expected int, got bool/],
  ['int main(){return let x:bool=1;in 42;}', /expected bool, got int/],
  ['int main(){return let x=1;in x=true;}', /cannot modify const binding/],
  ['int main(){return let x=1;in x=42;}', /cannot modify const binding/],
  ['int main(){return let x=1;in x++;}', /cannot modify const binding/],
  ['int main(){return let x=1;in x--;}', /cannot modify const binding/],
  ['int main(){return let var x=1;in x=true;}', /expected int, got bool/],
  ['int main(){return let var x=true;in x++;}', /expected int, got bool/],
  ['int main(){const int x=1;return let y=(x=2);in y;}', /cannot modify const binding/],
  ['int f(const int x){return let y=x++;in y;}int main(){return f(1);}', /cannot modify const binding/],
  ['int main(){return let x=1;in true+x;}', /expected int, got bool/],
  ['int main(){return let x=1;in !x;}', /expected bool, got int/],
  ['int main(){return let x=true;in x;}', /expected int, got bool/],
  ['int main(){int value=let x=true;in x;return value;}', /expected int, got bool/],
  ['bool f(){return let x=1;in x;}int main(){return 0;}', /expected bool, got int/],
  ['int main(){return let x=1;in missing();}', /unknown function/],
  ['int main(){return let f=1;in f();}', /not callable/],
  ['int main(){return (let x=1;in x)();}', /direct function calls only/],
  ['int f(int x){return x;}int main(){return f(let x=true;in x);}', /no matching function overload/],
  ['int f(int x){return x;}int main(){return let x=1;in f();}', /no matching function overload/],
  ['int f(int x){return x;}int main(){return let x=1;in f(x,2);}', /no matching function overload/],
  ['int f(int x){return x;}int f(const int x){return x;}int main(){return 0;}', /duplicate function signature/],
  ['int f(int x,int x){return x;}int main(){return 0;}', /duplicate local declaration/],
  ['int f(int x){int x=0;return x;}int main(){return 0;}', /duplicate local declaration/],
  ['int main(){int x=0;int x=1;return x;}', /duplicate local declaration/],
  ['int main(){if(false){let x=missing;in x;}return 0;}', /unknown local variable or constant/],
  ['int main(){bool x=false&&(let n=missing;in true);return 0;}', /unknown local variable or constant/],
  ['int main(){return 0;let x=1;in x=2;}', /cannot modify const binding/],
  ['int main(){return let x=1;in (let y=2;in y)=3;}', /assignment requires/],
  ['int main(){return let x:void=1;in 42;}', /let binding type must be int or bool/],
  ['void f(){}int main(){return let x=f();in 42;}', /let binding type must be int or bool/],
  ['void f(){}int main(){let in f();return 42;}', /let body must have int or bool type/],
  ['int main(){return let x:byte=byte(1);in 42;}', /let binding type must be int or bool/],
  ['int main(){return let in "text";}', /let body must have int or bool type/],
  ['const int value=let x=1;in x;int main(){return value;}', /not a compile-time constant expression/],
  ['int main(){int data[let x=1;in x];return 0;}', /not a compile-time constant expression/],
  ['int main(){return let x=1 in x;}', /expected ';' after let binding initializer/],
  ['int main(){return let x 1;in x;}', /expected '=' after let binding/],
  ['int main(){return let x=1;}', /expected let binding name or 'in'/],
  ['int main(){return let var in 1;}', /expected let binding name or 'in'/],
  ['int main(){return let x=1;in;}', /expected expression/],
  ['int main(){return let x:=1;in x;}', /expected Stage 0 type/],
  ['int main(){return let x=1;in let=2;}', /expected let binding name or 'in'/],
  ['int main(){return let x=1;in true==1;}', /equality requires matching scalar types/],
  ['int main(){let in 42;}', /not all control-flow paths return/],
  ['int main(int x){return let in x;}', /entry point must have signature int main/],
  ['bool main(){return let in true;}', /entry point must have signature int main/],
  ['int f(){return let in 42;}', /missing entry point/],
  ['int main(){return 0;}int main(){return let in 42;}', /duplicate function signature/],
  ['int main(){return if true then 42 else 0;}', /expected expression/],
  ['answer:int=42;int main(){return answer;}', /expected function name/],
  ['Point=record{x:int;};int main(){return 0;}', /expected function name/],
]) rejected(body, message, {}, marker);

// Keep the existing frontend and VM budgets, not Stage 1's separate syntax limits.
const bindings = count => Array.from({ length: count }, (_, n) => `x${n}=${n};`).join('');
program(`int main(){return let ${bindings(1024)}in x1023;}`, 255);
rejected(`int main(){return let ${bindings(1025)}in 42;}`, /too many local slots/);
program(`int main(){return ${'let in '.repeat(253)}42;}`);
rejected(`int main(){return ${'let in '.repeat(254)}42;}`, /nesting limit exceeded/);
rejected(`int main(){return let x=1;in ${'1+'.repeat(300)}x;}`, /nesting limit exceeded/);

const example = resolve(root, 'examples/replacement/answer.l');
const manifest = resolve(root, 'examples/replacement/package.json');
command(0, ['check', example, '--manifest', manifest]);
const exampleOutput = resolve(work, 'example.lbc');
command(0, ['compile', example, '--manifest', manifest, '-o', exampleOutput]);
command(42, ['run', exampleOutput]);
assert.match(command(65, ['check', example]).stderr, /requires an explicit --manifest/);
console.log(`replacement execution: ${fixtures} fixtures, ${commands} CLI checks passed (bytecode 1.9)`);
