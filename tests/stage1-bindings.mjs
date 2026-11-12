import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]), root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1-bindings.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
const quote = text => `"${[...Buffer.from(text, 'latin1')].map(b => `\\x${b.toString(16).padStart(2, '0')}`).join('')}"`;
const position = (text, start) => ({ line: text.slice(0, start).split('\n').length, column: start - text.slice(0, start).lastIndexOf('\n') });
let commands = 0, batches = 0;
const checks = { d: 0, h: 0, e: 0 };
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error); assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, options.error ?? ''); commands++; return result;
}
const e = (kind, start, length, fields = {}) => ({ kind, start, length, op: 'None', value: 0, text: '', left: null, right: null, next: null, ...fields });
const d = (kind, start, length, fields = {}) => ({ kind, start, length, nameStart: 0, nameLength: 0, exported: false,
  header: null, type: null, items: null, body: null, next: null, ...fields });
const h = (kind, start, length, fields = {}) => ({ kind, start, length, path: null, alias: null, items: null, next: null, ...fields });
const integer = value => ({ kind: 'Integer', number: String(value) });
const named = name => ({ kind: 'Name', name });
const local = (name, value = integer(1), fields = {}) => ({ name, value, ...fields });
const letIn = (bindings, body, fields = {}) => ({ kind: 'Let', bindings, body, ...fields });
const fn = (body = integer(42), fields = {}) => ({ kind: 'Function', name: 'main', type: 'Int', parameters: [], body, ...fields });
const constant = (fields = {}) => ({ kind: 'Constant', name: 'answer', type: 'Int', body: integer(42), ...fields });
const types = ['Int', 'Bool', 'Byte', 'String', 'Void', 'Auto', 'Named'];
const operators = { '+': 'Plus', '-': 'Minus', '!': 'Bang', '*': 'Star', '/': 'Slash', '%': 'Percent', '<': 'Less', '>': 'Greater',
  '<=': 'LessEqual', '>=': 'GreaterEqual', '==': 'Equal', '!=': 'NotEqual', '&&': 'And', '||': 'Or', '=': 'Assign', '++': 'Increment', '--': 'Decrement', int: 'Int', byte: 'Byte' };
const fixtures = [];

// Emit independent trees and source spans; never parse source to obtain the model.
function rendered(name, declarations, options = {}) {
  let input = options.leading ?? ''; const gap = options.gap ?? ' ';
  const put = text => { const start = input.length; input += text; return start; };
  function chain(text, separator, factory) {
    let first = null, last = null;
    for (const part of text.split(separator)) {
      if (last) put(separator);
      const item = factory('Name', put(part), part.length);
      if (last) { if (factory === e) last.right = item; else last.next = item; } else first = item;
      last = item;
    }
    return first;
  }
  function type(tag, name = 'pkg::T') {
    const start = input.length;
    const left = tag === 'Named' ? chain(name, '::', e) : null;
    const text = tag === 'Named' ? name.split('::')[0] : tag.toLowerCase();
    if (!left) put(text);
    return e('Type', start, text.length, { value: types.indexOf(tag) + 1, left });
  }
  function expression(tree) {
    if (tree.kind === 'Integer') return e('Integer', put(tree.number), tree.number.length, { value: -Number(BigInt(tree.number)) });
    if (tree.kind === 'Bool') { const text = String(tree.bool); return e('Bool', put(text), text.length, { value: Number(tree.bool) }); }
    if (tree.kind === 'Text') { const text = quote(tree.text); return e('Text', put(text), text.length, { text: tree.text }); }
    if (tree.kind === 'Name') return chain(tree.name, '::', e);
    if (tree.kind === 'Chain') {
      let value = e('Name', put('x'), 1);
      for (let n = 0; n < tree.count; n++) value = e('Postfix', put('++'), 2, { op: 'Increment', left: value });
      return value;
    }
    if (tree.kind === 'Let') {
      if (!tree.bare) put('(');
      const result = e('Let', put('let'), 3); put(gap); let last = null;
      for (const binding of tree.bindings) {
        if (binding.mutable) put(`var${gap}`);
        const item = e('Binding', put(binding.name), binding.name.length, { value: Number(!!binding.mutable) });
        if (binding.type) { put(':'); item.left = type(binding.type, binding.typeName); }
        put('='); item.right = expression(binding.value); put(`;${gap}`);
        if (last) last.next = item; else result.left = item;
        last = item;
      }
      put(`in${gap}`); result.right = expression(tree.body);
      if (!tree.bare) put(')');
      return result;
    }
    if (tree.kind === 'Unary') {
      put('('); const item = e('Unary', put(tree.operator), tree.operator.length, { op: operators[tree.operator] });
      item.left = expression(tree.left); put(')'); return item;
    }
    if (tree.kind === 'Binary' || tree.kind === 'Assign') {
      if (!tree.bare) put('('); const left = expression(tree.left); put(gap);
      const item = e(tree.kind, put(tree.operator), tree.operator.length, { op: operators[tree.operator], left });
      put(gap); item.right = expression(tree.right); if (!tree.bare) put(')'); return item;
    }
    if (tree.kind === 'Convert') {
      const item = e('Convert', put(tree.operator), tree.operator.length, { op: operators[tree.operator] });
      put('('); item.left = expression(tree.left); put(')'); return item;
    }
    put('('); const left = expression(tree.left); put(')');
    if (tree.kind === 'Field') { put('.'); return e('Field', put(tree.name), tree.name.length, { left }); }
    if (tree.kind === 'Postfix') return e('Postfix', put(tree.operator), tree.operator.length, { op: operators[tree.operator], left });
    if (tree.kind === 'Index') {
      const item = e('Index', put('['), 1, { left }); item.right = expression(tree.right); put(']'); return item;
    }
    assert.equal(tree.kind, 'Call');
    const item = e('Call', put('('), 1, { left }); let last = null;
    for (const argument of tree.arguments) {
      if (last) put(','); const current = expression(argument);
      if (last) last.next = current; else item.right = current;
      last = current;
    }
    put(')'); return item;
  }
  const header = h('Module', put('module'), 6); put(gap); header.path = chain(options.module ?? 'm', '.', h); put(`;${gap}`);
  let lastImport = null;
  for (const imported of options.imports ?? []) {
    const item = h('Import', put('import'), 6); put(gap); item.path = chain(imported.path, '.', h);
    if (imported.alias) { put(`${gap}as${gap}`); item.alias = h('Name', put(imported.alias), imported.alias.length); }
    if (imported.selection) {
      put('::{'); let last = null;
      for (const selected of imported.selection) {
        if (last) put(','); const start = input.length, path = chain(selected.path, '::', h);
        const selection = h('Selection', start, selected.path.split('::')[0].length, { path });
        if (selected.alias) { put(`${gap}as${gap}`); selection.alias = h('Name', put(selected.alias), selected.alias.length); }
        if (last) last.next = selection; else item.items = selection; last = selection;
      }
      put(',}');
    }
    put(`;${gap}`); if (lastImport) lastImport.next = item; else header.items = item; lastImport = item;
  }
  const tree = d('Module', header.start, 6, { header }); let last = null;
  for (const declaration of declarations) {
    const start = input.length;
    if (declaration.exported) put(`pub${gap}`);
    const nameStart = put(declaration.name);
    const item = d(declaration.kind, start, declaration.exported ? 3 : declaration.name.length,
      { nameStart, nameLength: declaration.name.length, exported: !!declaration.exported });
    if (declaration.kind === 'Constant') { put(':'); item.type = type(declaration.type, declaration.typeName); put('='); }
    else {
      put('=('); let lastParameter = null;
      for (const parameter of declaration.parameters) {
        if (lastParameter) put(',');
        const start = put(parameter.name), current = d('Parameter', start, parameter.name.length, { nameStart: start, nameLength: parameter.name.length });
        put(':'); current.type = type(parameter.type, parameter.typeName);
        if (lastParameter) lastParameter.next = current; else item.items = current;
        lastParameter = current;
      }
      put('):'); item.type = type(declaration.type, declaration.typeName); put('=>');
    }
    item.body = expression(declaration.body); put(`;${gap}`);
    if (last) last.next = item; else tree.items = item; last = item;
  }
  input += options.trailing ?? '';
  const fixture = { name, input, tree, passes: options.passes ?? 2 }; fixtures.push(fixture); return fixture;
}
function bad(input, error, marker = '', nested = {}) {
  const start = typeof marker === 'number' ? marker : marker ? input.lastIndexOf(marker) : input.length;
  assert.ok(start >= 0, marker);
  const tail = input.slice(start), token = /^[A-Za-z_][A-Za-z_0-9]*|^[0-9]+|^(?:=>|::|\+\+|--)/.exec(tail);
  const length = start === input.length ? 0 : token?.[0].length ?? 1;
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 65))}`, input, error, start, length,
    header: 'None', expression: 'None', lexical: 'None', ...nested });
}
rendered('header only', []);
rendered('approved spelling', [fn({ kind: 'Binary', operator: '+', left: named('a'), right: named('b') },
  { name: 'add', exported: true, parameters: [{ name: 'a', type: 'Int' }, { name: 'b', type: 'Int' }] }),
fn(letIn([local('value', { kind: 'Call', left: named('add'), arguments: [integer(20), integer(22)] }, { type: 'Int' })], named('value'), { bare: true }))]);
for (const tag of types) for (const exported of [false, true]) {
  rendered(`function ${tag} ${exported}`, [fn(integer(0), { type: tag, exported, parameters: [{ name: 'p', type: tag }] })]);
  rendered(`constant ${tag} ${exported}`, [constant({ type: tag, exported })]);
}
for (const tag of [null, ...types]) for (const mutable of [false, true]) rendered(`local ${tag} ${mutable}`, [
  fn(letIn([local('x', named('unknown'), { type: tag, mutable })], named('x'))),
]);
for (const name of ['constructor', '__proto__', 'letx', 'inner', 'variable']) rendered(`identifier ${name}`, [constant({ name }), fn(letIn([local(name)], named(name)), { name: `f_${name}`, parameters: [{ name, type: 'Int' }] })]);
for (const gap of ['\n', '\r', '\t', '/*gap*/', '//gap\n']) rendered(`trivia ${JSON.stringify(gap)}`, [constant({ exported: true, type: 'String', body: { kind: 'Text', text: 'old\0\xff' } }),
  fn(letIn([local('x', { kind: 'Text', text: 'new\0\x80' }, { type: 'Named', mutable: true })], { kind: 'Text', text: 'last' }))],
{ gap, leading: '\n/*\xff*/', trailing: '\n//\x80', module: 'app.main', imports: [{ path: 'app.types', alias: 'types' }, { path: 'std.io', selection: [{ path: 'read_byte', alias: 'read' }, { path: 'nested::value' }] }] });
rendered('syntax only, not resolution or execution', [constant({ name: 'x', body: named('later') }), constant({ name: 'x', type: 'Void' }),
  fn(letIn([local('x', named('later')), local('x', integer(1)), local('mutable', integer(2), { mutable: true })],
    { kind: 'Assign', operator: '=', left: named('x'), right: named('unknown') })), fn(named('forever'), { name: 'later' })]);
rendered('empty let', [fn(letIn([], integer(0)))]);
rendered('bare let body precedence', [fn(letIn([local('x')], { kind: 'Binary', operator: '+', bare: true, left: named('x'),
  right: { kind: 'Binary', operator: '*', bare: true, left: integer(2), right: integer(3) } }, { bare: true }))]);
rendered('bare let on binary right', [fn({ kind: 'Binary', operator: '+', bare: true, left: integer(1),
  right: letIn([local('x')], { kind: 'Binary', operator: '*', bare: true, left: named('x'), right: integer(3) }, { bare: true }) })]);
rendered('bare lets stop at call commas', [fn({ kind: 'Call', left: named('f'), arguments: [letIn([], integer(1), { bare: true }), letIn([], integer(2), { bare: true })] })]);
rendered('bare nested initializer handoff', [fn(letIn([local('x', letIn([local('y', integer(2))], named('y'), { bare: true })),
  local('z', integer(3), { mutable: true })], { kind: 'Binary', operator: '+', bare: true, left: named('x'), right: named('z') }, { bare: true }))]);
rendered('nested lets and retained byte strings', [fn(letIn([local('outer', { kind: 'Text', text: '\0\xff' }),
  local('inner', letIn([local('x', integer(1))], named('x')))], letIn([local('z', { kind: 'Text', text: 'z\x80' })], named('outer'))))]);
for (const operator of Object.keys(operators).filter(op => !['!', '++', '--', 'int', 'byte'].includes(op))) rendered(`operator ${operator}`, [fn({ kind: operator === '=' ? 'Assign' : 'Binary', operator,
  left: letIn([], integer(1)), right: letIn([local('x')], integer(2)) })]);
for (const operator of ['+', '-', '!']) rendered(`prefix ${operator}`, [fn({ kind: 'Unary', operator, left: letIn([], integer(1)) })]);
for (const operator of ['++', '--']) rendered(`postfix ${operator}`, [fn({ kind: 'Postfix', operator, left: letIn([], named('x')) })]);
for (const operator of ['int', 'byte']) rendered(`conversion ${operator}`, [fn({ kind: 'Convert', operator, left: letIn([], integer(42)) })]);
rendered('call, field and index', [fn({ kind: 'Index', left: { kind: 'Field', name: 'items', left: { kind: 'Call', left: named('f'), arguments: [letIn([], integer(1)), letIn([local('b')], named('b'))] } }, right: letIn([], integer(0)) })]);
rendered('integer boundary magnitude', [fn({ kind: 'Unary', operator: '-', left: integer(2147483648) })]);
rendered('all decoded bytes', [fn({ kind: 'Text', text: Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('latin1') }, { type: 'String' })]);

for (const [tail, error, marker, nested] of [
  ['int main(){return 0;}', 'ExpectedName', 'int'], ['const int x=1;', 'ExpectedName', 'const'],
  ['pub var x:int=1;', 'ExpectedName', 'var'], ['x:int=1; import p;', 'MisplacedHeader', 'import'],
  ['x:int=1; module other;', 'MisplacedHeader', 'module'], ['pub =1;', 'ExpectedName', '='],
  ['x:int 1;', 'ExpectedAssign', '1'], ['x:=1;', 'Expression', '=', { expression: 'ExpectedType' }],
  ['x=42;', 'ExpectedOpen', '42'], ['f=():int= >1;', 'ExpectedArrow', '= >'], ['f=():int->1;', 'ExpectedArrow', '->'],
  ['f=():int 1;', 'ExpectedArrow', '1'], ['f=(x int):int=>1;', 'ExpectedColon', 'int):'],
  ['f=(x:):int=>1;', 'Expression', '):', { expression: 'ExpectedType', start: 15 }],
  ['f=(x:int,):int=>1;', 'ExpectedName', ',):', { start: 19 }],
  ['f=(x:int:int=>1;', 'ExpectedClose', ':int=>'], ['f=() int=>1;', 'ExpectedColon', 'int'],
  ['f=():=>1;', 'Expression', '=>', { expression: 'ExpectedType' }],
  ['f=():int=>;', 'Expression', ';', { expression: 'ExpectedExpression' }], ['f=():int=>0', 'ExpectedSemicolon', ''],
  ['f=():int=>let x=1 in x;', 'Expression', 'in', { expression: 'ExpectedSemicolon' }],
  ['f=():int=>let var =1; in 0;', 'Expression', '=1', { expression: 'ExpectedName' }],
  ['f=():int=>let x 1; in x;', 'Expression', '1;', { expression: 'ExpectedAssign' }],
  ['f=():int=>let x: =1; in x;', 'Expression', '=1', { expression: 'ExpectedType' }],
  ['f=():int=>let const x=1; in x;', 'Expression', 'const', { expression: 'ExpectedName' }],
  ['f=():int=>let x=1;', 'Expression', '', { expression: 'ExpectedName' }],
  ['f=():int=>let in ;', 'Expression', ';', { expression: 'ExpectedExpression' }],
  ['f=():int=>f(1,);', 'Expression', ');', { expression: 'ExpectedExpression' }],
  ['f=():int=>P{1};', 'ExpectedSemicolon', '{'], ['f=():int=>{return 0;};', 'Expression', '{', { expression: 'ExpectedExpression' }],
  ['f=():int=>let x=1; in @;', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['x:string="old"; f=():int=>let y="new"; in ;', 'Expression', ';', { expression: 'ExpectedExpression' }],
  ['f=():int=>let let=1; in 0;', 'Expression', 'let=1', { expression: 'ExpectedName' }],
]) bad(`module m; ${tail}`, error, marker, nested);
bad('', 'Header', '', { header: 'ExpectedModule' });
bad('module m; @', 'Header', '@', { header: 'Lexical', lexical: 'UnsupportedCharacter' });
bad('module m; import p::*;', 'Header', '*', { header: 'ExpectedSelection' });
bad('module in;', 'Header', 'in', { header: 'ExpectedName' });
bad('module m; import var;', 'Header', 'var', { header: 'ExpectedName' });
bad('module m; import p as let;', 'Header', 'let', { header: 'ExpectedName' });

rendered('full declaration arena', Array.from({ length: 1023 }, () => constant()), { passes: 1 });
const dOverflow = rendered('declaration overflow', Array.from({ length: 1024 }, () => constant()), { passes: 1 }); fixtures.pop();
bad(dOverflow.input, 'TooManyNodes', 'answer'); fixtures.at(-1).passes = 1;
rendered('full parameter arena', [fn(integer(0), { parameters: Array.from({ length: 1022 }, () => ({ name: 'p', type: 'Int' })) })], { passes: 1 });
const pOverflow = rendered('parameter overflow', [fn(integer(0), { parameters: Array.from({ length: 1023 }, () => ({ name: 'p', type: 'Int' })) })]); fixtures.pop();
bad(pOverflow.input, 'TooManyNodes', 'p:int'); fixtures.at(-1).passes = 1;
rendered('function limit and constants', [constant(), ...Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}` }))]);
const fOverflow = rendered('function overflow', Array.from({ length: 257 }, (_, i) => fn(integer(0), { name: `f${i}` }))); fixtures.pop();
bad(fOverflow.input, 'TooManyFunctions', 'f256');
rendered('shared expression arena', [fn({ kind: 'Chain', count: 2046 })]);
const eOverflow = rendered('expression overflow', [fn({ kind: 'Chain', count: 2047 })]); fixtures.pop();
bad(eOverflow.input, 'Expression', '++', { expression: 'TooManyNodes' });
rendered('full let arena', [fn(letIn(Array.from({ length: 1022 }, () => local('x')), { kind: 'Unary', operator: '-', left: integer(0) }))], { passes: 1 });
const letOverflow = rendered('let arena overflow', [fn(letIn(Array.from({ length: 1023 }, () => local('x')), integer(0)))]); fixtures.pop();
bad(letOverflow.input, 'Expression', '0', { expression: 'TooManyNodes' }); fixtures.at(-1).passes = 1;
let nested = integer(0);
for (let n = 0; n < 47; n++) nested = letIn([], nested, { bare: true });
rendered('shared syntax depth', [fn(nested)]);
const depthOverflow = rendered('depth overflow', [fn(letIn([], nested, { bare: true }))]); fixtures.pop();
bad(depthOverflow.input, 'Expression', '0', { expression: 'TooDeep' });

let state = 0x4e495842;
function random(n) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x100000000 * n); }
function generated(depth) {
  if (!depth) return [integer(random(100)), named('ns::value'), { kind: 'Bool', bool: !!random(2) }, { kind: 'Text', text: `a${String.fromCharCode(random(256))}` }][random(4)];
  const choice = random(6);
  if (choice === 0) return { kind: 'Unary', operator: ['+', '-', '!'][random(3)], left: generated(depth - 1) };
  if (choice === 1) return { kind: 'Binary', operator: ['+', '*', '==', '&&'][random(4)], left: generated(depth - 1), right: generated(depth - 1) };
  if (choice === 2) return { kind: 'Call', left: named('f'), arguments: [generated(depth - 1), generated(depth - 1)] };
  return letIn(Array.from({ length: random(3) }, (_, i) => local(`x${i}`, generated(depth - 1), { type: random(2) ? types[random(types.length)] : null, mutable: !!random(2) })), generated(depth - 1));
}
const generatedStart = fixtures.length;
for (let n = 0; n < 40; n++) rendered(`generated ${n}`, [constant({ type: types[random(types.length)], exported: !!random(2) }),
  fn(generated(3), { name: `f${n}`, type: types[random(types.length)], exported: !!random(2), parameters: [{ name: 'p', type: types[random(types.length)] }] })]);
function flatten(roots, links) {
  const nodes = [], ids = new Map(), pending = [...roots].reverse();
  while (pending.length) { const node = pending.pop(); if (!node || ids.has(node)) continue;
    ids.set(node, nodes.length); nodes.push(node); for (const key of [...links].reverse()) if (node[key]) pending.push(node[key]); }
  return { nodes, ids };
}
function arenas(tree) {
  const d = flatten([tree], ['items', 'next']);
  const h = flatten(d.nodes.map(n => n.header).filter(Boolean), ['path', 'alias', 'items', 'next']);
  const e = flatten(d.nodes.flatMap(n => [n.type, n.body]).filter(Boolean), ['left', 'right', 'next']);
  return { d, h, e };
}
const generatedNodes = fixtures.slice(generatedStart).flatMap(f => arenas(f.tree).e.nodes);
for (const kind of ['Let', 'Binding', 'Type', 'Integer', 'Bool', 'Text', 'Name', 'Call', 'Unary', 'Binary']) assert.ok(generatedNodes.some(n => n.kind === kind), kind);
for (const mutable of [0, 1]) assert.ok(generatedNodes.some(n => n.kind === 'Binding' && n.value === mutable), `generated mutability ${mutable}`);
for (let tag = 1; tag <= 7; tag++) assert.ok(generatedNodes.some(n => n.kind === 'Type' && n.value === tag), `generated type ${tag}`);

const helpers = `
static int dids[parser::max_nodes]; static bool dseen[parser::max_nodes];
static int hids[headers::max_nodes]; static bool hseen[headers::max_nodes];
static int eids[expressions::max_nodes]; static bool eseen[expressions::max_nodes];
bool load(string input){lexer::reset();for(int i=0;i<input.length;i++)if(!lexer::append(input[i]))return false;return true;}
bool invalid(int id){parser::Node n=parser::node(id);return n.kind==parser::kind::Invalid&&n.start==0&&n.length==0&&n.line==0&&n.column==0&&n.name_start==0&&n.name_length==0&&!n.exported&&n.header==-1&&n.type==-1&&n.items==-1&&n.body==-1&&n.next==-1;}
bool check_d(int index,int kind,int start,int length,int line,int column,int ns,int nl,bool exported,int header,int type,int items,int body,int next){
 int id=dids[index];if(id<0||id>=parser::node_count()||dseen[id])return false;dseen[id]=true;parser::Node n=parser::node(id);
 if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.name_start!=ns||n.name_length!=nl||n.exported!=exported)return false;
 if(header==-1){if(n.header!=-1)return false;}else hids[header]=n.header;
 if(type==-1){if(n.type!=-1)return false;}else eids[type]=n.type;
 if(items==-1){if(n.items!=-1)return false;}else dids[items]=n.items;
 if(body==-1){if(n.body!=-1)return false;}else eids[body]=n.body;
 if(next==-1){if(n.next!=-1)return false;}else dids[next]=n.next;return true;
}
bool check_h(int index,int kind,int start,int length,int line,int column,int path,int alias,int items,int next){
 int id=hids[index];if(id<0||id>=headers::node_count()||hseen[id])return false;hseen[id]=true;headers::Node n=headers::node(id);
 if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column)return false;
 if(path==-1){if(n.path!=-1)return false;}else hids[path]=n.path;
 if(alias==-1){if(n.alias!=-1)return false;}else hids[alias]=n.alias;
 if(items==-1){if(n.items!=-1)return false;}else hids[items]=n.items;
 if(next==-1){if(n.next!=-1)return false;}else hids[next]=n.next;return true;
}
bool check_e(int index,int kind,int op,int start,int length,int line,int column,int value,string text,int left,int right,int next){
 int id=eids[index];if(id<0||id>=expressions::node_count()||eseen[id])return false;eseen[id]=true;expressions::Node n=expressions::node(id);
 if(n.kind!=kind||n.op!=op||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.value!=value||n.text_length!=text.length)return false;
 if(left==-1){if(n.left!=-1)return false;}else eids[left]=n.left;
 if(right==-1){if(n.right!=-1)return false;}else eids[right]=n.right;
 if(next==-1){if(n.next!=-1)return false;}else eids[next]=n.next;
 for(int i=0;i<text.length;i++)if(expressions::text_byte(id,i)!=int(text[i]))return false;
 return expressions::text_byte(id,-1)==-1&&expressions::text_byte(id,text.length)==-1;
}`;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    let assertions = '';
    if (fixture.error) {
      const at = position(fixture.input, fixture.start);
      assertions = `if(parser::parse()!=-1||parser::node_count()!=0||headers::node_count()!=0||expressions::node_count()!=0||!invalid(0))return false;
        parser::Diagnostic n=parser::diagnostic();if(n.kind!=parser::Error::${fixture.error}||n.header!=headers::Error::${fixture.header}||n.expression!=expressions::Error::${fixture.expression}||n.lexical!=lexer::Error::${fixture.lexical}||n.start!=${fixture.start}||n.length!=${fixture.length}||n.line!=${at.line}||n.column!=${at.column})return false;`;
    } else {
      const all = arenas(fixture.tree), chunks = [], tests = [];
      const ref = (arena, node) => all[arena].ids.get(node) ?? -1;
      for (const arena of ['d', 'h', 'e']) {
        const { nodes } = all[arena];
        assertions += `if(${{ d: 'parser', h: 'headers', e: 'expressions' }[arena]}::node_count()!=${nodes.length})return false;for(int i=0;i<${nodes.length};i++){${arena}seen[i]=false;${arena}ids[i]=-1;}`;
        for (const [id, node] of nodes.entries()) {
          const at = position(fixture.input, node.start), prefix = `${id},${{ d: 'parser', h: 'headers', e: 'expressions' }[arena]}::kind::${node.kind}`;
          const metadata = `${node.start},${node.length},${at.line},${at.column}`;
          let args;
          if (arena === 'd') args = `${prefix},${metadata},${node.nameStart},${node.nameLength},${node.exported},${ref('h', node.header)},${ref('e', node.type)},${ref('d', node.items)},${ref('e', node.body)},${ref('d', node.next)}`;
          if (arena === 'h') args = `${prefix},${metadata},${[node.path, node.alias, node.items, node.next].map(n => ref('h', n)).join(',')}`;
          if (arena === 'e') args = `${prefix},expressions::op::${node.op},${metadata},${node.value},${quote(node.text)},${[node.left, node.right, node.next].map(n => ref('e', n)).join(',')}`;
          tests.push(`if(!check_${arena}(${args}))return false;`);
        }
        checks[arena] += nodes.length * 2 * (fixture.passes ?? 2);
      }
      for (let at = 0; at < tests.length; at += 24) {
        const name = `check_${index}_${at}`; functions.push(`bool ${name}(){${tests.slice(at, at + 24).join('\n')}return true;}`); chunks.push(`if(!${name}())return false;`);
      }
      assertions = `int root=parser::parse();if(root==-1||!invalid(-1)||!invalid(parser::node_count()))return false;${assertions}dids[0]=root;lexer::rewind();lexer::next();${chunks.join('')}
        parser::Diagnostic n=parser::diagnostic();if(n.kind!=parser::Error::None||n.header!=headers::Error::None||n.expression!=expressions::Error::None||n.lexical!=lexer::Error::None||n.start!=0||n.length!=0||n.line!=1||n.column!=1)return false;`;
    }
    functions.push(`bool case_${index}(){if(!load(${quote(fixture.input)}))return false;for(int pass=0;pass<${fixture.passes ?? 2};pass++){${assertions}}return !lexer::append(byte(32));}`);
    cases.push(`if(!case_${index}())return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main; import l.compiler.lexer as lexer; import l.compiler.expressions as expressions; import l.compiler.headers as headers; import l.compiler.bindings as parser;${helpers}\n${functions.join('\n')}\nint main(){${cases.join('')}return 0;}`);
  try {
    command(0, ['run', source, '--manifest', manifest]); command(0, ['compile', source, '--manifest', manifest, '-o', output]);
    command(0, ['check', output]); command(0, ['run', output]);
  } catch (error) { throw new Error(`Fixtures: ${batch.map(f => f.name).join(', ')}\n${error.message}`, { cause: error }); }
  batches++;
}
let batch = [];
for (const fixture of fixtures) {
  if (fixture.input.length > 4000 || fixture.tree && Object.values(arenas(fixture.tree)).some(a => a.nodes.length > 100)) {
    if (batch.length) runBatch(batch); batch = []; runBatch([fixture]);
  } else { batch.push(fixture); if (batch.length === 5) { runBatch(batch); batch = []; } }
}
if (batch.length) runBatch(batch);

const source = resolve(work, 'main.l');
writeFileSync(source, `module tests.main;import l.compiler.lexer as lexer;import l.compiler.expressions as expressions;import l.compiler.bindings as parser;
bool load(string s){lexer::reset();for(int i=0;i<s.length;i++)if(!lexer::append(s[i]))return false;return true;}
int main(){for(int pass=0;pass<2;pass++){
 if(!load("module m; f=():int=>let x=1; in x; ")||parser::parse()==-1)return 1;
 if(!load("let in 1")||expressions::parse()!=-1||expressions::diagnostic().kind!=expressions::Error::TrailingInput)return 2;
 if(!load("let+in+var")||expressions::parse()==-1)return 6;
 if(!load("1+2")||expressions::parse()==-1)return 3;
 if(parser::parse()!=-1||parser::node_count()!=0||expressions::node_count()!=0)return 4;
 if(!load("module m; f=():int=>let in @;")||parser::parse()!=-1)return 5;
}return 0;}`);
const isolation = resolve(work, 'isolation.lbc');
command(0, ['run', source, '--manifest', manifest]); command(0, ['compile', source, '--manifest', manifest, '-o', isolation]);
command(0, ['check', isolation]); command(0, ['run', isolation]);
const driver = resolve(root, 'bootstrap/stage1/binding_main.l'), driverManifest = resolve(root, 'bootstrap/stage1/package.json'), output = resolve(work, 'binding.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['module m; pub add=(a:int,b:int):int=>a+b; main=():int=>let value:int=add(20,22); in value;', 0, ''],
  ['module m; main=():int=>let var x=0; in x=unknown();', 0, ''],
  ['module m; main=():void=>unknown(2147483648);', 0, ''],
  ['', 65, 'binding:1:1: error: source must begin with a module declaration\n'],
  ['module m; int main(){}', 65, 'binding:1:11: error: expected binding or parameter name\n'],
  ['module m; f=():int= >0;', 65, "binding:1:19: error: expected '=>' before function expression\n"],
  ['module m; f=():int=>let x=1 in x;', 65, "binding:1:29: error: expected ';' after local binding\n"],
  ['module m; f=():int=>let in @;', 65, 'binding:1:28: error: unsupported character in Stage 0 source\n'],
  [Buffer.concat([Buffer.from('module m;'), Buffer.alloc(65526, 32)]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'binding: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) command(status, args, { input, error });
console.log(`stage1 bindings: ${fixtures.length} fixtures, ${JSON.stringify(checks)} modeled node checks, ${batches} batches, ${commands} commands passed`);
