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

// Conditional results use real control flow: only the selected branch executes.
program('int main(){return if true then 42 else 1/0;}');
program('int main(){return if false then 1/0 else 42;}');
program('int main(){return if true then if false then 0 else 42 else 1/0;}');
program('int main(){return if false then 1/0 else if true then 42 else 0;}');
program('int main(){return if if true then false else true then 0 else 42;}');
program('int main(){return 1+if true then 41 else 0;}');
program('int main(){return (if false then 0 else 20)+22;}');
program('int main(){return if true then 40 else 0+2;}', 40);
program('int main(){return if false then 0 else 40+2;}');
program('int main(){return let x=if true then 40 else 0;in x+2;}');
program('int main(){return if true then let x=40;in x+2 else let x=0;in x;}');
program('int main(){int n=0;return if (n=n+1)==1 then n+41 else 0;}');
program('int main(){int n=0;int value=if n++==0 then n++ else 1/0;return value+n+39;}');
program('int main(){int n=0;int value=if n++!=0 then 1/0 else n++;return value+n+39;}');
program('int main(){int x=0;return if let n=x++;in n==0 then x+41 else 0;}');
program('bool choose(bool active){return if active then true else false;}int main(){if(choose(true))return 42;return 0;}');
program('int f(int value){return value;}int f(bool value){if(value)return 42;return 0;}int main(){return f(if true then true else false);}');
program('int f(int a,int b){return a*10+b;}int main(){int n=3;return f(if n++==3 then n else 0,n)+(-2);}');
program('int main(){int n=0;(if true then n=42 else n=1);return n;}');
program('int main(){bool active=if true then true else false;bool value=active&&(if false then false else true);if(value)return 42;return 0;}');
program('int main(){int n=0;bool skip=false&&(if n++==0 then true else false);return n+42;}');
program('int main(){int n=0;while(if n<2 then true else false){n++;}return n+40;}');
program('int main(){int total=0;for(int i=0;if i<3 then true else false;i++){total=total+(if i==1 then 14 else 14);}return total;}');
program('int main(){if(true){if(false)return 0;else return if true then 42 else 0;}return 0;}');
program('int main(){return if true then -2147483648 else 2147483647;}', 0);
program('int main(){return if false then -2147483648 else 2147483647;}', 255);
program('int main(){return if true then 1/0 else 42;}', 70, {}, /division by zero/);
program('int main(){return if false then 42 else 2147483647+1;}', 70, {}, /integer overflow/);
program('int main(){return if 1/0==0 then 42 else 0;}', 70, {}, /division by zero/);

// File constants are checked/folded before lowering, never runtime initializers.
const folded = program('pub answer:int=base+2;base:int=40;ready:bool=answer==42;int main(){return if ready then answer else 0;}');
const foldedIR = spawnSync(compiler, ['inspect', folded.input, '--manifest', folded.manifest], { encoding: 'utf8', timeout: 30000 });
assert.ifError(foldedIR.error); assert.equal(foldedIR.status, 0, foldedIR.stderr);
assert.equal(foldedIR.stderr, ''); assert.doesNotMatch(foldedIR.stdout, /^global /m, 'constants must not allocate VM global storage');
++commands;
program('answer /*name*/ : /*type*/ int /*value*/ = 42;int main(){return answer;}');
program('ready:bool=!false&&true;answer:int=6*7;int main(){if(ready)return answer;return 0;}');
program('const int base=40;answer:int=base+2;int main(){return answer;}');
program('answer:int=base+2;const int base=40;int main(){return answer;}');
program('const bool legacy=ready;ready:bool=answer==42;answer:int=42;int main(){if(legacy)return answer;return 0;}');
program('using Count=int;using Flag=bool;answer:Count=42;ready:Flag=true;int main(){if(ready)return answer;return 0;}');
program('namespace n{pub answer:int=base+2;}base:int=40;int main(){return n::answer;}');
program('namespace n{pub answer:int=base+2;}namespace n{base:int=40;}int main(){return n::answer;}');
program('answer:int=42;int f(int answer){return answer;}int main(){int answer=40;return f(answer)+2;}');
program('answer:int=42;int read(){return answer;}int main(){return let answer=read()-2;in answer+2;}');
program('answer:int=42;static int value=answer;int main(){return value;}');
program('int main(){return answer;}answer:int=42;');
program('min:int=-2147483648;max:int=2147483647;int main(){return min+max+43;}');
program('answer:int=-2147483648;int main(){return answer;}', 0);
program('answer:int=2147483647;int main(){return answer;}', 255);
program('safe:bool=false&&(1/0==0);int main(){if(safe)return 0;return 42;}');
program('safe:bool=true||(2147483647+1==0);int main(){if(safe)return 42;return 0;}');
program('width:int=2;int main(){int values[width];values[1]=42;return values[width-1];}');
program('answer:int=6*7;int main(){switch(answer){case answer:return 42;default:return 0;}}');
const constantLibrary = 'module app.values;hidden:int=40;pub answer:int=hidden+2;pub ready:bool=answer==42;pub using Count=int;';
program('import app.values as v;int main(){return if v::ready then v::answer else 0;}', 42, { 'values.l': constantLibrary });
program('import app.values::{answer as result,ready};int main(){if(ready)return result;return 0;}', 42, { 'values.l': constantLibrary });
program('import app.values as v;answer:v::Count=v::answer;int main(){return answer;}', 42, { 'values.l': constantLibrary });
rejected('import app.values as v;answer:int=v::hidden;int main(){return answer;}', /inaccessible symbol/, { 'values.l': constantLibrary });
rejected('import app.values::{hidden};int main(){return 0;}', /inaccessible symbol/, { 'values.l': constantLibrary });
rejected('import app.values as v;int main(){v::answer=0;return 0;}', /cannot modify module constant/, { 'values.l': constantLibrary });

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
  ['int main(){return if true 42 else 0;}', /expected 'then' after conditional expression condition/],
  ['answer=42;int main(){return answer;}', /expected function name/],
  ['Point=record{x:int;};int main(){return 0;}', /expected function name/],
]) rejected(body, message, {}, marker);

for (const [body, message, marker] of [
  ['int main(){return if 1 then 42 else 0;}', /expected bool, got int/],
  ['int main(){return if true then 42 else false;}', /expected int, got bool/, 'false'],
  ['int main(){return if false then true else 42;}', /expected bool, got int/],
  ['int main(){return if true then 42 else missing;}', /unknown local variable or constant/, 'missing'],
  ['int main(){return if false then missing() else 42;}', /unknown function/],
  ['int main(){const int n=0;return if true then 42 else n++;}', /cannot modify const binding/],
  ['int main(){return if true then 42 else let n=0;in n=1;}', /cannot modify const binding/],
  ['int f(int n){return n;}int main(){return if true then 42 else f(false);}', /no matching function overload/],
  ['int main(){return if true then (let n=42;in n) else n;}', /unknown local variable or constant/],
  ['int main(){int n=if true then (let x=1;in x) else 0;return x;}', /unknown local variable or constant/],
  ['int main(){return if (let n=true;in n) then 42 else n;}', /unknown local variable or constant/],
  ['int main(){return (if true then 1 else 0)=42;}', /assignment requires/],
  ['int main(){return (if true then 1 else 0)++;}', /assignment requires/],
  ['void f(){}int main(){(if true then f() else f());return 0;}', /conditional branches must have int or bool type/],
  ['int main(){return if true then byte(1) else byte(2);}', /conditional branches must have int or bool type/],
  ['int main(){return if true then "a" else "b";}', /conditional branches must have int or bool type/],
  ['const int n=if true then 42 else 0;int main(){return n;}', /conditional is not a compile-time constant expression/],
  ['int main(){int data[if true then 1 else 2];return 0;}', /conditional is not a compile-time constant expression/],
  ['int main(){return if true then 42;}', /expected 'else' after conditional expression true branch/],
  ['int main(){return if true then else 42;}', /expected expression/],
  ['int main(){return if true then 42 else;}', /expected expression/],
  ['int main(){if true then 42 else 0;return 0;}', /expected '\(' before condition/],
  ['int main(){return if true then 42 else (1+);}', /expected expression/],
  ['int main(){if(false){return if true then false else 1;}return 42;}', /expected bool, got int/],
]) rejected(body, message, {}, marker);
rejected('import app.math as m;int main(){return if true then 42 else m::hidden();}', /inaccessible symbol/, { 'math.l': library });

for (const [body, message, marker] of [
  ['answer:int=true;int main(){return answer;}', /expected int, got bool/],
  ['ready:bool=1;int main(){return 0;}', /expected bool, got int/],
  ['answer:int=missing;int main(){return answer;}', /unknown local variable or constant/, 'missing'],
  ['answer:int=42;answer:int=0;int main(){return answer;}', /duplicate module constant/],
  ['const int answer=42;answer:int=0;int main(){return answer;}', /duplicate module constant/],
  ['answer:int=42;const int answer=0;int main(){return answer;}', /duplicate module constant/],
  ['answer:int=42;static int answer=0;int main(){return answer;}', /duplicate module constant/],
  ['answer:int=42;int answer(){return 0;}int main(){return 0;}', /conflicts with function declaration/],
  ['answer:int=42;namespace answer{}int main(){return 0;}', /conflicts with namespace declaration/],
  ['using answer=int;answer:int=42;int main(){return 0;}', /type alias conflicts with module constant/],
  ['answer:int=42;int main(){answer=0;return answer;}', /cannot modify module constant/],
  ['answer:int=42;int main(){return answer++;}', /cannot modify module constant/],
  ['answer:int=42;int main(){return answer--;}', /cannot modify module constant/],
  ['answer:int=42;int main(){return answer();}', /module constant is not callable/],
  ['answer:int=answer;int main(){return answer;}', /constant dependency cycle detected/],
  ['answer:int=base;base:int=answer;int main(){return answer;}', /app::main::answer -> app::main::base -> app::main::answer/],
  ['answer:int=base;const int base=answer;int main(){return answer;}', /constant dependency cycle detected/],
  ['answer:int=2147483648;int main(){return answer;}', /integer literal exceeds int range/],
  ['answer:int=2147483647+1;int main(){return answer;}', /invalid constant expression: integer overflow/],
  ['answer:int=1/0;int main(){return answer;}', /invalid constant expression: division by zero/],
  ['answer:int=-2147483648/-1;int main(){return answer;}', /invalid constant expression: integer overflow/],
  ['ready:bool=false&&unknown;int main(){return 0;}', /unknown local variable or constant/],
  ['static int value=42;answer:int=value;int main(){return answer;}', /mutable static storage is not a constant expression/],
  ['answer:int=f();int f(){return 42;}int main(){return answer;}', /function call is not a constant expression/],
  ['answer:int=f();int f(){while(true){}return 0;}int main(){return 0;}', /function call is not a constant expression/],
  ['answer:int=let x=42;in x;int main(){return answer;}', /let is not a compile-time constant expression/],
  ['answer:int=if true then 42 else 0;int main(){return answer;}', /conditional is not a compile-time constant expression/],
  ['answer:auto=42;int main(){return 0;}', /name-first constant type must be int or bool/],
  ['answer:void=42;int main(){return 0;}', /name-first constant type must be int or bool/],
  ['answer:byte=byte(42);int main(){return 0;}', /name-first constant type must be int or bool/],
  ['answer:string="42";int main(){return 0;}', /name-first constant type must be int or bool/],
  ['using Text=string;answer:Text="42";int main(){return 0;}', /name-first constant type must be int or bool/],
  ['struct Box{int x;};answer:Box=Box{42};int main(){return 0;}', /name-first constant type must be int or bool/],
  ['enum Kind{A};answer:Kind=Kind::A;int main(){return 0;}', /name-first constant type must be int or bool/],
  ['answer:Missing=42;int main(){return 0;}', /unknown local variable or constant/],
  ['answer:int;int main(){return 0;}', /module constants require a scalar initializer/],
  ['answer:int=;int main(){return 0;}', /expected expression/],
  ['answer:int=42 int main(){return 0;}', /expected ';' after module constant/],
  ['answer:=42;int main(){return 0;}', /expected Stage 0 type/],
  ['answer:int[2];int main(){return 0;}', /module constants require a scalar initializer/],
  ['static answer:int=42;int main(){return 0;}', /expected static storage name/],
  ['extern answer:int=42;int main(){return 0;}', /expected function name/],
  ['pub const answer:int=42;int main(){return 0;}', /expected module constant name/],
  ['int main(){answer:int=42;return answer;}', /expected ';' after expression/],
  ['name::answer:int=42;int main(){return 0;}', /expected function name/],
  ['answer', /expected function name/],
  ['answer:', /expected Stage 0 type/],
  ['answer:int=', /expected expression/],
]) rejected(body, message, {}, marker);
rejected('import app.values as v;answer:int=v::ready;int main(){return answer;}', /expected int, got bool/, { 'values.l': constantLibrary });

// Replacement aliases reuse transparent scalar resolution, not nominal/runtime types.
program('pub Count=alias Value;Value=alias int;Flag=alias bool;answer:Count=42;ready:Flag=true;Count id(const Count n){return n;}int main(){return if ready then (let n:Count=id(answer);in n) else 0;}');
program('Count /*name*/ = /*keyword*/ alias /*target*/ int;int main(){Count n=42;return n;}');
program('Count=alias Legacy;using Legacy=int;int main(){Count n=42;return n;}');
program('using Legacy=Count;Count=alias int;Legacy main(){return 42;}');
program('namespace n{pub Count=alias Base;}namespace n{using Base=int;}int main(){n::Count n=42;return n;}');
program('alias=alias int;int main(){alias value=42;return value;}');
program('using alias=int;Count=alias alias;int main(){Count alias=42;return alias;}');
program('int alias(int n){return n;}int main(){int alias=40;return alias+2;}');
program('namespace alias{pub Count=alias int;}int main(){alias::Count value=42;return value;}');
program('Count=alias int;int main(){Count n=0;for(Count i=0;i<3;i++)n=n+14;return n;}');
program('Count=alias int;Flag=alias bool;int main(){Count values[2];Flag ready[2];values[1]=42;ready[1]=true;return if ready[1] then values[1] else 0;}');
program('Count=alias int;answer:Count=42;static Count cell=answer;Count get(){return cell++;}int main(){return get();}');
program('Octet=alias byte;Text=alias string;const Text text="*";static Octet cell=text[0];Octet id(Octet n){return n;}int main(){return int(id(cell));}');
program('Count=alias int;struct Pair{Count value;};Pair id(Pair p){return p;}int main(){return id(Pair{42}).value;}');
const aliasLibrary = 'module app.types;Internal=alias int;pub Count=alias Internal;pub Flag=alias bool;pub answer:Count=42;';
for (const [imports, type, value] of [
  ['import app.types;', 'app::types::Count', 'app::types::answer'],
  ['import app.types as t;', 't::Count', 't::answer'],
  ['import app.types::{Count as C,answer};', 'C', 'answer'],
]) program(`${imports}Result=alias ${type};Result id(Result n){return n;}int main(){return id(${value});}`, 42, { 'types.l': aliasLibrary });
for (const [body, message, marker] of [
  ['Count=alias void;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['Count=alias auto;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['struct Pair{int x;};Count=alias Pair;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['enum Kind{A};Count=alias Kind;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['Count=alias Missing;int main(){return 0;}', /unknown local variable or constant/, 'Missing'],
  ['Count=alias int;Count=alias int;int main(){return 0;}', /duplicate type alias declaration/],
  ['using Count=int;Count=alias int;int main(){return 0;}', /duplicate type alias declaration/],
  ['Count=alias int;using Count=int;int main(){return 0;}', /duplicate type alias declaration/],
  ['Count=alias int;Count:int=42;int main(){return 0;}', /type alias conflicts with module constant/],
  ['Count=alias int;static int Count=42;int main(){return 0;}', /type alias conflicts with module constant/],
  ['Count=alias int;int Count(){return 0;}int main(){return 0;}', /type alias conflicts with function/],
  ['Count=alias int;namespace Count{}int main(){return 0;}', /type alias conflicts with namespace/],
  ['Count=alias int;struct Count{int x;};int main(){return 0;}', /type alias conflicts with struct/],
  ['Count=alias int;int f(Count n){return n;}int f(int n){return n;}int main(){return 0;}', /duplicate function signature/],
  ['Count=alias int;int main(){return Count;}', /type alias is not a value/],
  ['Count=alias int;int main(){return Count(42);}', /type alias is not callable/],
  ['Count=alias int;int main(){Count n=true;return n;}', /expected int, got bool/],
  ['Flag=alias bool;Flag main(){return true;}', /entry point must have signature/],
  ['Count=alias int;int main(){int Count=0;Count n=42;return n;}', /local binding/],
  ['Count=alias int;int main(){const Count n=0;n=42;return n;}', /cannot modify const binding/],
  ['Count=alias int;answer:Count=42;int main(){answer++;return 0;}', /cannot modify module constant/],
  ['Text=alias string;answer:Text="42";int main(){return 0;}', /name-first constant type must be int or bool/],
  ['int f(){return 0;}Count=alias f;int main(){return 0;}', /declaration is not a type alias/],
  ['value:int=42;Count=alias value;int main(){return 0;}', /declaration is not a type alias/],
  ['Count=alias Count;int main(){return 0;}', /app::main::Count -> app::main::Count/],
  ['Count=alias Other;using Other=Count;int main(){return 0;}', /app::main::Count -> app::main::Other -> app::main::Count/],
  ['Count=alias int[2];int main(){return 0;}', /expected ';' after type alias/],
  ['Count=alias int();int main(){return 0;}', /expected ';' after type alias/],
  ['Count=alias const int;int main(){return 0;}', /expected Stage 0 type/],
  ['Count=alias int int main(){return 0;}', /expected ';' after type alias/],
  ['Count=alias;int main(){return 0;}', /expected Stage 0 type/],
  ['Count=alias', /expected Stage 0 type/],
  ['Count=', /expected function name/],
  ['Count=other int;int main(){return 0;}', /expected function name/],
  ['Count=aliases int;int main(){return 0;}', /expected function name/],
  ['Count="alias" int;int main(){return 0;}', /expected function name/],
  ['n::Count=alias int;int main(){return 0;}', /expected function name/],
  ['static Count=alias int;int main(){return 0;}', /expected static storage name/],
  ['int main(){Count=alias int;return 0;}', /expected ';' after expression/],
]) rejected(body, message, {}, marker);
for (const [body, message] of [
  ['import app.types as t;Count=alias t::Internal;int main(){return 0;}', /inaccessible symbol/],
  ['import app.types::{Internal};int main(){return 0;}', /inaccessible symbol/],
  ['import app.types as t;t=alias int;int main(){return 0;}', /module alias conflicts/],
]) rejected(body, message, { 'types.l': aliasLibrary });
const erasedAliasSource = 'Int=alias int;Bool=alias bool;Byte=alias byte;String=alias string;\n'
  + 'Int id(Int n){return n;}int main(){Bool b=true;Byte x=byte(42);String s="*";return if b then id(int(x))+s.length-1 else 0;}';
const aliasErased = program(erasedAliasSource);
const aliasLegacy = program(erasedAliasSource.replace(/(\w+)=alias (\w+);/g, 'using $1=$2;'));
const aliasPrimitive = program(erasedAliasSource.replace(/\w+=alias \w+;/g, text => ' '.repeat(text.length))
  .replace(/\bInt\b/g, 'int').replace(/\bBool\b/g, 'bool').replace(/\bByte\b/g, 'byte').replace(/\bString\b/g, 'string'));
for (const f of [aliasLegacy, aliasPrimitive]) assert.deepEqual(readFileSync(resolve(f.directory, 'answer.lbc')),
  readFileSync(resolve(aliasErased.directory, 'answer.lbc')), 'aliases must erase to identical bytecode, not runtime types');

// Keep the existing frontend and VM budgets, not Stage 1's separate syntax limits.
const bindings = count => Array.from({ length: count }, (_, n) => `x${n}=${n};`).join('');
program(`int main(){return let ${bindings(1024)}in x1023;}`, 255);
rejected(`int main(){return let ${bindings(1025)}in 42;}`, /too many local slots/);
program(`int main(){return ${'let in '.repeat(253)}42;}`);
rejected(`int main(){return ${'let in '.repeat(254)}42;}`, /nesting limit exceeded/);
rejected(`int main(){return let x=1;in ${'1+'.repeat(300)}x;}`, /nesting limit exceeded/);
program(`int main(){return ${'if true then '.repeat(253)}42${' else 0'.repeat(253)};}`);
rejected(`int main(){return ${'if true then '.repeat(254)}42${' else 0'.repeat(254)};}`, /nesting limit exceeded/);
program(`int main(){return let ${bindings(1023)}in if true then x1022 else 0;}`, 254);
rejected(`int main(){return let ${bindings(1024)}in if true then 42 else 0;}`, /too many LIR slots/);
const constants = count => Array.from({ length: count }, (_, n) => `c${n}:int=${n};`).join('');
program(`${constants(1024)}int main(){return c1023;}`, 255);
program(`${constants(1023)}const int tail=42;int main(){return tail;}`);
rejected(`${constants(1025)}int main(){return 0;}`, /too many module constants/);
rejected(`${constants(1024)}const int tail=0;int main(){return 0;}`, /too many module constants/);
rejected(`import app.values;${constants(512)}int main(){return 0;}`, /too many module constants across modules/,
  { 'values.l': `module app.values;${constants(513)}` });
const constantChain = count => Array.from({ length: count }, (_, n) => `c${n}:int=${n + 1 < count ? `c${n + 1}` : '42'};`).join('');
program(`${constantChain(128)}int main(){return c0;}`);
rejected(`${constantChain(129)}int main(){return c0;}`, /nesting limit/);
const aliases = count => Array.from({ length: count }, (_, n) => `A${n}=alias int;`).join('');
program(`${aliases(1024)}A1023 main(){return 42;}`);
program(`${aliases(1023)}using Last=int;Last main(){return 42;}`);
rejected(`${aliases(1025)}int main(){return 0;}`, /too many type aliases/);
rejected(`${aliases(1024)}using Last=int;int main(){return 0;}`, /too many type aliases/);
rejected(`import app.types;${aliases(512)}int main(){return 0;}`, /too many type aliases across modules/,
  { 'types.l': `module app.types;${aliases(512)}using Last=int;` });
const aliasChain = count => Array.from({ length: count }, (_, n) => `A${n}=alias ${n + 1 < count ? `A${n + 1}` : 'int'};`).join('');
program(`${aliasChain(256)}A0 main(){return 42;}`);
rejected(`${aliasChain(257)}int main(){return 0;}`, /nesting limit/);

const example = resolve(root, 'examples/replacement/answer.l');
const manifest = resolve(root, 'examples/replacement/package.json');
command(0, ['check', example, '--manifest', manifest]);
const exampleOutput = resolve(work, 'example.lbc');
command(0, ['compile', example, '--manifest', manifest, '-o', exampleOutput]);
command(42, ['run', exampleOutput]);
const choose = resolve(root, 'examples/replacement/choose.l'), chooseOutput = resolve(work, 'choose.lbc');
command(0, ['compile', choose, '--manifest', manifest, '-o', chooseOutput]);
command(0, ['check', chooseOutput]);
command(42, ['run', chooseOutput]);
const constantsExample = resolve(root, 'examples/replacement/constants.l'), constantsOutput = resolve(work, 'constants.lbc');
command(0, ['compile', constantsExample, '--manifest', manifest, '-o', constantsOutput]);
command(0, ['check', constantsOutput]);
command(42, ['run', constantsOutput]);
const aliasExample = resolve(root, 'examples/replacement/aliases.l'), aliasOutput = resolve(work, 'aliases.lbc');
command(0, ['compile', aliasExample, '--manifest', manifest, '-o', aliasOutput]);
command(0, ['check', aliasOutput]);
command(42, ['run', aliasOutput]);
assert.match(command(65, ['check', example]).stderr, /requires an explicit --manifest/);
console.log(`replacement execution: ${fixtures} fixtures, ${commands} CLI checks passed (bytecode 1.9)`);
