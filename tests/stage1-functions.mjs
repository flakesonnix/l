import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1-functions.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
const quote = value => `"${[...Buffer.from(value, 'latin1')].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
const position = (input, start) => ({ line: input.slice(0, start).split('\n').length,
  column: start - input.slice(0, start).lastIndexOf('\n') });
let commands = 0;
const counts = { f: 0, h: 0, s: 0, e: 0 };
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, ''); ++commands; return result;
}
const fnode = (kind, start, length, fields = {}) => ({ kind, start, length, declaredType: 'Invalid', typeName: null,
  nameStart: 0, nameLength: 0, exported: false, external: false, immutable: false, header: null, items: null, body: null,
  next: null, expression: null, array: null, ...fields });
const hnode = (kind, start, length, fields = {}) => ({ kind, start, length, path: null, alias: null, items: null, next: null, ...fields });
const snode = (kind, start, length, fields = {}) => ({ kind, start, length, expression: null, init: null, condition: null,
  step: null, body: null, other: null, next: null, declaredType: 'Invalid', typeName: null,
  nameStart: 0, nameLength: 0, immutable: false, array: null, declaration: null, ...fields });
const enode = (kind, start, length, fields = {}) => ({ kind, start, length, op: 'None', value: 0, text: '', left: null, right: null, next: null, ...fields });
const fixtures = [];
function bad(input, error, start = input.length, length = start === input.length ? 0 : 1, nested = {}) {
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 55))}`, input, error, start, length,
    headerError: 'None', statementError: 'None', expressionError: 'None', lexical: 'None', ...nested });
}
const integer = n => ({ kind: 'Integer', value: n });
const named = name => ({ kind: 'Name', name });
const empty = () => ({ kind: 'Empty' });
const block = children => ({ kind: 'Block', children });
const fn = (options = {}) => ({ type: 'Int', name: 'f', parameters: [], body: block([]), ...options });
const namespace = (name, children = []) => ({ kind: 'Namespace', name, children });
const alias = (type, options = {}) => ({ kind: 'Alias', type, name: 'Count', ...options });
const storage = (kind, type, options = {}) => ({ kind, type, name: 'value', value: integer(1), ...options });
const parameter = (type, options = {}) => ({ type, name: 'p', ...options });
const local = (type, options = {}) => ({ kind: 'Declaration', type, name: 'local', value: integer(1), ...options });

// Independent trees are emitted with exact spans, not reparsed into an oracle.
function rendered(name, tree, options = {}) {
  let input = options.leading ?? '';
  const gap = options.gap ?? ' ';
  const put = text => { const start = input.length; input += text; return start; };
  function chain(text, separator, factory) {
    let first = null, last = null;
    for (const part of text.split(separator)) {
      if (last) put(separator);
      const item = factory('Name', put(part), part.length);
      if (last) { if (separator === '::') last.right = item; else last.next = item; } else first = item;
      last = item;
    }
    return first;
  }
  function type(tree) {
    if (tree.type === 'Named') return chain(tree.typeName ?? 'ns::T', '::', enode);
    put(tree.type.toLowerCase()); return null;
  }
  function expr(tree) {
    if (tree.kind === 'Integer') { const text = String(tree.value); return enode('Integer', put(text), text.length, { value: -tree.value }); }
    if (tree.kind === 'Bool') { const text = String(tree.value); return enode('Bool', put(text), text.length, { value: Number(tree.value) }); }
    if (tree.kind === 'Name') return chain(tree.name, '::', enode);
    if (tree.kind === 'Text') { const text = quote(tree.text); return enode('Text', put(text), text.length, { text: tree.text }); }
    if (tree.kind === 'Chain') {
      let result = enode('Name', put('x'), 1);
      for (let index = 0; index < tree.count; index++) result = enode('Postfix', put('++'), 2, { op: 'Increment', left: result });
      return result;
    }
    put('('); const left = expr(tree.left); put(' ');
    const result = enode(tree.operator === '=' ? 'Assign' : 'Binary', put(tree.operator), tree.operator.length,
      { op: ({ '=': 'Assign', '+': 'Plus', '<': 'Less' })[tree.operator], left });
    put(' '); result.right = expr(tree.right); put(')'); return result;
  }
  function stmt(tree) {
    if (tree.kind === 'Block') {
      const result = snode('Block', put('{'), 1); let last = null;
      for (const child of tree.children) {
        put(gap); const item = stmt(child);
        if (last) last.next = item; else result.body = item;
        last = item;
      }
      put('}'); return result;
    }
    if (tree.kind === 'Empty') return snode('Empty', put(';'), 1);
    if (tree.kind === 'Declaration') {
      const result = snode('Declaration', input.length, tree.immutable ? 5 : tree.type === 'Named' ? (tree.typeName ?? 'ns::T').split('::')[0].length : tree.type.toLowerCase().length,
        { declaredType: tree.type, immutable: !!tree.immutable });
      if (tree.immutable) put(`const${gap}`);
      result.typeName = type(tree); put(gap); result.nameStart = put(tree.name); result.nameLength = tree.name.length;
      if (tree.array) { put('['); result.array = expr(tree.array); put(']'); }
      else { put('='); result.expression = expr(tree.value); }
      put(';'); return result;
    }
    if (['Return', 'Break', 'Continue'].includes(tree.kind)) {
      const text = tree.kind.toLowerCase(), result = snode(tree.kind, put(text), text.length);
      if (tree.value) { put(gap); result.expression = expr(tree.value); }
      put(';'); return result;
    }
    if (tree.kind === 'Expression') {
      const start = input.length, value = expr(tree.value), text = input.slice(start);
      const token = /^[A-Za-z_][A-Za-z_0-9]*|^[0-9]+|^"(?:[^"\\]|\\.)*"/.exec(text);
      const result = snode('Expression', start, token ? token[0].length : 1, { expression: value }); put(';'); return result;
    }
    const keyword = tree.kind.toLowerCase(), result = snode(tree.kind, put(keyword), keyword.length);
    put('(');
    if (tree.kind === 'For') {
      result.declaration = stmt(tree.declaration); result.condition = expr(tree.condition); put(';'); result.step = expr(tree.step);
    } else result.condition = expr(tree.condition);
    put(')'); result.body = stmt(tree.body);
    if (tree.other) { put(`${gap}else${gap}`); result.other = stmt(tree.other); }
    return result;
  }
  const heading = hnode('Module', put('module'), 6);
  const result = fnode('Module', heading.start, 6, { header: heading });
  put(gap); heading.path = chain(tree.module ?? 'app.main', '.', hnode); put(';');
  let lastImport = null;
  for (const imported of tree.imports ?? []) {
    put(gap); const item = hnode('Import', put('import'), 6);
    put(gap); item.path = chain(imported.path, '.', hnode);
    if (imported.alias) { put(`${gap}as${gap}`); item.alias = hnode('Name', put(imported.alias), imported.alias.length); }
    put(';');
    if (lastImport) lastImport.next = item; else heading.items = item;
    lastImport = item;
  }
  function declarations(trees) {
    let first = null, last = null;
    for (const functionTree of trees) {
      put(gap);
      if (functionTree.kind === 'Namespace') {
        const item = fnode('Namespace', put('namespace'), 9);
        put(gap); item.nameStart = put(functionTree.name); item.nameLength = functionTree.name.length;
        put('{'); item.items = declarations(functionTree.children); put('}');
        if (last) last.next = item; else first = item;
        last = item; continue;
      }
      if (functionTree.kind === 'Alias') {
        const item = fnode('Alias', input.length, functionTree.exported ? 3 : 5,
          { declaredType: functionTree.type, exported: !!functionTree.exported });
        if (functionTree.exported) put(`pub${gap}`);
        put(`using${gap}`); item.nameStart = put(functionTree.name); item.nameLength = functionTree.name.length;
        put('='); item.typeName = type(functionTree); put(';');
        if (last) last.next = item; else first = item;
        last = item; continue;
      }
      if (functionTree.kind === 'Constant' || functionTree.kind === 'Static') {
        const keyword = functionTree.kind === 'Static' ? 'static' : 'const';
        const item = fnode(functionTree.kind, input.length, functionTree.exported ? 3 : keyword.length,
          { declaredType: functionTree.type, exported: !!functionTree.exported, immutable: functionTree.kind === 'Constant' });
        if (functionTree.exported) put(`pub${gap}`);
        put(`${keyword}${gap}`); item.typeName = type(functionTree); put(gap);
        item.nameStart = put(functionTree.name); item.nameLength = functionTree.name.length;
        if (functionTree.array) { put('['); item.array = expr(functionTree.array); put(']'); }
        else { put('='); item.expression = expr(functionTree.value); }
        put(';');
        if (last) last.next = item; else first = item;
        last = item; continue;
      }
      const item = fnode('Function', input.length, functionTree.exported ? 3 : functionTree.external ? 6 : functionTree.type === 'Named' ? (functionTree.typeName ?? 'ns::T').split('::')[0].length : functionTree.type.toLowerCase().length,
        { declaredType: functionTree.type, exported: !!functionTree.exported, external: !!functionTree.external });
      if (functionTree.exported) put(`pub${gap}`);
      if (functionTree.external) put(`extern${gap}`);
      item.typeName = type(functionTree); put(gap); item.nameStart = put(functionTree.name); item.nameLength = functionTree.name.length; put('(');
      let previous = null;
      for (const tree of functionTree.parameters) {
        if (previous) put(`,${gap}`);
        const part = fnode('Parameter', input.length, tree.immutable ? 5 : tree.type === 'Named' ? (tree.typeName ?? 'ns::T').split('::')[0].length : tree.type.toLowerCase().length,
          { declaredType: tree.type, immutable: !!tree.immutable });
        if (tree.immutable) put(`const${gap}`);
        part.typeName = type(tree); put(gap); part.nameStart = put(tree.name); part.nameLength = tree.name.length;
        if (previous) previous.next = part; else item.items = part;
        previous = part;
      }
      put(')');
      if (functionTree.external) put(';'); else item.body = stmt(functionTree.body);
      if (last) last.next = item; else first = item;
      last = item;
    }
    return first;
  }
  result.items = declarations(tree.functions ?? []);
  put(options.trailing ?? '');
  const fixture = { name, input, tree: result }; fixtures.push(fixture); return fixture;
}
rendered('header only', {});
rendered('imports and functions', { imports: [{ path: 'std.io', alias: 'io' }], functions: [
  fn({ name: 'first', exported: true, parameters: [parameter('Named', { typeName: 'pkg::Record', immutable: true })],
    body: block([local('String', { value: { kind: 'Text', text: 'old\0\xff' } }), { kind: 'Return', value: named('p') }]) }),
  fn({ name: 'second', type: 'Named', typeName: 'pkg::Record', external: true, exported: true }),
  fn({ name: 'third', body: block([{ kind: 'Return', value: { kind: 'Text', text: 'last' } }]) }),
] });
for (const type of ['Int', 'Bool', 'Byte', 'String', 'Void', 'Auto', 'Named']) {
  for (const external of [false, true]) for (const immutable of [false, true]) {
    rendered(`signature ${type} ${external} ${immutable}`, { functions: [fn({ type, external, exported: immutable,
      parameters: [parameter(type, { immutable })] })] });
  }
}
for (const name of ['constructor', '__proto__', 'toString']) rendered(`identifier ${name}`, { functions: [fn({ name, parameters: [parameter('Int', { name })] })] });
for (const gap of ['\n', '\t', '/*gap*/', '//gap\n']) rendered(`trivia ${JSON.stringify(gap)}`, { functions: [fn({ exported: true,
  type: 'Named', parameters: [parameter('Named', { immutable: true })], body: block([local('Named'), { kind: 'Return', value: integer(1) }]) })] },
  { gap, leading: '\n/*lead\xff*/\t', trailing: '\n//end\xff' });
rendered('syntax-only contexts and duplicate names', { functions: [
  fn({ type: 'Void', parameters: [parameter('Void'), parameter('Auto')], body: block([{ kind: 'Break' }, { kind: 'Continue' },
    local('Void'), local('Int', { immutable: true, array: named('unknown') }), { kind: 'Return', value: named('missing') }]) }),
  fn(), fn({ external: true }),
] });
rendered('empty namespace', { functions: [namespace('n')] });
rendered('nested and reopened namespaces', { imports: [{ path: 'pkg.types', alias: 'types' }], functions: [
  fn({ name: 'before' }),
  namespace('n', [fn({ name: 'private_value' }), namespace('inner', [fn({ name: 'public_value', exported: true,
    type: 'Named', typeName: 'types::T', parameters: [parameter('Named', { typeName: 'types::T', immutable: true })],
    body: block([{ kind: 'Return', value: { kind: 'Text', text: 'kept\0\xff' } }]) })])]),
  namespace('n', [fn({ name: 'private_value', external: true, exported: true })]),
  fn({ name: 'after', type: 'Named', body: block([{ kind: 'Return', value: named('n::inner::value') }]) }),
] });
for (const name of ['constructor', '__proto__', 'Namespace', 'namespaceX']) {
  rendered(`namespace identifier ${name}`, { functions: [namespace(name, [fn()])] });
}
for (const gap of ['\n', '\t', '/*gap*/', '//gap\n']) rendered(`namespace trivia ${JSON.stringify(gap)}`, {
  functions: [namespace('outer', [namespace('inner', [fn({ exported: true })]), namespace('inner')])],
}, { gap, leading: '\n/*before\xff*/\t', trailing: '\n//after\xff' });
let state = 0x29bc361f;
function random(n) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 0x100000000 * n); }
const types = ['Int', 'Bool', 'Byte', 'String', 'Void', 'Auto', 'Named'];
const value = () => [integer(random(100)), named('ns::value'), { kind: 'Text', text: `x${String.fromCharCode(random(256))}` }][random(3)];
const generatedStart = fixtures.length;
for (let index = 0; index < 64; index++) {
  rendered(`generated ${index}`, { functions: Array.from({ length: random(4) + 1 }, (_, n) => fn({ name: `f${n}`,
    type: types[random(7)], external: !!random(2), exported: !!random(2),
    parameters: Array.from({ length: random(5) }, (_, p) => parameter(types[random(7)], { name: `p${p}`, immutable: !!random(2) })),
    body: block([local(types[random(7)], { immutable: !!random(2), value: value() }),
      { kind: 'If', condition: value(), body: block([{ kind: 'Return', value: value() }]), other: block([empty()]) },
      { kind: 'For', declaration: local('Int', { name: 'i', value: integer(0) }),
        condition: { kind: 'Binary', operator: '<', left: named('i'), right: integer(3) },
        step: { kind: 'Binary', operator: '=', left: named('i'), right: integer(1) }, body: block([{ kind: 'Continue' }]) },
      { kind: 'Return', value: value() }]),
  })) });
}
const generated = fixtures.slice(generatedStart).flatMap(f => flatten([f.tree], ['items', 'next']).nodes);
for (const type of types) for (const kind of ['Function', 'Parameter']) assert.ok(generated.some(n => n.kind === kind && n.declaredType === type), `missing ${kind} ${type}`);
for (const field of ['exported', 'external', 'immutable']) assert.ok(generated.some(n => n[field]), `missing ${field}`);
const generatedArenas = fixtures.slice(generatedStart).map(f => arenas(f.tree));
for (const kind of ['Integer', 'Name', 'Text']) assert.ok(generatedArenas.some(a => a.e.nodes.some(n => n.kind === kind)), `missing generated ${kind} leaf`);
for (const kind of ['Block', 'Declaration', 'Return', 'If', 'For', 'Continue', 'Empty']) {
  assert.ok(generatedArenas.some(a => a.s.nodes.some(n => n.kind === kind)), `missing generated ${kind} statement`);
}

for (const [text, error, marker, nested] of [
  ['', 'ExpectedType', ''], ['int', 'ExpectedName', ''], ['int f', 'ExpectedOpen', ''], ['int f(', 'ExpectedType', ''],
  ['int f(void)', 'ExpectedName', ')'], ['int f(int)', 'ExpectedName', ')'], ['int f(int p,)', 'ExpectedType', ')'],
  ['int f(int p=1){}', 'ExpectedClose', '='], ['int f(const p){}', 'ExpectedName', ')'],
  ['int f(int p[3]){}', 'ArrayParameter', '['], ['extern int f(){}', 'ExpectedSemicolon', '{'],
  ['int f();', 'ExpectedBody', ';'], ['int f()return 1;', 'ExpectedBody', 'return'], ['extern pub int f();', 'ExpectedType', 'pub'],
  ['int ns::f(){}', 'ExpectedOpen', '::'], ['ns.T f(){}', 'ExpectedName', '.'], ['int f(int p int q){}', 'ExpectedClose', 'int q'],
  ['int f(){} import p;', 'MisplacedHeader', 'import'], ['int f(){} pub import p;', 'MisplacedHeader', 'import'],
  ['int f(){} module n;', 'MisplacedHeader', 'module'], ['int f(){return 1}', 'Statement', '}', { statementError: 'ExpectedSemicolon' }],
  ['int f(){return @;}', 'Statement', '@', { statementError: 'Expression', expressionError: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['int @', 'Expression', '@', { expressionError: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['ns:: f(){}', 'ExpectedName', '('], ['int f(){} }', 'ExpectedType', '}'],
  ['struct T{};', 'ExpectedType', 'struct'], ['enum E{};', 'ExpectedType', 'enum'],
]) {
  // Empty text after a valid header is valid; test its missing module separately.
  if (!text) continue;
  const input = 'module m; ' + text;
  const start = marker === '}' ? input.lastIndexOf('}') : marker ? input.indexOf(marker, 10) : input.length;
  const length = marker && /^[A-Za-z]/.test(marker) ? marker.split(' ')[0].length : marker === '::' ? 2 : undefined;
  bad(input, error, start, length, nested);
}
bad('', 'Header', 0, 0, { headerError: 'ExpectedModule' });
bad('module m; import p::*;', 'Header', 20, 1, { headerError: 'ExpectedSelection' });
bad('module m; @', 'Header', 10, 1, { headerError: 'Lexical', lexical: 'UnsupportedCharacter' });
const maximumFunctions = rendered('maximum functions', { functions: Array.from({ length: 256 }, (_, i) => fn({ name: `f${i}`, external: true })) });
const overflowFunctions = rendered('overflow functions', { functions: Array.from({ length: 257 }, (_, i) => fn({ name: `f${i}`, external: true })) });
fixtures.pop();
let lastFunction = overflowFunctions.tree.items; while (lastFunction.next) lastFunction = lastFunction.next;
bad(overflowFunctions.input, 'TooManyFunctions', lastFunction.start, lastFunction.length);
rendered('full function arena', { functions: [fn({ external: true, parameters: Array.from({ length: 1022 }, () => parameter('Int')) })] });
const overflowArena = rendered('overflow function arena', { functions: [fn({ external: true, parameters: Array.from({ length: 1023 }, () => parameter('Int')) })] });
fixtures.pop();
let lastParameter = overflowArena.tree.items.items; while (lastParameter.next) lastParameter = lastParameter.next;
bad(overflowArena.input, 'TooManyNodes', lastParameter.start, lastParameter.length);
rendered('shared statement arena', { functions: [fn({ body: block(Array.from({ length: 1021 }, empty)) }), fn({ body: block([empty()]) })] });
const statementOverflow = rendered('overflow shared statement arena', { functions: [fn({ body: block(Array.from({ length: 1021 }, empty)) }), fn({ body: block([empty(), empty()]) })] });
fixtures.pop(); const extra = statementOverflow.tree.items.next.body.body.next;
bad(statementOverflow.input, 'Statement', extra.start, extra.length, { statementError: 'TooManyNodes' });
rendered('shared expression arena', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }), fn({ type: 'Named', typeName: 'T' })] });
const expressionOverflow = rendered('overflow shared expression arena', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }), fn({ type: 'Named', typeName: 'ns::T' })] });
fixtures.pop(); const missing = expressionOverflow.tree.items.next.typeName.right;
bad(expressionOverflow.input, 'Expression', missing.start, missing.length, { expressionError: 'TooManyNodes' });
let nested = empty(); for (let i = 0; i < 47; i++) nested = block([nested]);
rendered('maximum function body depth', { functions: [fn({ body: nested })] });
const depthOverflow = rendered('overflow function body depth', { functions: [fn({ body: block([nested]) })] });
fixtures.pop(); let deepest = depthOverflow.tree.items.body; while (deepest.body) deepest = deepest.body;
bad(depthOverflow.input, 'Statement', deepest.start, deepest.length, { statementError: 'TooDeep', expressionError: 'TooDeep' });
rendered('independent full header arena', { module: Array(2047).fill('x').join('.'), functions: [fn({ external: true })] });
const headerOverflow = 'module ' + Array(2048).fill('x').join('.') + ';';
bad(headerOverflow, 'Header', headerOverflow.length - 2, 1, { headerError: 'TooManyNodes' });

for (const [text, error, marker] of [
  ['namespace {}', 'ExpectedNamespaceName', '{'], ['namespace const {}', 'ExpectedNamespaceName', 'const'],
  ['namespace n;', 'ExpectedNamespaceOpen', ';'], ['namespace a.b{}', 'ExpectedNamespaceOpen', '.'],
  ['namespace a::b{}', 'ExpectedNamespaceOpen', '::'], ['namespace n{', 'ExpectedNamespaceClose', ''],
  ['namespace n{namespace inner{}', 'ExpectedNamespaceClose', ''],
  ['pub namespace n{}', 'NamespaceVisibility', 'pub'], ['namespace n{pub namespace inner{}}', 'NamespaceVisibility', 'pub'],
  ['namespace n{import p;}', 'MisplacedHeader', 'import'], ['namespace n{pub import p;}', 'MisplacedHeader', 'import'],
  ['namespace n{module other;}', 'MisplacedHeader', 'module other'], ['namespace n{} import p;', 'MisplacedHeader', 'import'],
  ['namespace n{};', 'ExpectedType', ';'],
  ['extern namespace n{}', 'ExpectedType', 'namespace'],
]) {
  const input = 'module m; ' + text;
  const start = marker ? input.indexOf(marker, 10) : input.length;
  const length = marker && /^[A-Za-z]/.test(marker) ? marker.split(' ')[0].length : marker === '::' ? 2 : undefined;
  bad(input, error, start, length);
}
bad('module m; namespace n{int f(){return @;}}', 'Statement', 37, 1,
  { statementError: 'Expression', expressionError: 'Lexical', lexical: 'UnsupportedCharacter' });
bad('module m; namespace n{@}', 'Expression', 22, 1,
  { expressionError: 'Lexical', lexical: 'UnsupportedCharacter' });
let deepNamespace = namespace('n');
for (let index = 1; index < 48; index++) deepNamespace = namespace('n', [deepNamespace]);
rendered('maximum namespace depth', { functions: [deepNamespace] });
const namespaceDepthOverflow = rendered('overflow namespace depth', { functions: [namespace('n', [deepNamespace])] });
fixtures.pop(); let deepestNamespace = namespaceDepthOverflow.tree.items; while (deepestNamespace.items) deepestNamespace = deepestNamespace.items;
bad(namespaceDepthOverflow.input, 'TooDeep', deepestNamespace.start, deepestNamespace.length, { expressionError: 'TooDeep' });
let mixedNamespace = fn();
for (let index = 0; index < 47; index++) mixedNamespace = namespace('n', [mixedNamespace]);
rendered('maximum namespace and body depth', { functions: [mixedNamespace] });
const mixedNamespaceOverflow = rendered('overflow namespace and body depth', { functions: [namespace('n', [mixedNamespace])] });
fixtures.pop(); let deepestFunction = mixedNamespaceOverflow.tree.items; while (deepestFunction.kind === 'Namespace') deepestFunction = deepestFunction.items;
bad(mixedNamespaceOverflow.input, 'Statement', deepestFunction.body.start, 1, { statementError: 'TooDeep', expressionError: 'TooDeep' });
rendered('full namespace arena and no function count', { functions: Array.from({ length: 1023 }, () => namespace('n')) });
const namespaceArenaOverflow = rendered('overflow namespace arena', { functions: Array.from({ length: 1024 }, () => namespace('n')) });
fixtures.pop(); let lastNamespace = namespaceArenaOverflow.tree.items; while (lastNamespace.next) lastNamespace = lastNamespace.next;
bad(namespaceArenaOverflow.input, 'TooManyNodes', lastNamespace.start, 9);
rendered('namespace parameter arena', { functions: [namespace('n', [fn({ external: true, parameters: Array.from({ length: 1021 }, () => parameter('Int')) })])] });
const namespaceParameterOverflow = rendered('overflow namespace parameters', { functions: [namespace('n', [fn({ external: true, parameters: Array.from({ length: 1022 }, () => parameter('Int')) })])] });
fixtures.pop(); let finalParameter = namespaceParameterOverflow.tree.items.items.items; while (finalParameter.next) finalParameter = finalParameter.next;
bad(namespaceParameterOverflow.input, 'TooManyNodes', finalParameter.start, finalParameter.length);
rendered('function count across namespaces', { functions: ['a', 'b'].map(name => namespace(name,
  Array.from({ length: 128 }, (_, i) => fn({ name: `f${i}`, external: true })))) });
const namespaceFunctionOverflow = rendered('overflow namespace function count', { functions: ['a', 'b'].map((name, index) => namespace(name,
  Array.from({ length: 128 + index }, (_, i) => fn({ name: `f${i}`, external: true })))) });
fixtures.pop(); let finalFunction = namespaceFunctionOverflow.tree.items.next.items; while (finalFunction.next) finalFunction = finalFunction.next;
bad(namespaceFunctionOverflow.input, 'TooManyFunctions', finalFunction.start, finalFunction.length);
rendered('statement budget across namespaces', { functions: [namespace('a', [fn({ body: block(Array.from({ length: 1021 }, empty)) })]),
  namespace('b', [fn({ body: block([empty()]) })])] });
const namespaceStatementOverflow = rendered('overflow namespace statements', { functions: [namespace('a', [fn({ body: block(Array.from({ length: 1021 }, empty)) })]),
  namespace('b', [fn({ body: block([empty(), empty()]) })])] });
fixtures.pop(); const namespaceExtra = namespaceStatementOverflow.tree.items.next.items.body.body.next;
bad(namespaceStatementOverflow.input, 'Statement', namespaceExtra.start, 1, { statementError: 'TooManyNodes' });
rendered('expression budget across namespaces', { functions: [namespace('a', [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) })]),
  namespace('b', [fn({ type: 'Named', typeName: 'T' })])] });
const namespaceExpressionOverflow = rendered('overflow namespace expressions', { functions: [namespace('a', [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) })]),
  namespace('b', [fn({ type: 'Named', typeName: 'ns::T' })])] });
fixtures.pop(); const namespaceMissing = namespaceExpressionOverflow.tree.items.next.items.typeName.right;
bad(namespaceExpressionOverflow.input, 'Expression', namespaceMissing.start, 1, { expressionError: 'TooManyNodes' });

const generatedNamespaceStart = fixtures.length;
function namespaceTree(depth) {
  const children = Array.from({ length: random(3) + 1 }, (_, i) => {
    if (depth && random(2)) return namespaceTree(depth - 1);
    return fn({ name: `f${i}`, type: types[random(7)], exported: !!random(2), external: !!random(2),
      parameters: [parameter(types[random(7)], { immutable: !!random(2) })],
      body: block([local('String', { value: { kind: 'Text', text: `ns${String.fromCharCode(random(256))}` } }), { kind: 'Return', value: value() }]) });
  });
  return namespace(`n${random(3)}`, children);
}
for (let index = 0; index < 32; index++) rendered(`generated namespace ${index}`, { functions: [namespaceTree(3), fn({ name: 'between' }), namespaceTree(2)] });
const generatedNamespaceNodes = fixtures.slice(generatedNamespaceStart).flatMap(f => flatten([f.tree], ['items', 'next']).nodes);
for (const kind of ['Namespace', 'Function', 'Parameter']) assert.ok(generatedNamespaceNodes.some(n => n.kind === kind), `missing generated namespace ${kind}`);
assert.ok(generatedNamespaceNodes.some(n => n.kind === 'Namespace' && n.items?.kind === 'Namespace'), 'generated namespaces must nest');
assert.ok(generatedNamespaceNodes.some(n => n.kind === 'Function' && n.exported), 'generated namespaces must contain pub functions');
assert.ok(generatedNamespaceNodes.some(n => n.kind === 'Function' && n.external), 'generated namespaces must contain extern functions');

for (const type of types) for (const exported of [false, true]) for (const scoped of [false, true]) {
  const item = alias(type, { exported });
  rendered(`alias ${type} ${exported} ${scoped}`, { functions: [scoped ? namespace('n', [item]) : item] });
}
for (const name of ['constructor', '__proto__', 'Using', 'usingX']) rendered(`alias identifier ${name}`, { functions: [alias('Int', { name })] });
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`alias trivia ${JSON.stringify(gap)}`, {
  functions: [alias('Named', { typeName: 'pkg::types::Value', exported: true }), namespace('n', [alias('Byte')])],
}, { gap, leading: '\n/*before\xff*/\t', trailing: '\n//after\xff' });
rendered('aliases remain syntax only', { functions: [
  alias('Named', { name: 'Forward', typeName: 'n::Later', exported: true }),
  alias('Named', { name: 'Self', typeName: 'Self' }),
  namespace('n', [alias('Named', { name: 'Later', typeName: 'Other' }), alias('Named', { name: 'Other', typeName: 'Later' })]),
  namespace('n', [alias('Void', { name: 'Later', exported: true }), alias('Auto', { name: 'Other' })]),
  fn({ type: 'Named', typeName: 'Forward', parameters: [parameter('Named', { typeName: 'Self' })] }),
] });
rendered('aliases preserve earlier strings and declaration order', { functions: [
  fn({ name: 'first', body: block([{ kind: 'Return', value: { kind: 'Text', text: 'old\0\xff' } }]) }),
  alias('Named', { name: 'Alias', typeName: 'unknown::Type', exported: true }),
  namespace('n', [alias('Named', { typeName: 'Alias' }), fn({ name: 'nested', type: 'Named', typeName: 'Count' })]),
  fn({ name: 'last', body: block([{ kind: 'Return', value: { kind: 'Text', text: 'last\x80' } }]) }),
] });
for (const [text, error, marker, nested] of [
  ['using;', 'ExpectedAliasName', ';'], ['using int=int;', 'ExpectedAliasName', 'int'],
  ['using T;', 'ExpectedAliasAssign', ';'], ['using T::U=int;', 'ExpectedAliasAssign', '::'],
  ['using T.U=int;', 'ExpectedAliasAssign', '.'], ['using T=', 'ExpectedType', ''],
  ['using T=;', 'ExpectedType', ';'], ['using T=const int;', 'ExpectedType', 'const'],
  ['using T=int', 'ExpectedAliasSemicolon', ''], ['using T=int[3];', 'ExpectedAliasSemicolon', '['],
  ['using T=int(1);', 'ExpectedAliasSemicolon', '('], ['using T=ns.Type;', 'ExpectedAliasSemicolon', '.'],
  ['using T=ns::;', 'Expression', ';', { expressionError: 'ExpectedName' }],
  ['using T=@;', 'Expression', '@', { expressionError: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['extern using T=int;', 'ExpectedType', 'using'], ['using T=int; import p;', 'MisplacedHeader', 'import'],
  ['using T=int; module other;', 'MisplacedHeader', 'module other'],
  ['int f(){using T=int;}', 'Statement', 'using', { statementError: 'Expression', expressionError: 'ExpectedExpression' }],
  ['int f(){return "old";} namespace n{using T=;}', 'ExpectedType', ';}'],
]) {
  const input = 'module m; ' + text;
  const start = marker === ';}' ? input.lastIndexOf(marker) : marker ? input.indexOf(marker, 10) : input.length;
  const length = marker && /^[A-Za-z]/.test(marker) ? marker.split(' ')[0].length : marker === '::' ? 2 : undefined;
  bad(input, error, start, length, nested);
}
rendered('full alias arena and no function count', { functions: Array.from({ length: 1023 }, () => alias('Int')) });
const aliasArenaOverflow = rendered('overflow alias arena', { functions: Array.from({ length: 1024 }, () => alias('Int')) });
fixtures.pop(); let finalAlias = aliasArenaOverflow.tree.items; while (finalAlias.next) finalAlias = finalAlias.next;
bad(aliasArenaOverflow.input, 'TooManyNodes', finalAlias.start, finalAlias.length);
rendered('alias and parameter shared arena', { functions: [alias('Int'), fn({ external: true,
  parameters: Array.from({ length: 1021 }, () => parameter('Int')) })] });
const aliasParameterOverflow = rendered('overflow alias and parameter arena', { functions: [alias('Int'), fn({ external: true,
  parameters: Array.from({ length: 1022 }, () => parameter('Int')) })] });
fixtures.pop(); let aliasLastParameter = aliasParameterOverflow.tree.items.next.items; while (aliasLastParameter.next) aliasLastParameter = aliasLastParameter.next;
bad(aliasParameterOverflow.input, 'TooManyNodes', aliasLastParameter.start, aliasLastParameter.length);
rendered('full alias target expression arena', { functions: [alias('Named', { typeName: Array(2048).fill('x').join('::') })] });
const aliasTargetOverflow = rendered('overflow alias target arena', { functions: [alias('Named', { typeName: Array(2049).fill('x').join('::') })] });
fixtures.pop(); let aliasLastSegment = aliasTargetOverflow.tree.items.typeName; while (aliasLastSegment.right) aliasLastSegment = aliasLastSegment.right;
bad(aliasTargetOverflow.input, 'Expression', aliasLastSegment.start, 1, { expressionError: 'TooManyNodes' });
rendered('alias expression budget after function body', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }),
  namespace('n', [alias('Named', { typeName: 'T' })])] });
const aliasExpressionOverflow = rendered('overflow alias expression budget after body', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }),
  namespace('n', [alias('Named', { typeName: 'ns::T' })])] });
fixtures.pop(); const aliasMissing = aliasExpressionOverflow.tree.items.next.items.typeName.right;
bad(aliasExpressionOverflow.input, 'Expression', aliasMissing.start, 1, { expressionError: 'TooManyNodes' });
rendered('aliases do not consume function budget', { functions: [alias('Int'), namespace('n', [alias('Named'),
  ...Array.from({ length: 256 }, (_, i) => fn({ name: `f${i}`, external: true }))])] });
let deepestAlias = alias('Named'); for (let index = 0; index < 48; index++) deepestAlias = namespace('n', [deepestAlias]);
rendered('alias at maximum namespace depth', { functions: [deepestAlias] });

const generatedAliasStart = fixtures.length;
for (let index = 0; index < 32; index++) {
  const aliases = Array.from({ length: random(5) + 2 }, (_, i) => alias(types[random(7)], {
    name: `A${i}`, typeName: ['Forward', 'pkg::T', 'types::nested::Value'][random(3)], exported: !!random(2),
  }));
  rendered(`generated aliases ${index}`, { functions: [aliases[0], namespace('n', [
    ...aliases.slice(1), fn({ type: 'Named', typeName: 'A1', parameters: [parameter('Named', { typeName: 'A0' })],
      body: block([{ kind: 'Return', value: { kind: 'Text', text: `alias${String.fromCharCode(random(256))}` } }]) }),
  ]), namespace('n', [alias('Named', { name: 'Forward', typeName: 'A0' })])] });
}
const generatedAliasNodes = fixtures.slice(generatedAliasStart).flatMap(f => flatten([f.tree], ['items', 'next']).nodes);
for (const type of types) assert.ok(generatedAliasNodes.some(n => n.kind === 'Alias' && n.declaredType === type), `missing generated alias ${type}`);
for (const exported of [false, true]) assert.ok(generatedAliasNodes.some(n => n.kind === 'Alias' && n.exported === exported), `missing alias visibility ${exported}`);

for (const type of types) for (const kind of ['Constant', 'Static']) for (const exported of [false, true]) for (const scoped of [false, true]) {
  const item = storage(kind, type, { exported });
  rendered(`global ${kind} ${type} ${exported} ${scoped}`, { functions: [scoped ? namespace('n', [item]) : item] });
}
for (const type of types) for (const exported of [false, true]) for (const scoped of [false, true]) {
  const item = storage('Static', type, { array: integer(3), exported });
  rendered(`static array ${type} ${exported} ${scoped}`, { functions: [scoped ? namespace('n', [item]) : item] });
}
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`global trivia ${JSON.stringify(gap)}`, { functions: [
  storage('Constant', 'String', { exported: true, value: { kind: 'Text', text: 'a\0\xff' } }),
  namespace('n', [storage('Static', 'Named', { typeName: 'pkg::Record', array: named('size') })]),
] }, { gap, leading: '\n/*lead\xff*/\t', trailing: '\n//end\xff' });
for (const name of ['constructor', '__proto__', 'Static', 'constX']) rendered(`global identifier ${name}`, { functions: [storage('Static', 'Int', { name })] });
rendered('storage is syntax only and strings survive scopes', { imports: [{ path: 'missing.types', alias: 'types' }], functions: [
  storage('Constant', 'String', { name: 'first', value: { kind: 'Text', text: 'first\0\xff' } }),
  fn({ body: block([local('Int', { name: 'value', immutable: true }), { kind: 'Return', value: { kind: 'Text', text: 'body\x80' } }]) }),
  alias('Named', { name: 'T', typeName: 'types::Record' }),
  namespace('n', [storage('Static', 'Named', { typeName: 'T', array: { kind: 'Bool', value: true }, exported: true })]),
  namespace('n', [storage('Constant', 'Void'), storage('Static', 'Auto', { value: named('unknown') })]),
  storage('Static', 'String', { name: 'first', value: { kind: 'Text', text: 'last' } }),
] });
for (const [text, error, marker, nested] of [
  ['const int =1;', 'ExpectedGlobalName', '='], ['static int =1;', 'ExpectedGlobalName', '='],
  ['const int x;', 'ExpectedGlobalInitializer', ';'], ['static int x;', 'ExpectedGlobalInitializer', ';'],
  ['const int a[2];', 'ExpectedGlobalInitializer', '['], ['static int a[2]=0;', 'ArrayInitializer', '='],
  ['static int a[];', 'Expression', ']', { expressionError: 'ExpectedExpression' }],
  ['static int a[2;', 'ExpectedArrayClose', ';'], ['static int a[2][3];', 'ExpectedGlobalSemicolon', '[3]'],
  ['const int x=;', 'Expression', ';', { expressionError: 'ExpectedExpression' }],
  ['static int x=;', 'Expression', ';', { expressionError: 'ExpectedExpression' }],
  ['static int x=0', 'ExpectedGlobalSemicolon', ''], ['const int x=0,y=1;', 'ExpectedGlobalSemicolon', ','],
  ['static const int x=1;', 'ExpectedType', 'const'], ['const static int x=1;', 'ExpectedType', 'static'],
  ['extern static int x=1;', 'ExpectedType', 'static'], ['extern const int x=1;', 'ExpectedType', 'const'],
  ['const int x=@;', 'Expression', '@', { expressionError: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['static int a[@];', 'Expression', '@', { expressionError: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['int f(){return "old";}namespace n{static int a[2]=0;}', 'ArrayInitializer', '='],
  ['const int x=0;import p;', 'MisplacedHeader', 'import'], ['static int x=0;module other;', 'MisplacedHeader', 'module other'],
  ['int f(){static int x=1;}', 'Statement', 'static', { statementError: 'Expression', expressionError: 'ExpectedExpression' }],
]) {
  const input = 'module m; ' + text, start = marker ? input.indexOf(marker, 10) : input.length;
  const length = marker && /^[A-Za-z]/.test(marker) ? marker.split(' ')[0].length : undefined;
  bad(input, error, start, length, nested);
}
// Replay is covered by smaller fixtures; full-capacity globals need one parse
// per VM invocation to keep the unchanged 10-million-instruction budget.
rendered('full global arena without function count', { functions: Array.from({ length: 1023 }, () => storage('Constant', 'Int', { name: 'x', value: integer(0) })) }).passes = 1;
const globalArenaOverflow = rendered('overflow global arena', { functions: Array.from({ length: 1024 }, () => storage('Constant', 'Int', { name: 'x', value: integer(0) })) });
fixtures.pop(); let lastGlobal = globalArenaOverflow.tree.items; while (lastGlobal.next) lastGlobal = lastGlobal.next;
bad(globalArenaOverflow.input, 'TooManyNodes', lastGlobal.start, lastGlobal.length);
fixtures.at(-1).passes = 1;
rendered('full static array expression arena', { functions: [storage('Static', 'Int', { array: { kind: 'Chain', count: 2047 } })] });
const arrayArenaOverflow = rendered('overflow static array expression arena', { functions: [storage('Static', 'Int', { array: { kind: 'Chain', count: 2048 } })] });
fixtures.pop(); bad(arrayArenaOverflow.input, 'Expression', arrayArenaOverflow.tree.items.array.start, 2, { expressionError: 'TooManyNodes' });
rendered('global expression budget after body', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }),
  namespace('n', [storage('Constant', 'Int', { value: named('x') })])] });
const globalExpressionOverflow = rendered('overflow global expression budget after body', { functions: [fn({ body: block([{ kind: 'Return', value: { kind: 'Chain', count: 2046 } }]) }),
  namespace('n', [storage('Constant', 'Int', { value: named('ns::x') })])] });
fixtures.pop(); bad(globalExpressionOverflow.input, 'Expression', globalExpressionOverflow.tree.items.next.items.expression.right.start, 1, { expressionError: 'TooManyNodes' });
rendered('body types share global expression budget', { functions: [storage('Static', 'Int', { value: { kind: 'Chain', count: 2046 } }), fn({ type: 'Named', typeName: 'T' })] });
const afterGlobalOverflow = rendered('overflow body type after global', { functions: [storage('Static', 'Int', { value: { kind: 'Chain', count: 2046 } }), fn({ type: 'Named', typeName: 'ns::T' })] });
fixtures.pop(); bad(afterGlobalOverflow.input, 'Expression', afterGlobalOverflow.tree.items.next.typeName.right.start, 1, { expressionError: 'TooManyNodes' });
rendered('globals do not consume function budget', { functions: [storage('Constant', 'Int'), namespace('n', [storage('Static', 'Int', { array: integer(2) }),
  ...Array.from({ length: 256 }, (_, i) => fn({ name: `f${i}`, external: true }))])] });
for (const array of [false, true]) {
  let deepest = storage(array ? 'Static' : 'Constant', 'Int', array ? { array: integer(1) } : {});
  for (let index = 0; index < 47; index++) deepest = namespace('n', [deepest]);
  rendered(`global maximum syntax depth ${array}`, { functions: [deepest] });
  const overflow = rendered(`overflow global syntax depth ${array}`, { functions: [namespace('n', [deepest])] });
  fixtures.pop(); let global = overflow.tree.items; while (global.kind === 'Namespace') global = global.items;
  const missing = global.array ?? global.expression;
  bad(overflow.input, 'TooDeep', missing.start, missing.length, { expressionError: 'TooDeep' });
}

const generatedGlobalStart = fixtures.length;
for (let index = 0; index < 32; index++) {
  const globals = Array.from({ length: random(5) + 2 }, (_, i) => {
    const kind = random(2) ? 'Constant' : 'Static';
    const leaves = [integer(random(100)), { kind: 'Bool', value: !!random(2) }, named('ns::size'), { kind: 'Text', text: `g${String.fromCharCode(random(256))}` }];
    return storage(kind, types[random(7)], { name: `v${i}`, exported: !!random(2),
      array: kind === 'Static' && random(2) ? leaves[random(3)] : null, value: leaves[random(4)] });
  });
  rendered(`generated globals ${index}`, { functions: [globals[0], namespace('n', [
    ...globals.slice(1), alias('Int'), fn({ body: block([{ kind: 'Return', value: value() }]) }),
  ]), namespace('n', [storage('Static', 'String', { value: { kind: 'Text', text: 'retained' } })])] });
}
const generatedGlobalArenas = fixtures.slice(generatedGlobalStart).map(f => arenas(f.tree));
const generatedGlobalNodes = generatedGlobalArenas.flatMap(a => a.f.nodes);
for (const kind of ['Constant', 'Static']) for (const type of types) assert.ok(generatedGlobalNodes.some(n => n.kind === kind && n.declaredType === type), `missing generated ${kind} ${type}`);
for (const exported of [false, true]) assert.ok(generatedGlobalNodes.some(n => ['Constant', 'Static'].includes(n.kind) && n.exported === exported), `missing global visibility ${exported}`);
assert.ok(generatedGlobalNodes.some(n => n.kind === 'Static' && n.array), 'generated storage must cover static arrays');
for (const kind of ['Integer', 'Bool', 'Name', 'Text']) assert.ok(generatedGlobalArenas.some(a => a.e.nodes.some(n => n.kind === kind)), `missing generated global ${kind} leaf`);

function flatten(roots, links) {
  const nodes = [], ids = new Map(), pending = [...roots].reverse();
  while (pending.length) {
    const node = pending.pop();
    assert.ok(!ids.has(node), 'model must not alias nodes'); ids.set(node, nodes.length); nodes.push(node);
    for (const field of [...links].reverse()) if (node[field]) pending.push(node[field]);
  }
  return { nodes, ids };
}
function arenas(tree) {
  const f = flatten([tree], ['items', 'next']);
  const h = flatten(f.nodes.map(n => n.header).filter(Boolean), ['path', 'alias', 'items', 'next']);
  const s = flatten(f.nodes.map(n => n.body).filter(Boolean), ['declaration', 'body', 'other', 'next']);
  const e = flatten([...f.nodes.flatMap(n => [n.typeName, n.expression, n.array]), ...s.nodes.flatMap(n => [n.expression, n.init, n.condition, n.step, n.typeName, n.array])].filter(Boolean), ['left', 'right', 'next']);
  return { f, h, s, e };
}
const helpers = `
static int fids[functions::max_nodes]; static bool fseen[functions::max_nodes];
static int hids[headers::max_nodes]; static bool hseen[headers::max_nodes];
static int sids[statements::max_nodes]; static bool sseen[statements::max_nodes];
static int eids[expressions::max_nodes]; static bool eseen[expressions::max_nodes];
bool load(string input) { lexer::reset(); for(int at=0;at<input.length;at++)if(!lexer::append(input[at]))return false;return true; }
bool invalid(int id) {
    functions::Node n=functions::node(id);
    return n.kind==functions::kind::Invalid && n.start==0 && n.length==0 && n.line==0 && n.column==0 &&
        n.declared_type==statements::type_kind::Invalid && n.type_name==-1 && n.name_start==0 && n.name_length==0 &&
        !n.exported && !n.external && !n.immutable && n.header==-1 && n.items==-1 && n.body==-1 && n.next==-1 && n.expression==-1 && n.array==-1;
}
bool check_f(int index,int kind,int start,int length,int line,int column,int type,int type_name,int name_start,int name_length,
             bool exported,bool external,bool immutable,int header,int items,int body,int next,int expression,int array) {
    int id=fids[index];if(id<0||id>=functions::node_count()||fseen[id])return false;fseen[id]=true;
    functions::Node n=functions::node(id);
    if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.declared_type!=type||
       n.name_start!=name_start||n.name_length!=name_length||n.exported!=exported||n.external!=external||n.immutable!=immutable)return false;
    if(type_name==-1){if(n.type_name!=-1)return false;}else eids[type_name]=n.type_name;
    if(header==-1){if(n.header!=-1)return false;}else hids[header]=n.header;
    if(items==-1){if(n.items!=-1)return false;}else fids[items]=n.items;
    if(body==-1){if(n.body!=-1)return false;}else sids[body]=n.body;
    if(next==-1){if(n.next!=-1)return false;}else fids[next]=n.next;
    if(expression==-1){if(n.expression!=-1)return false;}else eids[expression]=n.expression;
    if(array==-1){if(n.array!=-1)return false;}else eids[array]=n.array;return true;
}
bool check_h(int index,int kind,int start,int length,int line,int column,int path,int alias,int items,int next) {
    int id=hids[index];if(id<0||id>=headers::node_count()||hseen[id])return false;hseen[id]=true;
    headers::Node n=headers::node(id);
    if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column)return false;
    if(path==-1){if(n.path!=-1)return false;}else hids[path]=n.path;
    if(alias==-1){if(n.alias!=-1)return false;}else hids[alias]=n.alias;
    if(items==-1){if(n.items!=-1)return false;}else hids[items]=n.items;
    if(next==-1){if(n.next!=-1)return false;}else hids[next]=n.next;return true;
}
bool check_s(int index,int kind,int start,int length,int line,int column,int expression,int init,int condition,int step,
             int body,int other,int next,int type,int type_name,int name_start,int name_length,bool immutable,int array,int declaration) {
    int id=sids[index];if(id<0||id>=statements::node_count()||sseen[id])return false;sseen[id]=true;
    statements::Node n=statements::node(id);
    if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.declared_type!=type||
       n.name_start!=name_start||n.name_length!=name_length||n.immutable!=immutable)return false;
    if(expression==-1){if(n.expression!=-1)return false;}else eids[expression]=n.expression;
    if(init==-1){if(n.init!=-1)return false;}else eids[init]=n.init;
    if(condition==-1){if(n.condition!=-1)return false;}else eids[condition]=n.condition;
    if(step==-1){if(n.step!=-1)return false;}else eids[step]=n.step;
    if(body==-1){if(n.body!=-1)return false;}else sids[body]=n.body;
    if(other==-1){if(n.other!=-1)return false;}else sids[other]=n.other;
    if(next==-1){if(n.next!=-1)return false;}else sids[next]=n.next;
    if(type_name==-1){if(n.type_name!=-1)return false;}else eids[type_name]=n.type_name;
    if(array==-1){if(n.array!=-1)return false;}else eids[array]=n.array;
    if(declaration==-1){if(n.declaration!=-1)return false;}else sids[declaration]=n.declaration;return true;
}
bool check_e(int index,int kind,int op,int start,int length,int line,int column,int value,string text,int left,int right,int next) {
    int id=eids[index];if(id<0||id>=expressions::node_count()||eseen[id])return false;eseen[id]=true;
    expressions::Node n=expressions::node(id);
    if(n.kind!=kind||n.op!=op||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.value!=value||n.text_length!=text.length)return false;
    if(left==-1){if(n.left!=-1)return false;}else eids[left]=n.left;
    if(right==-1){if(n.right!=-1)return false;}else eids[right]=n.right;
    if(next==-1){if(n.next!=-1)return false;}else eids[next]=n.next;
    for(int at=0;at<text.length;at++)if(expressions::text_byte(id,at)!=int(text[at]))return false;
    return expressions::text_byte(id,-1)==-1&&expressions::text_byte(id,text.length)==-1;
}
bool stream() {
    if(!load("{}{}"))return false;
    statements::begin();int first=statements::parse_next();int second=statements::parse_next();
    if(first==-1||second==-1||first==second||statements::node_count()!=2||expressions::current().kind!=lexer::Kind::End)return false;
    if(statements::parse()!=-1||statements::diagnostic().kind!=statements::Error::TrailingInput)return false;
    if(!load("module m; int f(){return 1;}"))return false;
    if(functions::parse()==-1)return false;
    headers::discard();statements::discard();
    return headers::node_count()==0&&statements::node_count()==0&&expressions::node_count()==0;
}
`;
let batches = 0;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    let checks;
    if (fixture.error) {
      const at = position(fixture.input, fixture.start);
      checks = `if(functions::parse()!=-1||functions::node_count()!=0||headers::node_count()!=0||statements::node_count()!=0||expressions::node_count()!=0||!invalid(0))return false;
        if(headers::node(0).kind!=headers::kind::Invalid||statements::node(0).kind!=statements::kind::Invalid||expressions::node(0).kind!=expressions::kind::Invalid)return false;
        functions::Diagnostic error=functions::diagnostic();
        if(error.kind!=functions::Error::${fixture.error}||error.header!=headers::Error::${fixture.headerError}||
           error.statement!=statements::Error::${fixture.statementError}||error.expression!=expressions::Error::${fixture.expressionError}||
           error.lexical!=lexer::Error::${fixture.lexical}||error.start!=${fixture.start}||error.length!=${fixture.length}||error.line!=${at.line}||error.column!=${at.column})return false;`;
    } else {
      const a = arenas(fixture.tree), assertions = [], chunks = [];
      const ref = (arena, node) => a[arena].ids.get(node) ?? -1;
      for (const [arena, { nodes }] of Object.entries(a)) {
        for (const [id, node] of nodes.entries()) {
          const at = position(fixture.input, node.start), base = `${id},${{ f: 'functions', h: 'headers', s: 'statements', e: 'expressions' }[arena]}::kind::${node.kind}`;
          const metadata = `${node.start},${node.length},${at.line},${at.column}`;
          let args;
          if (arena === 'f') args = `${base},${metadata},statements::type_kind::${node.declaredType},${ref('e', node.typeName)},${node.nameStart},${node.nameLength},${node.exported},${node.external},${node.immutable},${ref('h', node.header)},${ref('f', node.items)},${ref('s', node.body)},${ref('f', node.next)},${ref('e', node.expression)},${ref('e', node.array)}`;
          if (arena === 'h') args = `${base},${metadata},${[node.path, node.alias, node.items, node.next].map(n => ref('h', n)).join(',')}`;
          if (arena === 's') args = `${base},${metadata},${[node.expression, node.init, node.condition, node.step].map(n => ref('e', n)).join(',')},${[node.body, node.other, node.next].map(n => ref('s', n)).join(',')},statements::type_kind::${node.declaredType},${ref('e', node.typeName)},${node.nameStart},${node.nameLength},${node.immutable},${ref('e', node.array)},${ref('s', node.declaration)}`;
          if (arena === 'e') args = `${base},expressions::op::${node.op},${metadata},${node.value},${quote(node.text)},${[node.left, node.right, node.next].map(n => ref('e', n)).join(',')}`;
          assertions.push(`if(!check_${arena}(${args}))return false;`);
        }
        counts[arena] += nodes.length * 2 * (fixture.passes ?? 2);
      }
      for (let at = 0; at < assertions.length; at += 24) {
        const name = `check_${index}_${at}`; functions.push(`bool ${name}(){${assertions.slice(at, at + 24).join('\n')}return true;}`); chunks.push(`if(!${name}())return false;`);
      }
      checks = `fids[0]=functions::parse();if(fids[0]==-1||!invalid(-1)||!invalid(${a.f.nodes.length}))return false;
        ${Object.entries(a).map(([key, a]) => `if(${{ f: 'functions', h: 'headers', s: 'statements', e: 'expressions' }[key]}::node_count()!=${a.nodes.length})return false;for(int id=0;id<${a.nodes.length};id++)${key}seen[id]=false;`).join('\n')}
        lexer::rewind();lexer::next();${chunks.join('\n')}
        functions::Diagnostic error=functions::diagnostic();
        if(error.kind!=functions::Error::None||error.header!=headers::Error::None||error.statement!=statements::Error::None||
           error.expression!=expressions::Error::None||error.lexical!=lexer::Error::None||error.start!=0||error.length!=0||error.line!=1||error.column!=1)return false;`;
    }
    functions.push(`bool case_${index}(){if(!load(${quote(fixture.input)}))return false;for(int pass=0;pass<${fixture.passes ?? 2};pass++){${checks}}return !lexer::append(byte(32));}`);
    cases.push(`if(!case_${index}())return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main;\nimport l.compiler.lexer as lexer;\nimport l.compiler.expressions as expressions;\nimport l.compiler.statements as statements;\nimport l.compiler.headers as headers;\nimport l.compiler.functions as functions;\n${helpers}\n${functions.join('\n')}\nint main(){${cases.join('\n')}if(!stream())return 63;return 0;}`);
  try {
    assert.equal(command(0, ['run', source, '--manifest', manifest]).stderr, '');
    command(0, ['compile', source, '--manifest', manifest, '-o', output]); command(0, ['check', output]);
    assert.equal(command(0, ['run', output]).stderr, '');
  } catch (error) { throw new Error(`Fixtures: ${batch.map(f => f.name).join(', ')}\n${error.message}`, { cause: error }); }
  ++batches;
}
let batch = [];
for (const fixture of fixtures) {
  if (fixture.input.length > 1000 || (fixture.tree && Object.values(arenas(fixture.tree)).some(a => a.nodes.length > 100))) {
    if (batch.length) runBatch(batch); batch = []; runBatch([fixture]);
  } else { batch.push(fixture); if (batch.length === 3) { runBatch(batch); batch = []; } }
}
if (batch.length) runBatch(batch);
const driver = resolve(root, 'bootstrap/stage1/function_main.l'), driverManifest = resolve(root, 'bootstrap/stage1/package.json');
const output = resolve(work, 'functions.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['module app.main; import pkg.io::{print as p,}; pub int main(){int x=0;for(int i=0;i<3;i++)x=x+i;return x;} extern ns::T copy(const ns::T value);', 0, ''],
  ['module m;', 0, ''], ['module m; void f(void x){break;return unknown;} int f(){}', 0, ''],
  ['module m; namespace n{pub int f(){return 1;}namespace inner{extern ns::T copy(const ns::T p);}}namespace n{int g(){return missing;}}', 0, ''],
  ['module m; pub using Count=int; namespace n{using Item=pkg::Record; pub Item copy(const Item p){return p;}}', 0, ''],
  ['module m; using A=B; using B=A; using A=void;', 0, ''],
  ['module m; pub const int answer=unknown(42); namespace n{pub static byte bytes[size]; static string text="a\\0\\xff";} int main(){return answer;}', 0, ''],
  ['module m; const void value=1; static ns::T items[true]; static int huge[2147483648];', 0, ''],
  ['module m; int main(){for(;;);}', 0, ''],
  [readFileSync(resolve(root, 'examples/answer.l')), 0, ''],
  [readFileSync(resolve(root, 'examples/io_demo.l')), 0, ''],
  [readFileSync(driver), 0, ''],
  ['', 65, 'function:1:1: error: source must begin with a module declaration\n'],
  ['module m; int f();', 65, 'function:1:18: error: expected function body\n'],
  ['module m; int f(int p[3]){}', 65, 'function:1:22: error: arrays are not supported as parameters\n'],
  ['module m; int f(){return @;}', 65, 'function:1:26: error: unsupported character in Stage 0 source\n'],
  ['module m; @', 65, 'function:1:11: error: unsupported character in Stage 0 source\n'],
  ['module m; int @', 65, 'function:1:15: error: unsupported character in Stage 0 source\n'],
  ['module m; int f(){} import p;', 65, 'function:1:21: error: module and import declarations must precede other declarations\n'],
  ['module m; pub namespace n{}', 65, 'function:1:11: error: namespaces do not change declaration visibility\n'],
  ['module m; namespace n{', 65, "function:1:23: error: expected '}' after namespace\n"],
  ['module m; namespace n{import p;}', 65, 'function:1:23: error: module and import declarations must precede other declarations\n'],
  ['module m; using =int;', 65, 'function:1:17: error: expected type alias name\n'],
  ['module m; using T;', 65, "function:1:18: error: expected '=' after type alias name\n"],
  ['module m; using T=;', 65, 'function:1:19: error: expected primitive or qualified type\n'],
  ['module m; using T=int', 65, "function:1:22: error: expected ';' after type alias\n"],
  ['module m; const int =1;', 65, 'function:1:21: error: expected global declaration name\n'],
  ['module m; static int x;', 65, "function:1:23: error: expected '=' before global scalar initializer\n"],
  ['module m; static int a[2]=0;', 65, 'function:1:26: error: static arrays initialize to zero and cannot have an initializer\n'],
  [namespaceDepthOverflow.input, 65, `function:1:${deepestNamespace.start + 1}: error: syntax nesting exceeds 48\n`],
  [Buffer.concat([Buffer.from('module m;'), Buffer.alloc(65526, 32)]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'function: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) assert.equal(command(status, args, { input }).stderr, error);
console.log(`stage1 functions: ${fixtures.length} fixtures, ${JSON.stringify(counts)} modeled node checks, ${batches} batches, ${commands} commands passed`);
