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

// Nix-style definitions are typed direct functions, not closures or partial applications.
const nixMain = expression => `main:()->int;main=${expression};`;
const nixAdd = 'pub add:int->int->int;add=a:b:a+b;';
program(nixAdd + 'main:()->int;main=do{return add 20 22;};');
program(nixAdd + nixMain('add 20 22'));
for (const call of ['add(20)(22)', 'add (20) (22)', '(add) 20 22', 'add /* first */ 20\n/* second */ 22'])
  program(nixAdd + nixMain(call));
program(nixAdd + nixMain('add 10 10*2+2'));
program(nixAdd + nixMain('add (10*2) (11*2)'));
program('id:int->int;id=x:x;' + nixMain('-id (-42)'));
program('id:int->int;id=x:x;' + nixMain('id (+42)'));
program('not:bool->bool;not=x:!x;' + nixMain('if not false && not (!true) then 42 else 0'));
program('id:bool->bool;id=x:x;' + nixMain('if id true then 42 else 0'));
program('id:string->string;id=x:x;' + nixMain('(id "a\\0\\xff").length+39'));
program('id:byte->byte;id=x:x;' + nixMain('int(id byte(42))'));
program('id:byte->byte;id=x:x;' + nixMain('int(id (byte(42)))'));
program('id:int->int;id=x:x;' + nixMain('id int(byte(42))'));
program(nixAdd + 'one:()->int;one=1;' + nixMain('add (one ()) 41'));
program('one:()->int;one=42;' + nixMain('one()'));
program('one:()->int;one=42;' + nixMain('one /* no arguments */ ()'));
program('int old(int x,int y){return x+y;}' + nixMain('old 20 22'));
program(nixAdd + 'int main(){return add(20,22);}');
program('void old(){}nop:()->void;nop=old ();main:()->int;main=do{nop ();return 42;};');
program('nop:int->void;nop=x:do{x++;return;};main:()->int;main=do{nop 1;return 42;};');
program('noop:int->void;noop=x:do{};main:()->int;main=do{noop 1;return 42;};');
program('fact:int->int;fact=n:if n<2 then 1 else n*fact (n-1);' + nixMain('fact 4+18'));
program('even:int->bool;even=n:if n==0 then true else odd (n-1);'
  + 'odd:int->bool;odd=n:if n==0 then false else even (n-1);' + nixMain('if even 8 then 42 else 0'));
program('choose:int->int;choose=x:x;choose:bool->int;choose=x:if x then 42 else 0;' + nixMain('choose true'));
program('Count=alias int;add:Count->Count->Count;add=a:b:a+b;' + nixMain('let n:Count=20;in add n 22'));
program('n=namespace{pub Count=alias int;pub id:Count->Count;id=x:x;};' + nixMain('n::id 42'));
program('Kind=enum{Low;High;};id:Kind->Kind;id=x:x;' + nixMain('if id Kind::High==Kind::High then 42 else 0'));
program('Pair=record{x:int;y:int;};copy:Pair->Pair;copy=p:let var q=p;ignored=(q.x=0);in q;'
  + 'main:()->int;main=do{Pair p=Pair{x=42;y=1;};Pair q=copy p;return if q.x==0 then p.x else 0;};');
program('Pair=record{x:int;};id:Pair->Pair;id=p:p;' + nixMain('(id Pair{x=42;}).x'));
program('id:int->int;id=x:x;' + nixMain('let a=40;in id (let b=a+2;in b)'));
program('id:int->int;id=x:x;' + nixMain('id (if false then 1/0 else 42)'));
program('static int n=3;next:()->int;next=n++;pair:int->int->int;pair=a:b:a*10+b;'
  + nixMain('pair (next ()) (next ())+8'));
program('pair:int->int->int;pair=a:b:a*10+b;main:()->int;main=do{int n=3;return pair n++ n+++8;};');
program('static int n=0;take:int->int;take=x:do{n++;return x;};'
  + nixMain('if true then take 42 else take (1/0)'));
program('f:int->int;f=x:x;main:()->int;main=do{int x=0;for(int i=f 0;i<f 3;i++){x=x+f 14;}return x;};');
program('f:int->int;f=x:x;main:()->int;main=do{int x=0;while(f x<3)x++;return x+39;};');
program('f:int->int;f=x:x;main:()->int;main=do{int a[1];a[0]=42;return f a[0];};');
program('f:int->int;f=x:x;main:()->int;main=do{int x=42;f x;return x;};');
program('main:()->int;main=do{var x=40;x++;return x+1;};');
program('main:()->int;main=do{var x:int=40;x=x+2;return x;};');
program('main:()->int;main=do{var flag=false;flag=!flag;if(flag)return 42;return 0;};');
program('main:()->int;main=do{var text="abc";return text.length+39;};');
program('main:()->int;main=do{var b=byte(41);b=byte(int(b)+1);return int(b);};');
program('main:()->int;main=do{var value=if true then 42 else 1/0;return value;};');
program('main:()->int;main=do{var value=let x=42;in x;return value;};');
program('id:int->int;id=x:x;main:()->int;main=do{var value=id 42;return value;};');
program('Pair=record{x:int;};main:()->int;main=do{var p=Pair{x=40;};p.x++;return p.x+1;};');
program('main:()->int;main=do{var sum=0;for(var i=0;i<3;i++){sum=sum+14;}return sum;};');
program('main:()->int;main=do{var sum=0;for(var i:int=0;i<3;i++){sum=sum+i;}return sum+39;};');
program('main:()->int;main=do{var i=0;while(i<3){i++;}return i+39;};');
program('main:()->int;main=do{var x=40;{var x=x+2;return x;}};');
program('main:()->int;main=do{var x=2;{var x=x+2;}return x+40;};');
program('f:int->int;f=x:do{var y=x+1;return y;};' + nixMain('f 41'));
program('main:()->int;main=do{var x=42;var y=x;x=0;return y;};');
program('main:()->int;main=do{var p=if false then 1/0 else 42;return p;};');
program('main:()->int;main=do{var x=1/0;var y=2147483647+1;return 42;};', 70, {}, /division by zero/);
program('main:()->int;main=do{var x=0;for(var i=0;i<3;i++)x=x+i;return x+39;};');
program('main:()->int;main=do{for(var i=0;;i++)return 42;return 0;};');
for (const [body, message] of [
  ['main:()->int;main=do{var x;return 0;};', /require an initializer/],
  ['main:()->int;main=do{var=42;return 0;};', /expected variable name after 'var'/],
  ['main:()->int;main=do{var x:void=42;return 0;};', /variable cannot have void type/],
  ['main:()->int;main=do{var x:Pair=1;return 0;};', /unknown local variable or constant/],
  ['main:()->int;main=do{var x=true;x=42;return 0;};', /expected bool, got int/],
  ['main:()->int;main=do{var x=1;var x=2;return x;};', /duplicate local declaration/],
  ['main:()->int;main=do{var x=42;const int x=1;return x;};', /duplicate local declaration/],
  ['main:()->int;main=do{var x[1];return 0;};', /array element type|expected '='|cannot have an initializer/],
  ['int main(){var x=42;return x;}', /expected expression|expected Stage 0 type/],
  ['main:()->int;main=let var x=42;in x;var y=1;', /expected ';' after function definition|expected Stage 0 type/],
  ['main:()->int;main=do{var x=42;in x;};', /expected expression|expected ';'/],
  ['var x=42;int main(){return 0;}', /expected Stage 0 type|expected expression/],
]) rejected(body, message);

// Name-first range loops are half-open int ranges lowered to the existing counting loop.
const rangeMain = body => `main:()->int;main=do{${body}};`;
program(rangeMain('var sum=0;for i in 0..3:do{sum=sum+i;}return sum+39;'));
program(rangeMain('var sum=0;for i in 1..7:do{sum=sum+i;}return sum+21;'));
program(rangeMain('for i in 5..2:do{return 1/0;}return 42;'));
program(rangeMain('var sum=0;for i in -3..2:do{sum=sum+i;}return sum+47;'));
program(rangeMain('var sum=0;for i in 0+1..2*2:do{sum=sum+i;}return sum+36;'));
program('static int n=3;' + rangeMain('var sum=0;for i in 0..n++:do{sum=sum+i;}return if n==4&&sum==3 then 42 else 0;'));
program('static int n=0;' + rangeMain('for i in n++..n++:do{}return if n==2 then 42 else 0;'));
program(rangeMain('var sum=0;for i in 0..3:do{if(i==2)continue;sum=sum+14;}return sum+14;'));
program(rangeMain('var sum=0;for i in 0..10:do{if(i==3)break;sum=sum+14;}return sum;'));
program(rangeMain('var total=0;for i in 0..2:do{for j in 0..3:do{total=total+7;}}return total;'));
program(rangeMain('var sum=0;for i in 0..3:do{sum=sum+i;if(i==0)i=1;}return sum+40;'));
program(rangeMain('var i=40;for i in 0..1:do{}return i+2;'));
program('f:int->int;f=x:x;' + rangeMain('var sum=0;for i in f 0..f 3:do{sum=sum+i;}return sum+39;'));
program(rangeMain('var sum=0;var limit=3;for i in 0..limit:do{sum=sum+1;}return sum+39;'));
program(rangeMain('var sum=0;for i in 2147483646..2147483647:do{sum=sum+1;}return sum+41;'));
program(rangeMain('var sum=0;var n=0;while(n<2){for i in 0..2:do{sum=sum+1;}n++;}return sum+38;'));
program(rangeMain('for i in 0..3:do{return 42;}return 0;'));
program('Pair=record{x:int;};' + rangeMain('var p=Pair{x=0;};for i in 0..6:do{p.x=p.x+7;}return p.x;'));
program(rangeMain('var total=0;for i in 0..3:do{var inner=i;total=total+inner;}return total+39;'));
program(rangeMain('var sum=0;for i in 0..3:do{sum=sum+(let k=i;in k);}return sum+39;'));
program(rangeMain('var sum=0;for i in 0..3:do{sum=sum+(if i==0 then 0 else i);}return sum+39;'));
program(rangeMain('var sum=0;for i in 0..3:do{sum=sum+14;}var j=0;for j in 0..1:do{sum=sum+1;}return sum-1;'));
program('static int visits=0;tick:()->int;tick=visits++;' + rangeMain('var sum=0;for i in tick ()..tick ():do{sum=sum+1;}return if visits==2&&sum==1 then 42 else 0;'));
program(rangeMain('for i in 0..0:do{return 1/0;}return 42;'));
program(rangeMain('var sum=0;for i in -2..1:do{sum=sum+7;}return sum+21;'));
for (const [body, message] of [
  ['main:()->int;main=do{for i 0..3:do{}return 0;};', /expected '\('/],
  ['main:()->int;main=do{for i in 0 3:do{}return 0;};', /expected '\.\.'/],
  ['main:()->int;main=do{for i in 0..3 do{}return 0;};', /expected ':'/],
  ['main:()->int;main=do{for i in 0..3:return 0;return 0;};', /expected 'do'/],
  ['main:()->int;main=do{for i in 0..3:other return 0;};', /expected 'do'/],
  ['main:()->int;main=do{for i in true..3:do{}return 0;};', /expected int, got bool/],
  ['main:()->int;main=do{for i in 0..false:do{}return 0;};', /expected int, got bool/],
  ['main:()->int;main=do{for i in "a"..3:do{}return 0;};', /expected int, got string/],
  ['main:()->int;main=do{for i in 0..i:do{}return 0;};', /unknown local variable/],
  ['main:()->int;main=do{for i in 0..3:do{}return i;};', /unknown local variable/],
  ['main:()->int;main=do{for i in 0..3:do{i=true;}return 0;};', /expected int, got bool/],
  ['int main(){for i in 0..3:do{}return 42;}', /expected '\('/],
  ['for i in 0..3:do{}int main(){return 42;}', /expected Stage 0 type|expected expression/],
  ['main:()->int;main=let in for i in 0..3:do{};', /expected expression|expected ';'/],
]) rejected(body, message);
program(rangeMain('for i in 1/0..3:do{}return 42;'), 70, {}, /division by zero/);
program(rangeMain('for i in 0..(2147483647+1):do{}return 42;'), 70, {}, /integer overflow/);
program('do:int->int;do=x:x;' + nixMain('do 42'));
program('id:int->int;id=x:x;' + nixMain('let do=42;in id do'));
program('f:int->int;f=x:do{return x;};int do(int x){return x;}int main(){return do(f(42));}');
program('id:int->int;id=x:x;' + nixMain('id (1/0)'), 70, {}, /division by zero/);
program('pair:int->int->int;pair=a:b:a+b;' + nixMain('pair (1/0) (2147483647+1)'), 70, {}, /division by zero/);
rejected('f:int->int;', /matching function definition/);
for (const [body, message] of [
  ['f:int->int;g=x:x;', /must match preceding signature/],
  ['f:int->int;f x:x;', /expected '='/],
  ['f:int->int;f=42;', /expected parameter name/],
  ['f:int->int;f=x x;', /expected ':' after lambda parameter/],
  ['f:int->int;f=x:x', /expected ';' after function definition/],
  ['f:int->;f=x:x;', /expected Stage 0 type/],
  ['f:(int)->int;f=42;', /zero-parameter signature/],
  ['f:()int;f=42;', /expected '->'/],
  ['f:()->int->int;f=x:x;', /expected ';' after function signature/],
  ['f:int->int f=x:x;', /expected ';' after function signature/],
  ['f:int->int;f=x:y:x;', /expected ';' after function definition/],
  ['f:void->int;f=x:42;', /parameter type/],
  ['f:auto->int;f=x:42;', /parameter type/],
  ['f:int->auto;f=x:x;', /return type must be explicit/],
  ['f:int->int->int;f=x:x:x;', /duplicate local declaration/],
  ['f:int->int;f=x:true;', /expected int, got bool/],
  ['f:int->int;f=x:do{if(x==1)return 1;};', /not all control-flow paths/],
  [nixAdd + nixMain('add 42'), /no matching function overload/],
  [nixAdd + nixMain('add 1 2 3'), /no matching function overload/],
  [nixAdd + nixMain('(add 20) 22'), /direct function calls only/],
  [nixAdd + nixMain('add(20,22)'), /expected '\)'/],
  [nixAdd + nixMain('add true 22'), /no matching function overload/],
  [nixAdd + nixMain('let f=add;in 42'), /declaration is not a scalar constant/],
  [nixMain('let f=x: x;in 42'), /expected ';' after let binding initializer/],
  [nixMain('let x=();in 42'), /expected expression/],
  [nixAdd + nixMain('let add=42;in add 20 22'), /local binding is not callable/],
  [nixMain('42 1'), /direct function calls only/],
  ['one:()->int;one=42;' + nixMain('one () 1'), /direct function calls only/],
  ['one:()->int;one=42;' + nixMain('one'), /declaration is not a scalar constant/],
  ['f:int->int;f=x:x;' + nixMain('f ()'), /no matching function overload/],
  ['f:int->int;f=x:x;' + nixMain('f x'), /unknown local variable or constant/],
  ['P=record{x:int;};id:P->P;id=p:p;main:()->int;main=do{P a[1];return 0;};', /array element type/],
  ['f:int->int;f=x:x;main:()->int;main=do{int a[1];return f a;};', /array used without an index/],
  ['f:int->int;f=x:let y=x;in y;' + nixMain('y'), /unknown local variable or constant/],
  ['main:int->int;main=x:x;', /entry point must have signature/],
  ['main:()->bool;main=true;', /entry point must have signature/],
  ['int f(){return 42;}main:()->int;main=do{int f=0;return f ();};', /local binding is not callable/],
]) rejected(body.includes('main:') ? body : body + '\n' + nixMain('0'), message);
rejected('f:int', /module constants require a scalar initializer/);
rejected('f:int;', /module constants require a scalar initializer/);
rejected('f:', /expected Stage 0 type/);
rejected('f:int->int;other=x:x;', /must match preceding signature/, {}, 'other');
const nixParameters = count => 'int->'.repeat(count) + 'int';
const nixLambdas = count => Array.from({ length: count }, (_, n) => `x${n}:`).join('');
const nixArguments = count => ' 0'.repeat(count);
program(`f:${nixParameters(1024)};f=${nixLambdas(1024)}42;` + nixMain(`f${nixArguments(1024)}`));
rejected(`f:${nixParameters(1025)};f=${nixLambdas(1025)}42;` + nixMain('42'), /too many parameters/);
rejected(`f:${nixParameters(1024)};f=${nixLambdas(1024)}42;` + nixMain(`f${nixArguments(1025)}`), /too many function arguments/);
const nixFunctions = count => Array.from({ length: count }, (_, n) => `f${n}:()->int;f${n}=42;`).join('');
program(nixFunctions(255) + nixMain('f254 ()'));
rejected(nixFunctions(256) + nixMain('42'), /too many functions/);
rejected(nixFunctions(256) + 'int main(){return 42;}', /too many functions/);
rejected(nixFunctions(255) + 'int f(){return 42;}' + nixMain('42'), /too many functions/);
const nixPublicLibrary = 'module app.functions;pub Count=alias int;Hidden=record{x:int;};'
  + 'private:()->int;private=0;'
  + 'work=namespace{pub add:Count->Count->Count;add=a:b:a+b;};';
for (const [imports, call] of [
  ['import app.functions;', 'app::functions::work::add'],
  ['import app.functions as f;', 'f::work::add'],
  ['import app.functions::{work::add as plus};', 'plus'],
]) program(imports + nixMain(`${call} 20 22`), 42, { 'functions.l': nixPublicLibrary });
program('n=namespace{pub Count=alias int;pub f:Count->Count;f=x:x;};'
  + 'main:()->int;main=do{n::Count value=42;n::f value;return n::f value;};');
rejected('import app.functions as f;' + nixMain('f::private ()'), /inaccessible symbol/,
  { 'functions.l': nixPublicLibrary });
rejected('import app.functions as f;id:f::Hidden->int;id=p:p.x;' + nixMain('0'), /inaccessible symbol/,
  { 'functions.l': nixPublicLibrary });
rejected('Hidden=record{x:int;};pub id:Hidden->Hidden;id=p:p;' + nixMain('0'), /public signature exposes a private struct/);
rejected('id:int->int;id=x:x;int id(int x){return x;}' + nixMain('42'), /duplicate function signature/);

// Exact legacy acceptance target (module app.main maps to main.l under the declared root).
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
  ['int main(){return let x:void=1;in 42;}', /let binding type must be scalar or struct/],
  ['void f(){}int main(){return let x=f();in 42;}', /let binding type must be scalar or struct/],
  ['void f(){}int main(){let in f();return 42;}', /let body must have scalar or struct type/],
  ['int main(){return let x:byte=byte(1);in x;}', /expected int, got byte/],
  ['int main(){return let in "text";}', /expected int, got string/],
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
  ['Point=class{x:int;};int main(){return 0;}', /expected function name/],
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
  ['void f(){}int main(){(if true then f() else f());return 0;}', /conditional branches must have scalar or struct type/],
  ['int main(){return if true then byte(1) else byte(2);}', /expected int, got byte/],
  ['int main(){return if true then "a" else "b";}', /expected int, got string/],
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

// Namespace bindings are existing compile-time scopes, never runtime values/initializers.
program('math=namespace{pub Count=alias int;pub answer:Count=base+2;base:int=40;};math=namespace{pub Count get(){return answer;}};int main(){return math::get();}');
program('math /*name*/ = /*keyword*/ namespace /*body*/ {pub int get(){return 42;}};int main(){return math::get();}');
program('empty=namespace{};empty=namespace{};int main(){return 42;}');
program('namespace math{int get(){return answer;}}math=namespace{answer:int=42;};int main(){return math::get();}');
program('math=namespace{int get(){return answer;}};namespace math{const int answer=42;}int main(){return math::get();}');
program('outer=namespace{namespace inner{int get(){return 42;}}};int main(){return outer::inner::get();}');
program('namespace outer{inner=namespace{int get(){return 42;}};}int main(){return outer::inner::get();}');
program('outer=namespace{left=namespace{int get(){return 42;}};right=namespace{int get(){return left::get();}};};int main(){return outer::right::get();}');
program('int get(){return 1;}n=namespace{int get(){return 42;}int run(){return get();}};int main(){return n::run();}');
program('n=namespace{int pick(int n){return n*2;}};n=namespace{int pick(bool n){return if n then pick(21) else 0;}};int main(){return n::pick(true);}');
program('n=namespace{static int cell=40;int next(){return cell++;}};int main(){return n::next()+n::next()-39;}');
program('n=namespace{size:int=2;static int data[size];};n=namespace{int get(){data[1]=42;return data[0]+data[1];}};int main(){return n::get();}');
program('n=namespace{pub struct Pair{int x;};pub enum Kind{Answer=42};};int main(){n::Pair p=n::Pair{42};n::Kind k=n::Kind::Answer;return if k==n::Kind::Answer then p.x else 0;}');
program('alias=namespace{Count=alias int;Count get(){return 42;}};int main(){return alias::get();}');
program('n=namespace{int main(){return 42;}};int main(){return n::main();}');
program('int first(){return n::answer;}n=namespace{answer:int=42;int get(){return answer;}};int last(){return n::get();}int main(){return first()+last()-42;}');
program('n=namespace{int get(){return 1/0;}};int main(){return if true then 42 else n::get();}');
program('n=namespace{minimum:int=-2147483648;int get(){return minimum/-1;}};int main(){return n::get();}', 70, {}, /integer overflow/);
const namespaceLibrary = 'module app.scopes;math=namespace{Internal=alias int;pub Count=alias Internal;'
  + 'base:int=40;pub answer:Count=base+2;pub Count get(){return answer;}int hidden(){return answer;}'
  + 'inner=namespace{pub int get(){return answer;}};};';
for (const [imports, name, type] of [
  ['import app.scopes;', 'app::scopes::math::get', 'app::scopes::math::Count'],
  ['import app.scopes as s;', 's::math::inner::get', 's::math::Count'],
  ['import app.scopes::{math::get as get,math::Count as Count};', 'get', 'Count'],
]) program(`${imports}${type} run(){return ${name}();}int main(){return run();}`, 42, { 'scopes.l': namespaceLibrary });
for (const [body, message, marker] of [
  ['pub math=namespace{};int main(){return 0;}', /namespaces do not change declaration visibility/, 'pub'],
  ['math=namespace{}int main(){return 0;}', /expected ';' after namespace binding/],
  ['math=namespace{', /expected '}' after namespace/],
  ['math=namespace', /expected '{' after namespace name/],
  ['math=namespace;', /expected '{' after namespace name/],
  ['math=namespace{};;int main(){return 0;}', /expected Stage 0 type/],
  ['math=namespace{import app.scopes;};int main(){return 0;}', /must precede/],
  ['math=namespace{module app.other;};int main(){return 0;}', /must precede/],
  ['math=namespace{pub nested=namespace{};};int main(){return 0;}', /do not change declaration visibility/],
  ['n=namespace{int main(){return 42;}};', /missing entry point/],
  ['n=namespace{};int main(){return n;}', /declaration is not a scalar constant/],
  ['n=namespace{};int main(){return n();}', /unknown function or qualified declaration/],
  ['n=namespace{};int main(){n value=0;return 0;}', /declaration is not a type alias/],
  ['n=namespace{};value:int=n;int main(){return 0;}', /declaration is not a scalar constant/],
  ['n=namespace{};n:int=42;int main(){return 0;}', /conflicts with namespace declaration/],
  ['n=namespace{};n=alias int;int main(){return 0;}', /conflicts with namespace declaration/],
  ['n=namespace{};int n(){return 0;}int main(){return 0;}', /conflicts with namespace declaration/],
  ['n=namespace{};struct n{int x;};int main(){return 0;}', /conflicts with namespace declaration/],
  ['n=namespace{};enum n{A};int main(){return 0;}', /conflicts with namespace declaration/],
  ['n=namespace{answer:int=42;};namespace n{const int answer=0;}int main(){return 0;}', /duplicate module constant/],
  ['n=namespace{Count=alias int;};n=namespace{using Count=int;};int main(){return 0;}', /duplicate type alias declaration/],
  ['n=namespace{int get(){return 0;}};namespace n{int get(){return 0;}}int main(){return 0;}', /duplicate function signature/],
  ['n=namespace{};int get(){return 42;}int main(){return n::get();}', /unknown function or qualified/],
  ['n=namespace{int get(){return 42;}};int main(){return let n=0;in n::get();}', /local binding is not callable or a namespace/],
  ['n=namespace{int get(){return 42;}};int main(){return get();}', /unknown function/],
  ['n=namespace{int get(){return true;}};int main(){return 0;}', /expected int, got bool/],
  ['n=namespace{answer:int=get();int get(){while(true){}return 0;}};int main(){return 0;}', /function call is not a constant expression/],
  ['int main(){n=namespace{};return 0;}', /expected expression/],
  ['static n=namespace{};int main(){return 0;}', /expected static storage name/],
  ['outer::n=namespace{};int main(){return 0;}', /expected function name/],
]) rejected(body, message, {}, marker);
for (const [body, message] of [
  ['import app.scopes as s;int main(){return s::math::hidden();}', /inaccessible symbol/],
  ['import app.scopes::{math::hidden};int main(){return 0;}', /inaccessible symbol/],
  ['import app.scopes as s;int main(){return s::math::base;}', /inaccessible symbol/],
  ['import app.scopes as s;Count=alias s::math::Internal;int main(){return 0;}', /inaccessible symbol/],
  ['import app.scopes as s;s=namespace{};int main(){return 0;}', /module alias conflicts/],
  ['import app.scopes;int main(){return math::get();}', /no unqualified fallback/],
]) rejected(body, message, { 'scopes.l': namespaceLibrary });
const namespaceSource = 'n=namespace{pub Count=alias int;answer:Count=42;int get(){return answer;}};\n'
  + 'n=namespace{inner=namespace{int get(){return n::get();}};};\nint main(){return n::inner::get();}';
const namespaceNew = program(namespaceSource);
const namespaceOld = program(namespaceSource.replace(/(\w+)=namespace\{/g, 'namespace $1{').replaceAll('};', '} '));
assert.deepEqual(readFileSync(resolve(namespaceNew.directory, 'answer.lbc')), readFileSync(resolve(namespaceOld.directory, 'answer.lbc')),
  'new and legacy namespace scopes must compile to identical position-preserving bytecode');
for (const offset of [16, 20, 24]) assert.equal(readFileSync(resolve(namespaceNew.directory, 'answer.lbc')).readUInt32LE(offset), 0);

// Name-first enums reuse nominal types, checked values and existing switch/storage paths.
program('pub Color=enum{Off;On=42;Same=42;};Color id(const Color c){return c;}int main(){Color c=id(Color::On);switch(c){case Color::Same:return 42;default:return 0;}}');
program('Kind /*name*/ = /*keyword*/ enum /*members*/ {Zero;Answer=6*7;};int main(){return if Kind::Zero!=Kind::Answer then 42 else 0;}');
program('Kind=enum{First=base;Next;Alias=base;};base:int=41;int main(){switch(Kind::Next){case Kind::Alias:return 0;case Kind::Next:return 42;default:return 1;}}');
program('Kind=enum{Low=-2147483648;Next;High=2147483647;};ready:bool=Kind::Low!=Kind::Next;int main(){if(ready&&Kind::High!=Kind::Next)return 42;return 0;}');
program('Kind=enum{Answer=42;};const Kind first=Kind::Answer;static Kind cell=first;Kind pass(Kind c){Kind old=cell;cell=c;return old;}int main(){return if pass(first)==Kind::Answer then 42 else 0;}');
program('n=namespace{pub Kind=enum{Off;On;};};namespace n{pub Kind get(){return Kind::On;}}int main(){return if n::get()==n::Kind::On then 42 else 0;}');
program('enum Old{Answer=42};New=enum{Answer=42;};int score(Old k){return 20;}int score(New k){return 22;}int main(){return score(Old::Answer)+score(New::Answer);}');
program('Kind=enum{Off;On;};struct Box{Kind kind;int value;};Box change(Box b){b.kind=Kind::On;return b;}int main(){Box original=Box{Kind::Off,42};Box copy=change(original);return if original.kind==Kind::Off&&copy.kind==Kind::On then copy.value else 0;}');
program('Kind=enum{Zero;One;Two;};int main(){Kind k=Kind::One;int total=0;switch(k){case Kind::Zero:total=1;case Kind::One:total=total+40;case Kind::Two:total=total+2;}return total;}');
program('Kind=enum{Kind=42;};Kind id(Kind k){return k;}int main(){return if id(Kind::Kind)==Kind::Kind then 42 else 0;}');
const enumLibrary = 'module app.kinds;tokens=namespace{pub Kind=enum{Off;On=42;Alias=42;};};'
  + 'Secret=enum{Hidden;};pub const tokens::Kind first=tokens::Kind::On;pub tokens::Kind id(const tokens::Kind k){return k;}';
for (const [imports, type, value, call] of [
  ['import app.kinds;', 'app::kinds::tokens::Kind', 'app::kinds::tokens::Kind::On', 'app::kinds::id'],
  ['import app.kinds as k;', 'k::tokens::Kind', 'k::tokens::Kind::Alias', 'k::id'],
  ['import app.kinds::{tokens::Kind as K,tokens::Kind::On as on,id};', 'K', 'on', 'id'],
]) program(`${imports}int main(){${type} selected=${call}(${value});return if selected==${value} then 42 else 0;}`, 42, { 'kinds.l': enumLibrary });
for (const [body, message, marker] of [
  ['Kind=enum{};int main(){return 0;}', /enum must have at least one member/],
  ['Kind=enum{A};int main(){return 0;}', /expected ';' after enum member/],
  ['Kind=enum{A,B;};int main(){return 0;}', /expected ';' after enum member/],
  ['Kind=enum{A;;};int main(){return 0;}', /expected enum member name/],
  ['Kind=enum{pub A;};int main(){return 0;}', /expected enum member name/],
  ['Kind=enum{A;}', /expected ';' after enum declaration/],
  ['Kind=enum', /expected '{' after enum name/],
  ['Kind=enum{', /expected enum member name/],
  ['Kind=enum{A=', /expected expression/],
  ['Kind=enum{A;', /expected enum member name/],
  ['Kind=enum{A=missing;};int main(){return 0;}', /unknown local variable or constant/, 'missing'],
  ['Kind=enum{A;A;};int main(){return 0;}', /duplicate enum member name/],
  ['Kind=enum{A;};enum Kind{B};int main(){return 0;}', /duplicate enum declaration/],
  ['enum Kind{A};Kind=enum{B;};int main(){return 0;}', /duplicate enum declaration/],
  ['n=namespace{Kind=enum{A;};};namespace n{enum Kind{B};}int main(){return 0;}', /duplicate enum declaration/],
  ['Kind=enum{A;};Kind:int=42;int main(){return 0;}', /enum conflicts with module constant/],
  ['Kind=enum{A;};Kind=alias int;int main(){return 0;}', /enum conflicts with type alias/],
  ['Kind=enum{A;};struct Kind{int x;};int main(){return 0;}', /enum conflicts with struct/],
  ['Kind=enum{A;};Kind=namespace{};int main(){return 0;}', /enum conflicts with namespace/],
  ['Kind=enum{A;};int Kind(){return 0;}int main(){return 0;}', /enum conflicts with function/],
  ['Kind=enum{A=2147483647;Next;};int main(){return 0;}', /integer overflow/],
  ['Kind=enum{A=2147483647+1;};int main(){return 0;}', /integer overflow/],
  ['Kind=enum{A=-2147483648-1;};int main(){return 0;}', /integer overflow/],
  ['Kind=enum{A=1/0;};int main(){return 0;}', /division by zero/],
  ['Kind=enum{A=true;};int main(){return 0;}', /expected int, got bool/],
  ['Kind=enum{A=byte(0);};int main(){return 0;}', /expected int, got byte/],
  ['Kind=enum{A=Kind::B;B=0;};int main(){return 0;}', /expected int, got enum/],
  ['static int cell=0;Kind=enum{A=cell;};int main(){return 0;}', /mutable static storage is not a constant expression/],
  ['Kind=enum{A=f();};int f(){while(true){}return 0;}int main(){return 0;}', /function call is not a constant expression/],
  ['Kind=enum{A=let x=1;in x;};int main(){return 0;}', /let is not a compile-time constant expression/],
  ['Kind=enum{A=if true then 1 else 0;};int main(){return 0;}', /conditional is not a compile-time constant expression/],
  ['Kind=enum{A;};Count=alias Kind;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['Kind=enum{A;};answer:Kind=Kind::A;int main(){return 0;}', /name-first constant type must be int or bool/],
  ['Kind=enum{A;};int main(){Kind k=0;return 0;}', /expected enum, got int/],
  ['Kind=enum{A;};int main(){int n=Kind::A;return n;}', /expected int, got enum/],
  ['A=enum{X;};B=enum{X;};int main(){return if A::X==B::X then 42 else 0;}', /matching scalar types/],
  ['A=enum{X;};B=enum{X;};int main(){A a=B::X;return 0;}', /expected enum, got enum/],
  ['Kind=enum{A;};Kind main(){return Kind::A;}', /entry point must have signature/],
  ['Kind=enum{A;};int main(){Kind a[1];return 0;}', /array element type/],
  ['Kind=enum{A;};int main(){Kind k=Kind::A;k++;return 0;}', /expected int, got enum/],
  ['Kind=enum{A;};int main(){const Kind k=Kind::A;k=Kind::A;return 0;}', /cannot modify const binding/],
  ['Kind=enum{A;};int main(){Kind::A=Kind::A;return 0;}', /cannot modify module constant/],
  ['Kind=enum{A;};int main(){return Kind;}', /enum type is not a value/],
  ['Kind=enum{A;};int main(){return Kind();}', /enum type is not callable/],
  ['Kind=enum{A;};int main(){switch(Kind::A){case 0:return 42;default:return 0;}}', /expected enum, got int/],
  ['Kind=enum{A;Alias=0;};int main(){switch(Kind::A){case Kind::A:return 42;case Kind::Alias:return 0;}}', /duplicate case value/],
  ['Kind=enum{A;};pub Kind id(Kind k){return k;}int main(){return 0;}', /public interface exposes a private enum type/],
  ['static Kind=enum{A;};int main(){return 0;}', /expected static storage name/],
  ['int main(){Kind=enum{A;};return 0;}', /expected expression/],
  ['n::Kind=enum{A;};int main(){return 0;}', /expected function name/],
]) rejected(body, message, {}, marker);
for (const [body, message] of [
  ['import app.kinds as k;int main(){k::Secret value=k::Secret::Hidden;return 0;}', /inaccessible symbol/],
  ['import app.kinds::{Secret::Hidden};int main(){return 0;}', /inaccessible symbol/],
  ['import app.kinds as k;k=enum{A;};int main(){return 0;}', /module alias conflicts/],
]) rejected(body, message, { 'kinds.l': enumLibrary });
const enumSource = 'pub Kind=enum{Zero;Answer=42;Alias=42;Low=-2147483648;High=2147483647;};\n'
  + 'int main(){Kind k=Kind::Answer;switch(k){case Kind::Alias:return 42;default:return 0;}}';
const enumNew = program(enumSource), enumOld = program(enumSource.replace(/Kind=enum\{([^}]*)\}/,
  (_, members) => `enum Kind{${members.replaceAll(';', ',')}}`));
assert.deepEqual(readFileSync(resolve(enumNew.directory, 'answer.lbc')), readFileSync(resolve(enumOld.directory, 'answer.lbc')),
  'new and legacy enums must produce identical position-preserving bytecode and nominal metadata');
assert.equal(readFileSync(resolve(enumNew.directory, 'answer.lbc')).readUInt32LE(24), 1);

// Named fields are checked without sorting their evaluation order.
program('pub Pair=record{x:int;ready:bool;};int main(){Pair p=Pair{ready=true;x=42;};return if p.ready then p.x else 0;}');
program('Pair /*name*/ = /*keyword*/ record /*fields*/ {x /*field*/ : /*type*/ int;};int main(){return Pair{x=42;}.x;}');
program('int main(){Pair p=Pair{x=42;};return p.x;}Pair=record{x:int;};');
program('record=record{x:int;};int main(){record value=record{x=42;};return value.x;}');
program('int record(int n){return n;}int main(){int record=40;return record+2;}');
program('Pair=record{x:Count;ready:Flag;};Count=alias int;Flag=alias bool;int main(){Pair p=Pair{x=42;ready=true;};return if p.ready then p.x else 0;}');
program('Kind=enum{On;};Packet=record{kind:Kind;octet:byte;text:string;};int main(){Packet p=Packet{text="*";kind=Kind::On;octet=byte(42);};return if p.kind==Kind::On&&p.text.length==1 then int(p.octet) else 0;}');
program('Pair=record{x:int;};Pair change(Pair p){p.x=0;return p;}int main(){Pair original=Pair{x=42;};Pair copy=change(original);return if copy.x==0 then original.x else 0;}');
program('Pair=record{x:int;};int main(){Pair a=Pair{x=42;};Pair b=a;b.x++;return if b.x==43 then a.x else 0;}');
program('Pair=record{x:int;};Pair id(const Pair p){return p;}int main(){return id(Pair{x=42;}).x;}');
program('Pair=record{x:int;};int main(){const int x=42;Pair p=Pair{x=x;};return p.x;}');
program('Pair=record{x:int;};int main(){int x=40;{Pair p=Pair{x=x+2;};if(p.x!=42)return 0;}return x+2;}');
program('Pair=record{x:int;ready:bool;};int main(){Pair p=Pair{ready=(let value=true;in value);x=(if true then 42 else 0);};return if p.ready then p.x else 0;}');
program('Pair=record{x:int;};int main(){Pair p=Pair{x=Pair{x=42;}.x;};return p.x;}');
program('Pair=record{x:int;y:int;};int main(){int n=0;Pair p=Pair{y=n++;x=n++;};return if n==2&&p.y==0&&p.x==1 then 42 else 0;}');
program('Pair=record{x:int;y:int;};int main(){int n=40;Pair p=Pair{y=(n=42);x=n;};return if p.x==42&&p.y==42&&n==42 then 42 else 0;}');
program('Pair=record{x:int;ready:bool;};static int calls=0;int next(){calls++;return 42;}int main(){Pair p=Pair{ready=calls==0;x=next();};return if p.ready&&calls==1 then p.x else 0;}');
program('Pair=record{x:int;y:int;};int pair(Pair a,Pair b){return a.x+a.y+b.x+b.y;}int main(){int n=9;return pair(Pair{y=n++;x=n++;},Pair{x=n++;y=n++;});}');
program('Pair=record{x:int;};int pair(int a,int b){return a+b;}int main(){return pair(Pair{x=20;}.x,Pair{x=22;}.x);}');
program('Pair=record{x:int;y:int;};int main(){int n=0;Pair p=Pair{y=(n=40);x=(n=n+2);};return if p.y==40 then p.x else 0;}');
program('Pair=record{x:int;ready:bool;};int main(){int n=0;Pair p=Pair{ready=false&&((n=1)==1);x=42;};return if !p.ready&&n==0 then p.x else 0;}');
program('n=namespace{pub Pair=record{x:int;};};namespace n{pub Pair get(){return Pair{x=42;};}}int main(){return n::get().x;}');
program('struct Pair{int x;bool ready;};int main(){Pair p=Pair{ready=true;x=42;};return if p.ready then p.x else 0;}');
program('struct Pair{int x;};int main(){int n=0;Pair p=Pair{n=42};return if n==42 then p.x else 0;}');
program('struct Pair{int x;int y;};int main(){int x=0;Pair p=Pair{x=20,x=22};return p.x+p.y;}');
program('struct Pair{int x;};int main(){int n=0;Pair p=Pair{(n=42),};return if n==42 then p.x else 0;}');
program('Pair=record{x:int;};struct Other{int x;};int f(Pair p){return 20;}int f(Other p){return 22;}int main(){return f(Pair{x=0;})+f(Other{0});}');
program('Pair=record{x:int;octet:byte;};int main(){Pair p=Pair{octet=byte(256);x=1/0;};return p.x;}', 70, {}, /byte conversion out of range/);
program('Pair=record{x:int;octet:byte;};int main(){Pair p=Pair{x=1/0;octet=byte(256);};return p.x;}', 70, {}, /division by zero/);
program('Pair=record{x:int;y:int;};int main(){return Pair{x=42;y=1/0;}.x;}', 70, {}, /division by zero/);
const recordLibrary = 'module app.records;Hidden=record{x:int;};pub Pair=record{x:int;ready:bool;};'
  + 'pub Pair make(){return Pair{ready=true;x=42;};}pub Pair id(const Pair p){return p;}';
for (const [imports, type, make, id] of [
  ['import app.records;', 'app::records::Pair', 'app::records::make', 'app::records::id'],
  ['import app.records as r;', 'r::Pair', 'r::make', 'r::id'],
  ['import app.records::{Pair as P,make,id};', 'P', 'make', 'id'],
]) program(`${imports}int main(){${type} p=${id}(${type}{x=${make}().x;ready=true;});return p.x;}`, 42, { 'records.l': recordLibrary });
for (const [body, message, marker] of [
  ['Pair=record{};int main(){return 0;}', /at least one scalar field/],
  ['Pair=record{x:int;x:bool;};int main(){return 0;}', /duplicate struct field/],
  ['Pair=record{x:auto;};int main(){return 0;}', /struct fields must be scalar/],
  ['Pair=record{x:void;};int main(){return 0;}', /struct fields must be scalar/],
  ['Inner=record{x:int;};Outer=record{inner:Inner;};int main(){return 0;}', /struct fields must be scalar/],
  ['Pair=record{x:Missing;};int main(){return 0;}', /unknown local variable or constant/, 'Missing'],
  ['Pair=record{x:int;};struct Pair{int x;};int main(){return 0;}', /duplicate struct declaration/],
  ['Pair=record{x:int;};Pair=alias int;int main(){return 0;}', /type alias conflicts with struct/],
  ['Pair=record{x:int;};Pair:int=0;int main(){return 0;}', /struct conflicts with module constant/],
  ['Pair=record{x:int;};Pair=namespace{};int main(){return 0;}', /struct conflicts with namespace/],
  ['Pair=record{x:int;};Pair=enum{A;};int main(){return 0;}', /enum conflicts with struct/],
  ['Pair=record{x:int;};int Pair(){return 0;}int main(){return 0;}', /struct conflicts with function/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{};return 0;}', /missing record initializer field: x/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=42;};return 0;}', /missing record initializer field: y/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{unknown=42;};return 0;}', /unknown record initializer field/, 'unknown'],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=1;x=2;};return 0;}', /duplicate record initializer field/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=true;};return 0;}', /expected int, got bool/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{42};return 0;}', /record literals require named/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=42};return 0;}', /record literals require named/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=1,y=2;};return 0;}', /cannot mix positional and named/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=1;2};return 0;}', /expected record initializer field name/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=1;y 2;};return 0;}', /expected '=' after record initializer field name/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=1;y=2};return 0;}', /expected ';' after record initializer field/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{42;};return 0;}', /after struct literal/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{n::x=42;};return 0;}', /after struct literal/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{(x)=42;};return 0;}', /after struct literal/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=42;;};return 0;}', /expected record initializer field name/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=x;};return 0;}', /unknown local variable or constant/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{y=x;x=42;};return 0;}', /unknown local variable or constant/],
  ['Pair=record{x:int;};int main(){return if true then 42 else Pair{x=missing;}.x;}', /unknown local variable or constant/],
  ['Pair=record{x:int;y:int;};int main(){Pair p=Pair{x=(let hidden=1;in hidden);y=hidden;};return 0;}', /unknown local variable or constant/],
  ['A=record{x:int;};B=record{x:int;};int main(){A a=B{x=42;};return 0;}', /expected struct, got struct/],
  ['Pair=record{x:int;};int main(){const Pair p=Pair{x=42;};p.x=0;return 0;}', /cannot modify const binding/],
  ['Pair=record{x:int;};void change(const Pair p){p.x++;}int main(){return 0;}', /cannot modify const binding/],
  ['Pair=record{x:int;};int main(){Pair p=Pair{x=42;};return p;}', /expected int, got struct/],
  ['Pair=record{x:int;};Pair main(){return Pair{x=42;};}', /entry point must have signature/],
  ['Pair=record{x:int;};int main(){Pair p[1];return 0;}', /array element type/],
  ['Pair=record{x:int;};Count=alias Pair;int main(){return 0;}', /type alias target must be int or bool or byte or string/],
  ['Pair=record{x:int;};answer:Pair=Pair{x=42;};int main(){return 0;}', /name-first constant type must be int or bool/],
  ['Pair=record{x:int;};const int answer=Pair{x=42;}.x;int main(){return 0;}', /struct literal is not a constant expression/],
  ['Pair=record{x:int;};pub Pair get(){return Pair{x=42;};}int main(){return 0;}', /public signature exposes a private struct type/],
  ['Pair=record{x:int[2];};int main(){return 0;}', /after scalar struct field/],
  ['Pair=record{x:int=42;};int main(){return 0;}', /after scalar struct field/],
  ['Pair=record{int x;};int main(){return 0;}', /expected record field name/],
  ['Pair=record{x int;};int main(){return 0;}', /expected ':' after record field name/],
  ['Pair=record{x:;};int main(){return 0;}', /expected Stage 0 type/],
  ['Pair=record{x:int;}int main(){return 0;}', /expected ';' after struct declaration/],
  ['Pair=record', /expected '{' after struct name/],
  ['Pair=record{', /expected record field name/],
  ['Pair=record{x:', /expected Stage 0 type/],
]) rejected(body, message, {}, marker);
for (const [body, message] of [
  ['import app.records as r;int main(){r::Hidden p=r::Hidden{x=42;};return 0;}', /inaccessible symbol/],
  ['import app.records::{Hidden};int main(){return 0;}', /inaccessible symbol/],
]) rejected(body, message, { 'records.l': recordLibrary });
const recordSource = 'pub Pair=record{x:int;ready:bool;};\nint main(){Pair p=Pair{\n x=42;\n ready=true;\n};return if p.ready then p.x else 0;}';
const recordNew = program(recordSource);
const recordOld = program(recordSource.replace('Pair=record{x:int;ready:bool;}', 'struct Pair{int x;bool ready;}')
  .replace('\n x=42;', '\n   42,').replace('\n ready=true;', '\n       true,'));
assert.deepEqual(readFileSync(resolve(recordNew.directory, 'answer.lbc')), readFileSync(resolve(recordOld.directory, 'answer.lbc')),
  'declaration-order named records must reuse position-preserving legacy struct bytecode/metadata');
assert.equal(readFileSync(resolve(recordNew.directory, 'answer.lbc')).readUInt32LE(20), 1);

// All existing scalar types use the same eager lexical cells and selected-branch LIR.
program('int main(){return int(let value=byte(42);in value);}');
program('byte get(){return let in byte(42);}int main(){return int(get());}');
program('int main(){return (let text="*";in text).length+41;}');
program('string get(){return let in "a\\0\\xff";}int main(){return if get().length==3&&int(get()[2])==255 then 42 else 0;}');
program('Kind=enum{Min=-2147483648;Max=2147483647;};Kind get(){return let value:Kind=Kind::Max;in value;}int main(){return if get()==Kind::Max then 42 else 0;}');
program('Octet=alias byte;Text=alias string;int main(){return let var x:Octet=byte(40);var s:Text="old";in int(x=byte(int(x)+2))+(s="*").length-1;}');
program('Kind=enum{A;B;};int main(){return let var k:Kind=Kind::A;in if (k=Kind::B)==Kind::B then 42 else 0;}');
program('int main(){byte x=byte(40);return int(let x=byte(int(x)+1);in let x=byte(int(x)+1);in x);}');
program('int main(){string s="*";string copy=let s=s;in let s=s;in s;s="changed";return if copy=="*" then 42 else 0;}');
program('Kind=enum{A;B;};int main(){Kind k=Kind::B;return if (let k=k;in let k=k;in k)==Kind::B then 42 else 0;}');
program('int main(){return int(if true then byte(42) else byte(256));}');
program('int main(){return int(if false then byte(256) else byte(42));}');
program('int main(){return (if true then "*" else "").length+41;}');
program('string trap(){return let bad=1/0;in "";}int main(){return (if false then trap() else "*").length+41;}');
program('Kind=enum{A;B;};Kind trap(){return let bad=1/0;in Kind::A;}int main(){return if (if true then Kind::B else trap())==Kind::B then 42 else 0;}');
program('int main(){int n=0;byte b=if n++==0 then byte(n++) else byte(256);return if n==2&&b==byte(1) then 42 else 0;}');
program('int main(){int n=0;string s=if n++!=0 then "bad" else (let tick=n++;in "*");return if n==2&&s=="*" then 42 else 0;}');
program('Kind=enum{A;B;};int main(){int n=0;Kind k=if n++==0 then (let tick=n++;in Kind::B) else Kind::A;return if n==2&&k==Kind::B then 42 else 0;}');
program('int score(byte x){return int(x);}int score(string x){return x.length+41;}Kind=enum{Answer;};int score(Kind x){return 42;}int main(){return score(let x=byte(42);in x)+score(if true then "*" else "")+score(let x=Kind::Answer;in x)-84;}');
program('int pair(byte a,byte b){return int(a)*10+int(b);}int main(){int n=3;return pair((let value=byte(n++);in value),(if true then byte(n++) else byte(256)))+8;}');
program('string id(string s){return s;}int main(){return int(id(let s=if true then "*" else "";in s)[0]);}');
program('Kind=enum{A;B;};Kind id(Kind k){return k;}int main(){switch(id(let k=if true then Kind::B else Kind::A;in k)){case Kind::B:return 42;default:return 0;}}');
program('Packet=record{octet:byte;text:string;};int main(){int n=40;Packet p=Packet{text=(let tick=n++;in "*");octet=(if true then byte(n+1) else byte(256));};return if p.text=="*" then int(p.octet) else 0;}');
program('int main(){return let unused=byte(256);later=1/0;in 42;}', 70, {}, /byte conversion out of range/);
program('int main(){return let unused=""[0];later=byte(256);in 42;}', 70, {}, /string index out of bounds/);
program('Kind=enum{A;};int main(){return let unused=(if true then (let bad=1/0;in Kind::A) else Kind::A);in 42;}', 70, {}, /division by zero/);
program('int main(){int n=0;return let unused=(let tick=n++;in "*");again=(let tick=n++;in byte(42));in n+40;}');
program('int main(){string s="outside";string inner=let var s="inside";in s="*";return if s=="outside"&&inner=="*" then 42 else 0;}');
program('int main(){return if false&&((let unused=byte(256);in "*")=="*") then 0 else 42;}');
program('int main(){byte data[1];data[0]=let value=if true then byte(42) else byte(256);in value;return int(data[0]);}');
program('string trap(){return let bad=""[0];in "";}int main(){return (if true then trap() else "*").length;}', 70, {}, /string index out of bounds/);
program('Kind=enum{A;};Kind trap(){return let bad=1/0;in Kind::A;}int main(){return if (if false then Kind::A else trap())==Kind::A then 42 else 0;}', 70, {}, /division by zero/);
const scalarLibrary = 'module app.scalars;pub Octet=alias byte;pub Text=alias string;pub Kind=enum{Off;On;};'
  + 'pub Octet octet(){return let value:Octet=byte(42);in value;}'
  + 'pub Text text(bool b){return if b then "*" else "";}'
  + 'pub Kind kind(){return let value=if true then Kind::On else Kind::Off;in value;}';
for (const imports of ['import app.scalars as s;', 'import app.scalars::{Octet,Text,Kind,octet,text,kind};']) {
  const prefix = imports.includes(' as ') ? 's::' : '';
  program(`${imports}int main(){return let value:${prefix}Octet=${prefix}octet();text:${prefix}Text=${prefix}text(true);kind:${prefix}Kind=${prefix}kind();in if text=="*"&&kind==${prefix}Kind::On then int(value) else 0;}`, 42,
    { 'scalars.l': scalarLibrary });
}
for (const [body, message] of [
  ['int main(){return let x:byte=42;in 0;}', /expected byte, got int/],
  ['int main(){return let x:string=byte(42);in 0;}', /expected string, got byte/],
  ['Kind=enum{A;};int main(){return let x:Kind=0;in 0;}', /expected enum, got int/],
  ['A=enum{X;};B=enum{X;};int main(){return let x:A=B::X;in 0;}', /expected enum, got enum/],
  ['A=enum{X;};B=enum{X;};A get(){return if true then A::X else B::X;}int main(){return 0;}', /expected enum, got enum/],
  ['int main(){byte b=if true then byte(42) else 42;return 0;}', /expected byte, got int/],
  ['int main(){string s=if true then "*" else byte(42);return 0;}', /expected string, got byte/],
  ['int main(){return if byte(1) then 42 else 0;}', /expected bool, got byte/],
  ['int main(){return if "*" then 42 else 0;}', /expected bool, got string/],
  ['Kind=enum{A;};int main(){return if Kind::A then 42 else 0;}', /expected bool, got enum/],
  ['int main(){return let x=byte(1);in int(x=byte(42));}', /cannot modify const binding/],
  ['int main(){return let x="*";in (x="").length;}', /cannot modify const binding/],
  ['Kind=enum{A;B;};int main(){return let x=Kind::A;in if (x=Kind::B)==Kind::B then 42 else 0;}', /cannot modify const binding/],
  ['int main(){return let var x=byte(1);in int(x++);}', /expected int, got byte/],
  ['int main(){return let var x="*";in x++;}', /expected int, got string/],
  ['Kind=enum{A;};int main(){return let var x=Kind::A;in x++;}', /expected int, got enum/],
  ['int main(){string s=let text="*";in text;return text.length;}', /unknown local variable or constant/],
  ['int main(){string s=if true then (let text="*";in text) else text;return 0;}', /unknown local variable or constant/],
  ['int main(){byte b=if true then byte(42) else missing;return 0;}', /unknown local variable or constant/],
  ['int main(){string s=if true then "*" else (let text="";in text="*");return 0;}', /cannot modify const binding/],
  ['int main(){byte a[1];return let value=a;in 0;}', /array used without an index/],
  ['int main(){byte a[1];return int(let in a);}', /array used without an index/],
  ['int main(){byte a[1];return int(if true then a else a);}', /array used without an index/],
  ['const byte b=let x=byte(42);in x;int main(){return 0;}', /let is not a compile-time constant expression/],
  ['const string s=if true then "*" else "";int main(){return 0;}', /conditional is not a compile-time constant expression/],
  ['Kind=enum{A;};static Kind k=let x=Kind::A;in x;int main(){return 0;}', /let is not a compile-time constant expression/],
  ['static byte b=if true then byte(42) else byte(0);int main(){return 0;}', /conditional is not a compile-time constant expression/],
  ['int main(){byte b=byte(42);switch(b){case (let x=byte(42);in x):return 42;default:return 0;}}', /let is not a compile-time constant expression/],
  ['Kind=enum{A;};int main(){switch(Kind::A){case (if true then Kind::A else Kind::A):return 42;default:return 0;}}', /conditional is not a compile-time constant expression/],
]) rejected(body, message);

// Aggregate expressions are nominal values, never aliases into a lexical cell.
for (const declaration of ['Pair=record{value:int;ready:bool;};', 'struct Pair{int value;bool ready;};']) {
  const pair = body => declaration + body;
  program(pair('int main(){return let p=Pair{ready=true;value=42;};in p.value;}'));
  program(pair('int main(){return let p:Pair=Pair{value=42;ready=true;};in p.value;}'));
  program(pair('int main(){return let p=Pair{value=42;ready=true;};in 0;}'), 0);
  program(pair('Pair get(){return let p=Pair{value=42;ready=true;};in p;}int main(){return get().value;}'));
  program(pair('Pair get(){return let in Pair{value=42;ready=true;};}int main(){return get().value;}'));
  program(pair('Pair get(){return if true then Pair{value=42;ready=true;} else Pair{value=1/0;ready=false;};}int main(){return get().value;}'));
  program(pair('Pair get(){return if false then Pair{value=1/0;ready=false;} else Pair{value=42;ready=true;};}int main(){return get().value;}'));
  program(pair('Pair get(){return let var p=Pair{value=0;ready=true;};in p=Pair{value=42;ready=true;};}int main(){return get().value;}'));
  program(pair('Pair get(){return let var p=Pair{value=42;ready=true;};snapshot=p;changed=(p.value=0);in snapshot;}int main(){return get().value;}'));
  program(pair('Pair change(Pair p){return let var p=p;changed=(p.value=0);in p;}int main(){Pair p=Pair{value=42;ready=true;};Pair q=change(p);return if q.value==0 then p.value else 0;}'));
  program(pair('int change(Pair p){p.value=0;return 0;}int main(){return let p=Pair{value=42;ready=true;};unused=change(p);in p.value;}'));
  program(pair('int main(){return (let var p=Pair{value=40;ready=true;};first=p.value++;second=p.value++;in p).value;}'));
  program(pair('int main(){Pair p=Pair{value=42;ready=true;};Pair q=let p=p;in let p=p;in p;q.value=0;return p.value;}'));
  program(pair('int inspect(Pair p,int ignored){return p.value;}int main(){Pair p=Pair{value=42;ready=true;};return inspect((let in p),p.value=0);}'));
  program(pair('int inspect(Pair p,int ignored){return p.value;}int main(){Pair p=Pair{value=42;ready=true;};return inspect((if true then p else p),p.value=0);}'));
  program(pair('int pair(Pair a,Pair b){return a.value*10+b.value;}int main(){int n=3;return pair((let p=Pair{value=n++;ready=true;};in p),(if true then Pair{ready=true;value=n++;} else Pair{value=1/0;ready=false;}))+8;}'));
  program(pair('int main(){int n=0;Pair p=if n++==0 then (let tick=n++;in Pair{value=42;ready=true;}) else Pair{value=1/0;ready=false;};return if n==2&&p.ready then p.value else 0;}'));
  program(pair('int main(){int n=0;Pair p=if n++!=0 then Pair{value=1/0;ready=false;} else (let tick=n++;in Pair{value=42;ready=true;});return if n==2&&p.ready then p.value else 0;}'));
  program(pair('int main(){int n=40;return (let unused=Pair{value=n++;ready=true;};p=Pair{value=n++;ready=true;};in p).value+1;}'));
  program(pair('int main(){int sum=0;for(int i=0;i<3;i++){Pair p=let var p=Pair{value=14;ready=true;};in p;sum=sum+p.value;}return sum;}'));
  program(pair('Pair recurse(int n){return if n==0 then Pair{value=42;ready=true;} else (let p=recurse(n-1);in p);}int main(){return recurse(4).value;}'));
  program(pair('int main(){return (let p=if true then (let q=Pair{value=42;ready=true;};in q) else Pair{value=1/0;ready=false;};in p).value;}'));
  program(pair('int main(){return Pair{ready=true;value=(let p=if true then Pair{value=42;ready=true;} else Pair{value=1/0;ready=false;};in p).value;}.value;}'));
  program(pair('int main(){return let unused=Pair{value=1/0;ready=true;};later=byte(256);in 42;}'), 70, {}, /division by zero/);
  program(pair('int main(){return (if false then Pair{value=42;ready=true;} else Pair{value=1/0;ready=true;}).value;}'), 70, {}, /division by zero/);
  program(pair('int main(){return if false&&((let p=Pair{value=1/0;ready=true;};in p).ready) then 0 else 42;}'));
  for (const [body, message] of [
    ['int main(){return let p=Pair{value=42;ready=true;};in p=Pair{value=0;ready=false;};}', /cannot modify const binding/],
    ['int main(){return let p=Pair{value=42;ready=true;};in p.value=0;}', /cannot modify const binding/],
    ['int main(){return let p=Pair{value=42;ready=true;};in p.value++;}', /cannot modify const binding/],
    ['int main(){return let p=Pair{value=42;ready=true;};in p;}', /expected int, got struct/],
    ['int main(){return let p:Pair=42;in 0;}', /expected struct, got int/],
    ['Pair get(){return if true then Pair{value=42;ready=true;} else 0;}int main(){return 0;}', /expected struct, got int/],
    ['int main(){return if Pair{value=42;ready=true;} then 42 else 0;}', /expected bool, got struct/],
    ['int main(){Pair p=let q=Pair{value=42;ready=true;};in q;return q.value;}', /unknown local variable or constant/],
    ['Pair get(){return if true then (let q=Pair{value=42;ready=true;};in q) else q;}int main(){return 0;}', /unknown local variable or constant/],
    ['Pair get(){return if true then Pair{value=42;ready=true;} else Pair{unknown=0;ready=false;};}int main(){return 0;}', /unknown record initializer field/],
    ['int main(){return let p=Pair{value=42;ready=true;};p=p;in 0;}', /duplicate local declaration/],
    ['int main(){return let p=p;in 0;}', /unknown local variable or constant/],
    ['int main(){return (let var p=Pair{value=42;ready=true;};in p).value=0;}', /field mutation requires a local struct binding/],
    ['int main(){return (if true then Pair{value=42;ready=true;} else Pair{value=0;ready=false;}).value++;}', /field mutation requires a local struct binding/],
    ['int main(){return (let in Pair{value=42;ready=true;})==Pair{value=42;ready=true;};}', /equality requires matching scalar types/],
    ['const int answer=(let p=Pair{value=42;ready=true;};in p).value;int main(){return 0;}', /let is not a compile-time constant expression/],
    ['static int answer=(if true then Pair{value=42;ready=true;} else Pair{value=0;ready=false;}).value;int main(){return 0;}', /conditional is not a compile-time constant expression/],
    ['int main(){int a[(let in Pair{value=1;ready=true;}).value];return 0;}', /let is not a compile-time constant expression/],
    ['int main(){switch(42){case (if true then Pair{value=42;ready=true;} else Pair{value=0;ready=false;}).value:return 42;default:return 0;}}', /conditional is not a compile-time constant expression/],
    ['enum K{A=(let in Pair{value=42;ready=true;}).value};int main(){return 0;}', /let is not a compile-time constant expression/],
    ['int main(){Pair a[1];return 0;}', /array element type/],
    ['static Pair p=Pair{value=42;ready=true;};int main(){return 0;}', /module constant\/static type/],
  ]) rejected(pair(body), message);
}
program('struct Pair{int value;bool ready;};Pair get(){return if true then (let p=Pair{42,true};in p) else Pair{0,false};}int main(){return get().value;}');
program('Kind=enum{Low=-2147483648;High=2147483647;};Packet=record{low:int;high:int;ready:bool;octet:byte;text:string;kind:Kind;};Packet get(){return let p=if false then Packet{low=1/0;high=0;ready=false;octet=byte(0);text="";kind=Kind::Low;} else Packet{text="a\\0\\xff";kind=Kind::High;octet=byte(255);ready=true;high=2147483647;low=-2147483648;};in p;}int main(){Packet p=get();return if p.low==-2147483648&&p.high==2147483647&&p.ready&&int(p.octet)==255&&p.text.length==3&&p.kind==Kind::High then 42 else 0;}');
for (const [body, message] of [
  ['A=record{x:int;};B=record{x:int;};int main(){return let p:A=B{x=42;};in 0;}', /expected struct, got struct/],
  ['A=record{x:int;};struct B{int x;};A get(){return if true then A{x=42;} else B{42};}int main(){return 0;}', /expected struct, got struct/],
  ['A=record{x:int;};int main(){return let var p=A{x=42;};in p=42;}', /expected struct, got int/],
  ['Inner=record{x:int;};Outer=record{inner:Inner;};int main(){return 0;}', /struct fields must be scalar/],
  ['A=record{x:int;};Copy=alias A;int main(){return 0;}', /type alias target must be/],
]) rejected(body, message);
const aggregateLibrary = 'module app.aggregates;Hidden=record{value:int;ready:bool;};pub Pair=record{value:int;ready:bool;};'
  + 'pub Pair choose(bool ready){return if ready then (let p=Pair{ready=true;value=42;};in p) else Pair{value=1/0;ready=false;};}';
for (const [imports, type, choose] of [
  ['import app.aggregates as a;', 'a::Pair', 'a::choose'],
  ['import app.aggregates::{Pair as P,choose};', 'P', 'choose'],
]) program(`${imports}int main(){return let p:${type}=${choose}(true);in p.value;}`, 42, { 'aggregates.l': aggregateLibrary });
rejected('import app.aggregates as a;int main(){return let p:a::Hidden=a::Hidden{value=42;ready=true;};in p.value;}',
  /inaccessible symbol/, { 'aggregates.l': aggregateLibrary });

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
for (const [type, value, result, declarations] of [
  ['byte', 'byte(42)', 'int(get())', ''],
  ['string', '"*"', 'get().length+41', ''],
  ['Kind', 'Kind::B', 'if get()==Kind::B then 42 else 0', 'Kind=enum{A;B;};'],
]) {
  const scalarBindings = count => Array.from({ length: count }, (_, n) => `x${n}:${type}=${value};`).join('');
  program(`${declarations}${type} get(){return let ${scalarBindings(1024)}in x1023;}int main(){return ${result};}`);
  rejected(`${declarations}${type} get(){return let ${scalarBindings(1025)}in ${value};}int main(){return 0;}`, /too many local slots/);
  program(`${declarations}${type} get(){return let ${scalarBindings(1023)}in if true then x1022 else ${value};}int main(){return ${result};}`);
  rejected(`${declarations}${type} get(){return let ${scalarBindings(1024)}in if true then ${value} else ${value};}int main(){return 0;}`, /too many LIR slots/);
}
for (const declaration of ['Pair=record{value:int;ready:bool;};', 'struct Pair{int value;bool ready;};']) {
  const aggregateBindings = count => Array.from({ length: count }, (_, n) => `p${n}:Pair=Pair{value=42;ready=true;};`).join('');
  program(`${declaration}Pair get(){return let ${aggregateBindings(1024)}in p1023;}int main(){return get().value;}`);
  rejected(`${declaration}Pair get(){return let ${aggregateBindings(1025)}in Pair{value=42;ready=true;};}int main(){return 0;}`, /too many local slots/);
  program(`${declaration}Pair get(){return let ${aggregateBindings(1023)}in if true then p1022 else Pair{value=0;ready=false;};}int main(){return get().value;}`);
  rejected(`${declaration}Pair get(){return let ${aggregateBindings(1024)}in if true then p1023 else p1023;}int main(){return 0;}`, /too many LIR slots/);
}
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
program(`${'n=namespace{'.repeat(256)}${'};'.repeat(256)}int main(){return 42;}`);
rejected(`${'n=namespace{'.repeat(257)}${'};'.repeat(257)}int main(){return 0;}`, /nesting limit/);
program(`n=namespace{${constants(1024)}};int main(){return n::c42;}`);
rejected(`n=namespace{${constants(1024)}};namespace n{const int tail=0;}int main(){return 0;}`, /too many module constants/);
const enums = count => Array.from({ length: count }, (_, n) => `E${n}=enum{A;};`).join('');
program(`${enums(256)}int main(){return if E255::A==E255::A then 42 else 0;}`);
program(`${enums(255)}enum Last{A};int main(){return if Last::A==Last::A then 42 else 0;}`);
rejected(`${enums(257)}int main(){return 0;}`, /too many enums/);
rejected(`import app.kinds;${enums(256)}int main(){return 0;}`, /too many enums across modules/,
  { 'kinds.l': 'module app.kinds;enum Extra{A};' });
const members = count => Array.from({ length: count }, (_, n) => `M${n};`).join('');
program(`Kind=enum{${members(1024)}};int main(){return if Kind::M1023==Kind::M1023 then 42 else 0;}`);
rejected(`Kind=enum{${members(1025)}};int main(){return 0;}`, /too many enum members/);
const recordFields = count => Array.from({ length: count }, (_, n) => `f${n}:int;`).join('');
const recordValues = count => Array.from({ length: count }, (_, n) => `f${count - n - 1}=${count - n - 1};`).join('');
program(`Wide=record{${recordFields(64)}};int main(){Wide p=Wide{${recordValues(64)}};return p.f42;}`);
program(`Wide=record{${recordFields(64)}};Wide get(){return let var p=Wide{${recordValues(64)}};snapshot=p;changed=(p.f63=0);in if true then snapshot else p;}`
  + `int main(){Wide p=get();return if ${Array.from({ length: 64 }, (_, n) => `p.f${n}==${n}`).join('&&')} then p.f42 else 0;}`);
rejected(`Wide=record{${recordFields(65)}};int main(){return 0;}`, /too many struct fields/);
const records = count => Array.from({ length: count }, (_, n) => `R${n}=record{x:int;};`).join('');
program(`${records(256)}int main(){return R255{x=42;}.x;}`);
program(`${records(256)}R255 get(){return let p=R255{x=42;};in if true then p else R255{x=0;};}int main(){return get().x;}`);
program(`${records(255)}struct Last{int x;};int main(){return Last{42}.x;}`);
rejected(`${records(257)}int main(){return 0;}`, /too many structs/);
rejected(`import app.records;${records(256)}int main(){return 0;}`, /too many structs across modules/,
  { 'records.l': 'module app.records;struct Extra{int x;};' });

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
const namespaceExample = resolve(root, 'examples/replacement/namespaces.l'), namespaceOutput = resolve(work, 'namespaces.lbc');
command(0, ['compile', namespaceExample, '--manifest', manifest, '-o', namespaceOutput]);
command(0, ['check', namespaceOutput]);
command(42, ['run', namespaceOutput]);
const enumExample = resolve(root, 'examples/replacement/enums.l'), enumOutput = resolve(work, 'enums.lbc');
command(0, ['compile', enumExample, '--manifest', manifest, '-o', enumOutput]);
command(0, ['check', enumOutput]);
command(42, ['run', enumOutput]);
const recordExample = resolve(root, 'examples/replacement/records.l'), recordOutput = resolve(work, 'records.lbc');
command(0, ['compile', recordExample, '--manifest', manifest, '-o', recordOutput]);
command(0, ['check', recordOutput]);
command(42, ['run', recordOutput]);
const scalarExample = resolve(root, 'examples/replacement/scalars.l'), scalarOutput = resolve(work, 'scalars.lbc');
command(0, ['compile', scalarExample, '--manifest', manifest, '-o', scalarOutput]);
command(0, ['check', scalarOutput]);
command(42, ['run', scalarOutput]);
const aggregateExample = resolve(root, 'examples/replacement/aggregates.l'), aggregateOutput = resolve(work, 'aggregates.lbc');
command(0, ['compile', aggregateExample, '--manifest', manifest, '-o', aggregateOutput]);
command(0, ['check', aggregateOutput]);
command(42, ['run', aggregateOutput]);
const functionExample = resolve(root, 'examples/replacement/functions.l'), functionOutput = resolve(work, 'functions.lbc');
command(0, ['compile', functionExample, '--manifest', manifest, '-o', functionOutput]);
command(0, ['check', functionOutput]);
command(42, ['run', functionOutput]);
assert.match(command(65, ['check', example]).stderr, /requires an explicit --manifest/);
console.log(`replacement execution: ${fixtures} fixtures, ${commands} CLI checks passed (bytecode 1.9)`);
