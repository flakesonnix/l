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
const checks = { d: 0, h: 0, s: 0, e: 0 };
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error); assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, options.error ?? ''); commands++; return result;
}
const e = (kind, start, length, fields = {}) => ({ kind, start, length, op: 'None', value: 0, text: '', left: null, right: null, next: null, ...fields });
const d = (kind, start, length, fields = {}) => ({ kind, start, length, nameStart: 0, nameLength: 0, exported: false,
  header: null, type: null, items: null, body: null, next: null, immutable: false, ...fields });
const h = (kind, start, length, fields = {}) => ({ kind, start, length, path: null, alias: null, items: null, next: null, ...fields });
const s = (kind, start, length, fields = {}) => ({ kind, start, length, expression: null, init: null, condition: null,
  step: null, body: null, other: null, next: null, declaredType: 'Invalid', typeName: null, nameStart: 0,
  nameLength: 0, immutable: false, array: null, declaration: null, ...fields });
const integer = value => ({ kind: 'Integer', number: String(value) });
const named = name => ({ kind: 'Name', name });
const local = (name, value = integer(1), fields = {}) => ({ name, value, ...fields });
const letIn = (bindings, body, fields = {}) => ({ kind: 'Let', bindings, body, ...fields });
const conditional = (condition, positive, negative, fields = {}) => ({ kind: 'Conditional', condition, positive, negative, ...fields });
const block = (children = []) => ({ kind: 'Block', children });
const ret = value => ({ kind: 'Return', value });
const fn = (body = integer(42), fields = {}) => ({ kind: 'Function', name: 'main', type: 'Int', parameters: [],
  body: body.kind === 'Block' ? body : block([ret(body)]), ...fields });
const constant = (fields = {}) => ({ kind: 'Constant', name: 'answer', type: 'Int', body: integer(42), ...fields });
const record = (fields = [], options = {}) => ({ kind: 'Record', name: 'Pair', fields, ...options });
const alias = (type = 'Int', options = {}) => ({ kind: 'Alias', name: 'Count', type, ...options });
const namespace = (name, declarations = []) => ({ kind: 'Namespace', name, declarations });
const recordValue = (fields = [], options = {}) => ({ kind: 'Record', left: named('Pair'), fields, ...options });
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
    if (tree.kind === 'Record') {
      const left = expression(tree.left), result = e('Record', put('{'), 1, { left });
      let last = null;
      for (const field of tree.fields) {
        const item = e('FieldInit', put(field.name), field.name.length); put('=');
        item.left = expression(field.value); put(`;${gap}`);
        if (last) last.next = item; else result.right = item;
        last = item;
      }
      put('}'); return result;
    }
    if (tree.kind === 'Conditional') {
      if (!tree.bare) put('(');
      const result = e('Conditional', put('if'), 2); put(gap);
      result.left = expression(tree.condition); put(`${gap}then${gap}`);
      const positive = expression(tree.positive); put(gap);
      const branches = e('Branches', put('else'), 4, { left: positive }); put(gap);
      branches.right = expression(tree.negative); result.right = branches;
      if (!tree.bare) put(')');
      return result;
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
  function statementList(trees) {
    let first = null, last = null;
    for (const tree of trees) {
      const node = statement(tree); put(gap);
      if (last) last.next = node; else first = node;
      last = node;
    }
    return first;
  }
  function statement(tree) {
    if (tree.kind === 'Block') { const node = s('Block', put('{'), 1); node.body = statementList(tree.children); put('}'); return node; }
    if (tree.kind === 'Empty') return s('Empty', put(';'), 1);
    if (['Return', 'Break', 'Continue'].includes(tree.kind)) {
      const keyword = tree.kind.toLowerCase(), node = s(tree.kind, put(keyword), keyword.length); put(gap);
      if (tree.value) node.expression = expression(tree.value);
      put(';'); return node;
    }
    if (tree.kind === 'Expression') {
      if (tree.bare) {
        const start = input.length, value = expression(tree.value); put(';');
        return s('Expression', start, tree.headLength, { expression: value });
      }
      const node = s('Expression', put('('), 1); node.expression = expression(tree.value); put(');'); return node;
    }
    if (tree.kind === 'Declaration') {
      const start = input.length;
      if (tree.immutable) put(`const${gap}`);
      const typeName = tree.type === 'Named' ? chain(tree.typeName ?? 'pkg::T', '::', e) : null;
      const text = tree.type === 'Named' ? (tree.typeName ?? 'pkg::T').split('::')[0] : tree.type.toLowerCase();
      if (!typeName) put(text);
      const node = s('Declaration', start, tree.immutable ? 5 : text.length,
        { declaredType: tree.type, typeName, immutable: !!tree.immutable });
      put(gap); node.nameStart = put(tree.name); node.nameLength = tree.name.length;
      if (tree.array) { put('['); node.array = expression(tree.array); put(']'); }
      else { put('='); node.expression = expression(tree.value); }
      put(';'); return node;
    }
    const keyword = tree.kind.toLowerCase(), node = s(tree.kind, put(keyword), keyword.length); put('(');
    if (tree.kind === 'For') {
      if (tree.declaration) node.declaration = statement(tree.declaration);
      else { if (tree.init) node.init = expression(tree.init); put(';'); }
      if (tree.condition) node.condition = expression(tree.condition); put(';');
      if (tree.step) node.step = expression(tree.step);
    } else if (tree.kind === 'Switch') node.expression = expression(tree.selector);
    else node.condition = expression(tree.condition);
    put(')');
    if (tree.kind === 'Switch') {
      put('{'); let last = null;
      for (const label of tree.labels) {
        const word = label.kind.toLowerCase(), child = s(label.kind, put(word), word.length); put(gap);
        if (label.value) child.expression = expression(label.value);
        put(':'); child.body = statementList(label.children);
        if (last) last.next = child; else node.body = child;
        last = child;
      }
      put('}');
    } else {
      node.body = statement(tree.body);
      if (tree.other) { put(`${gap}else${gap}`); node.other = statement(tree.other); }
    }
    return node;
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
  const tree = d('Module', header.start, 6, { header });
  function declarationList(trees) {
    let first = null, last = null;
    for (const declaration of trees) {
      const start = input.length;
      if (declaration.exported) put(`pub${gap}`);
      if (declaration.kind === 'Function') {
        const declared = type(declaration.type, declaration.typeName); put(gap);
        const nameStart = put(declaration.name);
        const item = d('Function', start, declaration.exported ? 3 : declared.length,
          { type: declared, nameStart, nameLength: declaration.name.length, exported: !!declaration.exported });
        put('('); let lastParameter = null;
        for (const parameter of declaration.parameters) {
          if (lastParameter) put(',');
          const start = input.length;
          if (parameter.immutable) put(`const${gap}`);
          const declared = type(parameter.type, parameter.typeName); put(gap);
          const nameStart = put(parameter.name), current = d('Parameter', start, parameter.immutable ? 5 : declared.length,
            { type: declared, nameStart, nameLength: parameter.name.length, immutable: !!parameter.immutable });
          if (lastParameter) lastParameter.next = current; else item.items = current;
          lastParameter = current;
        }
        put(')'); item.body = statement(declaration.body); put(gap);
        if (last) last.next = item; else first = item; last = item;
        continue;
      }
      let nameStart, item;
      if (declaration.kind === 'Struct') {
        put(`struct${gap}`);
        nameStart = put(declaration.name);
        item = d('Struct', start, declaration.exported ? 3 : 6,
          { nameStart, nameLength: declaration.name.length, exported: !!declaration.exported });
        put(`${gap}{`); let lastField = null;
        for (const field of declaration.fields) {
          const fieldType = type(field.type, field.typeName); put(gap);
          const fieldName = put(field.name);
          const current = d('Field', fieldName, field.name.length, { nameStart: fieldName, nameLength: field.name.length, type: fieldType });
          put(`;${gap}`);
          if (lastField) lastField.next = current; else item.items = current;
          lastField = current;
        }
        put('}');
      } else {
        nameStart = put(declaration.name);
        item = d(declaration.kind, start, declaration.exported ? 3 : declaration.name.length,
          { nameStart, nameLength: declaration.name.length, exported: !!declaration.exported });
        if (declaration.kind === 'Constant') { put(':'); item.type = type(declaration.type, declaration.typeName); put('='); }
        else if (declaration.kind === 'Alias') { put(`=alias${gap}`); item.type = type(declaration.type, declaration.typeName); }
        else if (declaration.kind === 'Namespace') { put(`=namespace${gap}{`); item.items = declarationList(declaration.declarations); put('}'); }
        else if (declaration.kind === 'Record') {
          put(`=record${gap}{`); let lastField = null;
          for (const field of declaration.fields) {
            const start = put(field.name), current = d('Field', start, field.name.length, { nameStart: start, nameLength: field.name.length });
            put(':'); current.type = type(field.type, field.typeName); put(`;${gap}`);
            if (lastField) lastField.next = current; else item.items = current;
            lastField = current;
          }
          put('}');
        }
        else if (declaration.kind === 'Enum') {
          put(`=enum${gap}{`); let lastMember = null;
          for (const member of declaration.members) {
            const memberStart = put(member.name);
            const current = d('Member', memberStart, member.name.length, { nameStart: memberStart, nameLength: member.name.length });
            if (member.value) { put('='); current.body = expression(member.value); }
            put(`;${gap}`);
            if (lastMember) lastMember.next = current; else item.items = current;
            lastMember = current;
          }
          put('}');
        }
      }
      if (!['Record', 'Alias', 'Namespace', 'Enum', 'Struct'].includes(declaration.kind)) item.body = expression(declaration.body);
      put(`;${gap}`);
      if (last) last.next = item; else first = item; last = item;
    }
    return first;
  }
  tree.items = declarationList(declarations);
  input += options.trailing ?? '';
  const fixture = { name, input, tree, passes: options.passes ?? 2 }; fixtures.push(fixture); return fixture;
}
function bad(input, error, marker = '', nested = {}) {
  const start = typeof marker === 'number' ? marker : marker ? input.lastIndexOf(marker) : input.length;
  assert.ok(start >= 0, marker);
  const tail = input.slice(start), token = /^[A-Za-z_][A-Za-z_0-9]*|^[0-9]+|^(?:=>|::|\+\+|--)/.exec(tail);
  const length = start === input.length ? 0 : token?.[0].length ?? 1;
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 65))}`, input, error, start, length,
    header: 'None', statement: 'None', expression: 'None', lexical: 'None', ...nested });
}
rendered('header only', []);
rendered('approved spelling', [fn({ kind: 'Binary', operator: '+', left: named('a'), right: named('b') },
  { name: 'add', exported: true, parameters: [{ name: 'a', type: 'Int' }, { name: 'b', type: 'Int' }] }),
fn(letIn([local('value', { kind: 'Call', left: named('add'), arguments: [integer(20), integer(22)] }, { type: 'Int' })], named('value'), { bare: true }))]);
for (const tag of types) for (const exported of [false, true]) {
  for (const immutable of [false, true]) rendered(`function ${tag} ${exported} ${immutable}`, [fn(integer(0), { type: tag, exported, parameters: [{ name: 'p', type: tag, immutable }] })]);
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
  ['main=():int=>0;', 'ExpectedBinding', '('], ['const int x=1;', 'ExpectedName', 'const'],
  ['pub var x:int=1;', 'ExpectedName', 'var'], ['x:int=1; import p;', 'MisplacedHeader', 'import'],
  ['x:int=1; module other;', 'MisplacedHeader', 'module'], ['pub =1;', 'ExpectedName', '='],
  ['x:int 1;', 'ExpectedAssign', '1'], ['x:=1;', 'Expression', '=', { expression: 'ExpectedType' }],
  ['x=42;', 'ExpectedBinding', '42'], ['int', 'ExpectedName', ''], ['int f', 'ExpectedOpen', ''],
  ['int f()', 'ExpectedBody', ''], ['int f();', 'ExpectedBody', ';'], ['int f()=>1;', 'ExpectedBody', '=>'],
  ['int f(x:int){}', 'ExpectedName', ':'], ['int f(int){}', 'ExpectedName', ')'],
  ['int f(int x,){}', 'Expression', ')', { expression: 'ExpectedType' }],
  ['int f(int x int y){}', 'ExpectedClose', 'int y'], ['int f(int x[2]){}', 'ExpectedClose', '['],
  ['int f(const const int x){}', 'Expression', 'const int', { expression: 'ExpectedType' }],
  ['pkg:: f(){}', 'ExpectedName', '('], ['pkg.T f(){}', 'ExpectedName', '.'],
  ['int ns::f(){}', 'ExpectedOpen', '::'], ['int f(){};', 'ExpectedName', ';'],
]) bad(`module m; ${tail}`, error, marker, nested);
for (const [value, error, marker, lexical = 'None'] of [
  ['let x=1 in x', 'ExpectedSemicolon', 'in'], ['let var =1; in 0', 'ExpectedName', '=1'],
  ['let x 1; in x', 'ExpectedAssign', '1;'], ['let x: =1; in x', 'ExpectedType', '=1'],
  ['let const x=1; in x', 'ExpectedName', 'const'], ['let x=1;', 'ExpectedName', ';}'],
  ['let in ', 'ExpectedExpression', ';}'], ['f(1,)', 'ExpectedExpression', ');'],
  ['P{1}', 'ExpectedName', '1'], ['{return 0;}', 'ExpectedExpression', '{return'],
  ['let x=1; in @', 'Lexical', '@', 'UnsupportedCharacter'], ['let let=1; in 0', 'ExpectedName', 'let=1'],
]) bad(`module m; int f(){return ${value};}`, 'Statement', marker, { statement: 'Expression', expression: error, lexical });
bad('module m; x:string="old"; int f(){return let y="new"; in ;}', 'Statement', ';}', { statement: 'Expression', expression: 'ExpectedExpression' });
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
bad(pOverflow.input, 'TooManyNodes', 'int p'); fixtures.at(-1).passes = 1;
rendered('function limit and constants', [constant(), ...Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}` }))]);
const fOverflow = rendered('function overflow', Array.from({ length: 257 }, (_, i) => fn(integer(0), { name: `f${i}` }))); fixtures.pop();
bad(fOverflow.input, 'TooManyFunctions', 'int f256');
rendered('shared expression arena', [fn({ kind: 'Chain', count: 2046 })]);
const eOverflow = rendered('expression overflow', [fn({ kind: 'Chain', count: 2047 })]); fixtures.pop();
bad(eOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });
rendered('full let arena', [fn(letIn(Array.from({ length: 1022 }, () => local('x')), { kind: 'Unary', operator: '-', left: integer(0) }))], { passes: 1 });
const letOverflow = rendered('let arena overflow', [fn(letIn(Array.from({ length: 1023 }, () => local('x')), integer(0)))]); fixtures.pop();
bad(letOverflow.input, 'Statement', '0', { statement: 'Expression', expression: 'TooManyNodes' }); fixtures.at(-1).passes = 1;
let nested = integer(0);
for (let n = 0; n < 45; n++) nested = letIn([], nested, { bare: true });
rendered('shared syntax depth', [fn(nested)]);
const depthOverflow = rendered('depth overflow', [fn(letIn([], nested, { bare: true }))]); fixtures.pop();
bad(depthOverflow.input, 'Statement', '0', { statement: 'TooDeep', expression: 'TooDeep' });

const truth = { kind: 'Bool', bool: true }, lie = { kind: 'Bool', bool: false };
rendered('approved conditional', [fn(conditional(named('ready'), integer(42), integer(0), { bare: true }),
  { name: 'choose', parameters: [{ name: 'ready', type: 'Bool' }] })]);
for (const type of types) for (const exported of [false, true]) rendered(`conditional result ${type} ${exported}`, [
  constant({ type, exported, body: conditional(truth, named('first'), named('second')) }),
  fn(conditional(lie, named('first'), named('second')), { type, exported }),
]);
for (const branch of ['condition', 'positive', 'negative']) {
  const tree = conditional(named('outer'), named('yes'), named('no'), { bare: true });
  tree[branch] = conditional(named('inner'), integer(1), integer(2), { bare: true });
  rendered(`bare nested conditional ${branch}`, [fn(tree)]);
}
rendered('conditional condition can contain let', [fn(conditional(letIn([local('ready', truth)], named('ready'), { bare: true }),
  letIn([local('x', integer(1), { mutable: true })], named('x'), { bare: true }),
  letIn([local('x', integer(2))], named('x'), { bare: true }), { bare: true }))]);
rendered('conditional in let initializer and body', [fn(letIn([local('x', conditional(truth, integer(1), integer(2), { bare: true }), { type: 'Int' })],
  conditional(lie, named('x'), letIn([], integer(0), { bare: true }), { bare: true }), { bare: true }))]);
rendered('else body owns following binary operators', [fn(conditional(truth, integer(1), { kind: 'Binary', operator: '+', bare: true,
  left: integer(2), right: { kind: 'Binary', operator: '*', bare: true, left: integer(3), right: integer(4) } }, { bare: true }))]);
rendered('conditional on binary right owns its else body', [fn({ kind: 'Binary', operator: '+', bare: true, left: integer(1),
  right: conditional(truth, integer(2), { kind: 'Binary', operator: '+', bare: true, left: integer(3), right: integer(4) }, { bare: true }) })]);
rendered('bare conditionals stop at call commas', [fn({ kind: 'Call', left: named('f'), arguments: [
  conditional(truth, integer(1), integer(2), { bare: true }), conditional(lie, integer(3), integer(4), { bare: true }), integer(5),
] })]);
for (const operator of Object.keys(operators).filter(op => !['!', '++', '--', 'int', 'byte'].includes(op))) rendered(`conditional operand ${operator}`, [
  fn({ kind: operator === '=' ? 'Assign' : 'Binary', operator, left: conditional(truth, integer(1), integer(2)), right: conditional(lie, integer(3), integer(4)) }),
]);
for (const operator of ['+', '-', '!']) rendered(`conditional prefix ${operator}`, [fn({ kind: 'Unary', operator, left: conditional(truth, integer(1), integer(2)) })]);
for (const operator of ['++', '--']) rendered(`conditional postfix ${operator}`, [fn({ kind: 'Postfix', operator, left: conditional(truth, named('x'), named('y')) })]);
for (const operator of ['int', 'byte']) rendered(`conditional conversion ${operator}`, [fn({ kind: 'Convert', operator, left: conditional(truth, integer(1), integer(2)) })]);
rendered('conditional callee, field and index', [fn({ kind: 'Index', left: { kind: 'Field', name: 'items', left: { kind: 'Call',
  left: conditional(truth, named('f'), named('g')), arguments: [] } }, right: conditional(lie, integer(0), integer(1), { bare: true }) })]);
rendered('conditional syntax does not check types or lvalues', [fn(conditional(integer(1), { kind: 'Text', text: 'not an int' },
  { kind: 'Assign', operator: '=', left: integer(2), right: lie }))]);
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`conditional trivia ${JSON.stringify(gap)}`, [
  constant({ type: 'String', body: { kind: 'Text', text: 'earlier\0\xff' } }),
  fn(conditional(truth, { kind: 'Text', text: 'yes\0\xff' }, { kind: 'Text', text: 'no\x80' }, { bare: true }), { type: 'String', exported: true }),
], { gap, leading: '\n/*lead*/', trailing: '\n//end' });
for (const [tail, error, marker] of [
  ['if true 1 else 0', 'ExpectedThen', '1'], ['if true then 1', 'ExpectedElse', ';'],
  ['if then 1 else 0', 'ExpectedExpression', 'then'], ['if true then else 0', 'ExpectedExpression', 'else'],
  ['if true then 1 else', 'ExpectedExpression', ';'], ['if true then 1; else 0', 'ExpectedElse', '; else'],
  ['if true then if false then 1 else 2', 'ExpectedElse', ';'],
  ['if true then 1 else 0 else 2', null, 'else 2'], ['if true then 1 else @', 'Lexical', '@'],
  ['if true then @ else 0', 'Lexical', '@'], ['if false then unknown() else (1', 'ExpectedClose', ';'],
]) bad(`module m; int f(){return ${tail};}`, 'Statement', marker,
  error ? { statement: 'Expression', expression: error, lexical: error === 'Lexical' ? 'UnsupportedCharacter' : 'None' } : { statement: 'ExpectedSemicolon' });
bad('module m; x:string="old"; int f(){return if true then "new" else;}', 'Statement', ';}', { statement: 'Expression', expression: 'ExpectedExpression' });
bad('module then;', 'Header', 'then', { header: 'ExpectedName' });
bad('module m; import p as then;', 'Header', 'then', { header: 'ExpectedName' });
bad('module m; then:int=1;', 'ExpectedName', 'then');
bad('module m; int f(){return let then=1; in then;}', 'Statement', 'then=1', { statement: 'Expression', expression: 'ExpectedName' });
rendered('full conditional expression arena', [fn(conditional(truth, { kind: 'Chain', count: 2042 }, integer(0), { bare: true }))]);
const conditionalOverflow = rendered('conditional branch-pair overflow', [fn(conditional(truth, { kind: 'Chain', count: 2043 }, integer(0), { bare: true }))]); fixtures.pop();
bad(conditionalOverflow.input, 'Statement', 'else', { statement: 'Expression', expression: 'TooManyNodes' });
let deepConditional = integer(0);
for (let n = 0; n < 45; n++) deepConditional = conditional(truth, integer(1), deepConditional, { bare: true });
rendered('maximum conditional depth', [fn(deepConditional)]);
const conditionalDepthOverflow = rendered('conditional depth overflow', [fn(conditional(truth, integer(1), deepConditional, { bare: true }))]); fixtures.pop();
bad(conditionalDepthOverflow.input, 'Statement', 'true', { statement: 'TooDeep', expression: 'TooDeep' });
let mixedConditional = conditional(truth, integer(1), integer(0), { bare: true });
for (let n = 0; n < 44; n++) mixedConditional = letIn([], mixedConditional, { bare: true });
rendered('shared let/conditional depth', [fn(mixedConditional)]);
const mixedConditionalOverflow = rendered('shared let/conditional depth overflow', [fn(letIn([], mixedConditional, { bare: true }))]); fixtures.pop();
bad(mixedConditionalOverflow.input, 'Statement', 'true', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('conditional budget after earlier declarations', [constant(), fn(conditional(truth, { kind: 'Chain', count: 2040 }, integer(0), { bare: true }))]);
const sharedConditionalOverflow = rendered('conditional budget after earlier declarations overflow', [constant(), fn(conditional(truth, { kind: 'Chain', count: 2041 }, integer(0), { bare: true }))]); fixtures.pop();
bad(sharedConditionalOverflow.input, 'Statement', 'else', { statement: 'Expression', expression: 'TooManyNodes' });

rendered('approved record spelling', [record([{ name: 'x', type: 'Int' }, { name: 'ready', type: 'Bool' }], { exported: true }),
  fn(letIn([local('pair', recordValue([{ name: 'x', value: integer(42) }, { name: 'ready', value: truth }]), { type: 'Named', typeName: 'Pair' })],
    { kind: 'Field', left: named('pair'), name: 'x' }, { bare: true }))]);
for (const type of types) for (const exported of [false, true]) rendered(`record field ${type} ${exported}`, [record([{ name: 'value', type }], { exported }),
  fn(recordValue([{ name: 'value', value: named('unknown') }]), { type: 'Named', typeName: 'Pair' })]);
rendered('empty and duplicate record syntax is not semantic acceptance', [record(), record([{ name: 'x', type: 'Void' }, { name: 'x', type: 'Auto' }]),
  fn(recordValue([{ name: 'x', value: integer(1) }, { name: 'x', value: integer(2) }, { name: 'unknown', value: truth }]))]);
rendered('empty record literal', [fn(recordValue())]);
rendered('qualified record type and written field order', [fn(recordValue([{ name: 'second', value: { kind: 'Text', text: 'first\0\xff' } },
  { name: 'first', value: { kind: 'Text', text: 'second\x80' } }], { left: named('pkg::types::Pair') }))]);
for (const name of ['constructor', '__proto__', 'recordx']) rendered(`record identifier ${name}`, [record([{ name, type: 'Int' }], { name }),
  fn(recordValue([{ name, value: integer(1) }], { left: named(name) }))]);
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`record trivia ${JSON.stringify(gap)}`, [record([{ name: 'x', type: 'Named', typeName: 'pkg::T' }], { exported: true }),
  fn(recordValue([{ name: 'x', value: { kind: 'Text', text: 'text\0\xff' } }]))], { gap });
rendered('record literal in conditional and let positions', [fn(letIn([local('p', conditional(truth,
  recordValue([{ name: 'x', value: integer(1) }]), recordValue([{ name: 'x', value: integer(2) }]), { bare: true }))],
  recordValue([{ name: 'x', value: conditional(lie, integer(3), integer(4), { bare: true }) },
    { name: 'y', value: letIn([local('x', integer(5))], named('x'), { bare: true }) }]), { bare: true }))]);
rendered('nested record temporary field access', [fn(recordValue([{ name: 'x', value: { kind: 'Field', name: 'y', left: recordValue([{ name: 'y', value: integer(42) }]) } }]))]);
rendered('record call arguments and following field/index access', [fn({ kind: 'Index', left: { kind: 'Field', name: 'items', left: { kind: 'Call', left: named('f'),
  arguments: [recordValue([{ name: 'x', value: integer(1) }]), recordValue([{ name: 'x', value: integer(2) }])] } }, right: integer(0) })]);
rendered('record field assignment remains syntax-only', [fn({ kind: 'Assign', operator: '=', left: { kind: 'Field', name: 'x', left: recordValue([{ name: 'x', value: integer(1) }]) }, right: integer(2) })]);
for (const [tail, error, marker, nested] of [
  ['record Pair{x:int;};', 'ExpectedName', 'record'], ['Pair=record;', 'ExpectedRecordOpen', ';'],
  ['Pair=record{x:int;', 'ExpectedRecordClose', ''], ['Pair=record{x:int;}', 'ExpectedSemicolon', ''],
  ['Pair=record{pub x:int;};', 'ExpectedFieldName', 'pub'], ['Pair=record{x int;};', 'ExpectedColon', 'int'],
  ['Pair=record{x:;};', 'Expression', ';}', { expression: 'ExpectedType' }],
  ['Pair=record{x:int=0;};', 'ExpectedSemicolon', '=0'], ['Pair=record{x:int,};', 'ExpectedSemicolon', ','],
  ['Pair=record{x:int[2];};', 'ExpectedSemicolon', '['], ['Pair=record{record:int;};', 'ExpectedFieldName', 'record:int'],
  ['x:int=Pair{x=1};', 'Expression', '};', { expression: 'ExpectedFieldSemicolon' }],
  ['x:int=Pair{x=1,};', 'Expression', ',', { expression: 'ExpectedFieldSemicolon' }],
  ['x:int=Pair{x=1;,};', 'Expression', ',', { expression: 'ExpectedName' }],
  ['x:int=Pair{x;};', 'Expression', ';}', { expression: 'ExpectedFieldAssign' }],
  ['x:int=Pair{x:int;};', 'Expression', ':int', { expression: 'ExpectedFieldAssign' }],
  ['x:int=Pair{x=;};', 'Expression', ';}', { expression: 'ExpectedExpression' }],
  ['x:int=Pair{x=1;', 'Expression', '', { expression: 'ExpectedClose' }],
  ['x:int=1{x=1;};', 'Expression', '{', { expression: 'ExpectedRecordType' }],
  ['x:int=f(){x=1;};', 'Expression', '{', { expression: 'ExpectedRecordType' }],
  ['x:int=pkg.Pair{x=1;};', 'Expression', '{', { expression: 'ExpectedRecordType' }],
  ['x:int={x=1;};', 'Expression', '{', { expression: 'ExpectedExpression' }],
  ['x:int=record{x=1;};', 'Expression', 'record', { expression: 'ExpectedExpression' }],
  ['x:int=Pair{record=1;};', 'Expression', 'record', { expression: 'ExpectedName' }],
  ['x:string="old";Pair=record{x:@;};', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['x:int=Pair{x="old";y=@;};', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
]) bad(`module m; ${tail}`, error, marker, nested);
bad('module record;', 'Header', 'record', { header: 'ExpectedName' });
bad('module m; import p as record;', 'Header', 'record', { header: 'ExpectedName' });
const recordFields = n => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: 'Int' }));
rendered('record field limit', [record(recordFields(64))]);
const fieldOverflow = rendered('record field overflow', [record(recordFields(65))]); fixtures.pop();
bad(fieldOverflow.input, 'TooManyFields', 'f64');
rendered('record/function counts are independent', [...Array.from({ length: 256 }, (_, i) => record([{ name: 'x', type: 'Int' }], { name: `R${i}` })),
  ...Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}` }))], { passes: 1 });
const recordOverflow = rendered('record count overflow', Array.from({ length: 257 }, (_, i) => record([], { name: `R${i}` }))); fixtures.pop();
bad(recordOverflow.input, 'TooManyRecords', 'R256');
rendered('record full declaration arena', [...Array.from({ length: 15 }, () => record(recordFields(64))), record(recordFields(47))], { passes: 1 });
const recordDeclarationOverflow = rendered('record declaration arena overflow', [...Array.from({ length: 15 }, () => record(recordFields(64))), record(recordFields(48))]); fixtures.pop();
bad(recordDeclarationOverflow.input, 'TooManyNodes', 'f47'); fixtures.at(-1).passes = 1;
const literalFields = n => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, value: integer(0) }));
rendered('record full expression arena', [fn(recordValue(literalFields(1022), { left: named('ns::Pair') }))], { passes: 1 });
const recordExpressionOverflow = rendered('record expression arena overflow', [fn(recordValue(literalFields(1023)))]); fixtures.pop();
bad(recordExpressionOverflow.input, 'Statement', 'f1022', { statement: 'Expression', expression: 'TooManyNodes' }); fixtures.at(-1).passes = 1;
let deepRecord = integer(0);
for (let i = 0; i < 45; i++) deepRecord = recordValue([{ name: 'x', value: deepRecord }]);
rendered('record maximum expression depth', [fn(deepRecord)]);
const recordDepthOverflow = rendered('record expression depth overflow', [fn(recordValue([{ name: 'x', value: deepRecord }]))]); fixtures.pop();
bad(recordDepthOverflow.input, 'Statement', '0', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('record field type shares earlier body arena', [fn({ kind: 'Chain', count: 2044 }), record([{ name: 'x', type: 'Named', typeName: 'T' }])]);
const fieldTypeOverflow = rendered('record field type arena overflow', [fn({ kind: 'Chain', count: 2044 }), record([{ name: 'x', type: 'Named', typeName: 'ns::T' }])]); fixtures.pop();
bad(fieldTypeOverflow.input, 'Expression', 'ns::T', { expression: 'TooManyNodes' });
rendered('body shares earlier record field type arena', [record([{ name: 'x', type: 'Named', typeName: 'T' }]), fn({ kind: 'Chain', count: 2044 })]);
const afterFieldTypeOverflow = rendered('body after record field type arena overflow', [record([{ name: 'x', type: 'Named', typeName: 'ns::T' }]), fn({ kind: 'Chain', count: 2044 })]); fixtures.pop();
bad(afterFieldTypeOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });

const enumeration = (members = [], options = {}) => ({ kind: 'Enum', name: 'Color', members, ...options });
const structure = (fields = [], options = {}) => ({ kind: 'Struct', name: 'Point', fields, ...options });
const enumMembers = n => Array.from({ length: n }, (_, i) => ({ name: `m${i}` }));
for (const exported of [false, true]) {
  rendered(`empty enum ${exported}`, [enumeration([], { exported })]);
  rendered(`plain enum ${exported}`, [enumeration([{ name: 'Red' }, { name: 'Green' }, { name: 'Blue' }], { exported })]);
  rendered(`valued enum ${exported}`, [enumeration([
    { name: 'Zero' }, { name: 'One', value: integer(1) },
    { name: 'Two', value: { kind: 'Binary', operator: '+', left: named('One'), right: integer(1) } },
  ], { exported })]);
  rendered(`empty struct ${exported}`, [structure([], { exported })]);
  rendered(`scalar struct ${exported}`, [structure([
    { name: 'x', type: 'Int' }, { name: 'ready', type: 'Bool' }, { name: 'tag', type: 'Named', typeName: 'pkg::Tag' },
  ], { exported })]);
}
rendered('enum member values span the expression grammar', [enumeration([
  { name: 'A', value: named('pkg::types::Value') },
  { name: 'B', value: letIn([local('x', integer(1))], named('x'), { bare: true }) },
  { name: 'C', value: conditional(truth, integer(2), integer(3), { bare: true }) },
  { name: 'D', value: recordValue([{ name: 'x', value: integer(4) }], { left: named('ns::Pair') }) },
  { name: 'E', value: { kind: 'Text', text: 'text\0\xff' } },
  { name: 'constructor' }, { name: '__proto__' }, { name: 'enumx' }, { name: 'structx' },
])]);
rendered('struct fields accept named types', [structure([
  { name: 'y', type: 'Named', typeName: 'Pair' }, { name: 'q', type: 'Named', typeName: 'pkg::Q' },
]), enumeration([{ name: 'M', value: named('Value') }])]);
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`aggregate trivia ${JSON.stringify(gap)}`, [
  constant({ type: 'String', body: { kind: 'Text', text: 'before\0\xff' } }),
  enumeration([{ name: 'Red' }, { name: 'Blue', value: integer(7) }], { exported: true }),
  structure([{ name: 's', type: 'String' }]),
  fn({ kind: 'Text', text: 'after\x80' }),
], { gap, leading: '\n/*lead*/', trailing: '\n//end' });
rendered('enum and struct spellings inside retained strings', [
  constant({ type: 'String', body: { kind: 'Text', text: 'enum struct pub record' } }),
  enumeration([{ name: 'Red', value: { kind: 'Text', text: 'struct\x80' } }]),
  structure([{ name: 's', type: 'String' }]), fn({ kind: 'Text', text: 'enum\xff' }),
]);
rendered('aggregates and enums compose with namespaces', [namespace('types', [
  enumeration([{ name: 'Off' }, { name: 'On', value: integer(1) }], { exported: true }),
  structure([{ name: 'x', type: 'Int' }]),
  record([{ name: 'value', type: 'Named', typeName: 'types::Color' }]),
  alias('Named', { typeName: 'types::Point' }),
  constant({ type: 'Named', typeName: 'types::Color', body: named('types::Color::Off') }),
  fn(named('types::Color::On'), { type: 'Named', typeName: 'types::Point' }),
])]);
rendered('pub aggregates inside namespaces', [namespace('n', [
  enumeration([{ name: 'A' }], { exported: true }), structure([{ name: 'x', type: 'Int' }], { exported: true }),
]), namespace('m', [namespace('inner', [enumeration([])])])], { passes: 1 });
rendered('name-first enum tree', [enumeration([{ name: 'Off' }, { name: 'On', value: integer(1) }], { exported: true })]);
const structShape = rendered('C-style struct tree', [structure([{ name: 'x', type: 'Int' }, { name: 'ready', type: 'Bool' }], { name: 'Pair', exported: true })]);
const recordShape = rendered('name-first record tree', [record([{ name: 'x', type: 'Int' }, { name: 'ready', type: 'Bool' }], { name: 'Pair', exported: true })]);
const shape = node => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(shape);
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'length' || key === 'nameStart') continue;
    copy[key] = key === 'kind' && ['Record', 'Struct'].includes(value) ? 'Aggregate' : shape(value);
  }
  return copy;
};
assert.deepEqual(shape(structShape.tree), shape(recordShape.tree));
for (const [tail, error, marker, nested] of [
  ['Color=enum{Red;}', 'ExpectedSemicolon', ''], ['Color=enum{Red}', 'ExpectedSemicolon', '}'],
  ['Color=enum{Red=1}', 'ExpectedSemicolon', '}'], ['Color=enum{', 'ExpectedEnumClose', ''],
  ['Color=enum{Red;', 'ExpectedEnumClose', ''], ['Color=enum{1;}', 'ExpectedEnumName', '1'],
  ['Color=enum{Red,,On;};', 'ExpectedSemicolon', ',,'], ['Color=enum{Red=;};', 'Expression', ';}', { expression: 'ExpectedExpression' }],
  ['Color=enum{Red=1;;};', 'ExpectedEnumName', ';};'], ['Color=enum{Red=1,};', 'ExpectedSemicolon', ','],
  ['Color=enum{@;};', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['Color=enum;', 'ExpectedEnumOpen', ';'], ['Color=enum x{};', 'ExpectedEnumOpen', 'x'],
  ['enum Color{Red;};', 'ExpectedName', 'enum'], ['enum=1;', 'ExpectedName', 'enum'],
  ['struct=1;', 'ExpectedStructName', '='],
]) bad(`module m; ${tail}`, error, marker, nested);
for (const [tail, error, marker, nested] of [
  ['struct{int x;};', 'ExpectedStructName', '{'], ['struct 42{};', 'ExpectedStructName', '42'],
  ['struct Point;', 'ExpectedStructOpen', ';'], ['struct Point{', 'ExpectedStructClose', ''],
  ['struct Point{int x;', 'ExpectedStructClose', ''],
  ['struct Point{int x;}', 'ExpectedSemicolon', ''], ['struct Point{}', 'ExpectedSemicolon', ''],
  ['struct Point{;};', 'Expression', ';}', { expression: 'ExpectedType' }],
  ['struct Point{int;};', 'ExpectedStructFieldName', ';};'],
  ['struct Point{x;};', 'ExpectedStructFieldName', ';};'],
  ['struct Point{int x}', 'ExpectedStructFieldSemicolon', '}'],
  ['struct Point{int x=1;};', 'ExpectedStructFieldSemicolon', '=1'],
  ['struct Point{int x[2];};', 'ExpectedStructFieldSemicolon', '['],
  ['struct Point{const int x;};', 'Expression', 'const', { expression: 'ExpectedType' }],
  ['struct Point{pub int x;};', 'Expression', 'pub', { expression: 'ExpectedType' }],
  ['struct Point{int x;;};', 'Expression', ';};', { expression: 'ExpectedType' }],
  ['struct Point{int x; int y;}', 'ExpectedSemicolon', ''],
  ['Point=struct{};', 'ExpectedBinding', 'struct'],
  ['struct Point{int x;@};', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['Color=enum{Red="kept";Blue=@;};', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['text:string="kept";struct Point{int x;bool;};', 'ExpectedStructFieldName', ';};'],
]) bad(`module m; ${tail}`, error, marker, nested);
rendered('duplicate aggregate declarations and invalid types remain syntax only', [
  enumeration([{ name: 'A', value: named('later') }, { name: 'A', value: lie }]), enumeration(),
  structure([{ name: 'x', type: 'Void' }, { name: 'x', type: 'Auto' }]), structure(),
]);
rendered('struct field limit', [structure(recordFields(64))]);
const structFieldOverflow = rendered('struct field overflow', [structure(recordFields(65))]); fixtures.pop();
bad(structFieldOverflow.input, 'TooManyFields', 'int f64');
rendered('struct full declaration arena', [...Array.from({ length: 15 }, () => structure(recordFields(64))), structure(recordFields(47))], { passes: 1 });
const structArenaOverflow = rendered('struct declaration arena overflow', [...Array.from({ length: 15 }, () => structure(recordFields(64))),
  structure(recordFields(48))]); fixtures.pop();
bad(structArenaOverflow.input, 'TooManyNodes', 'f47'); fixtures.at(-1).passes = 1;
rendered('struct field type shares earlier body arena', [fn({ kind: 'Chain', count: 2044 }), structure([{ name: 'x', type: 'Named', typeName: 'T' }])]);
const structTypeOverflow = rendered('struct field type arena overflow', [fn({ kind: 'Chain', count: 2044 }), structure([{ name: 'x', type: 'Named', typeName: 'ns::T' }])]); fixtures.pop();
bad(structTypeOverflow.input, 'Expression', 'ns::T', { expression: 'TooManyNodes' });
rendered('enum count limit', Array.from({ length: 256 }, (_, i) => enumeration([], { name: `C${i}` })), { passes: 1 });
const enumOverflow = rendered('enum count overflow', Array.from({ length: 257 }, (_, i) => enumeration([], { name: `C${i}` }))); fixtures.pop();
bad(enumOverflow.input, 'TooManyEnums', 'C256');
rendered('records and structs share the aggregate cap', [...Array.from({ length: 128 }, (_, i) => record([], { name: `R${i}` })),
  ...Array.from({ length: 128 }, (_, i) => structure([], { name: `S${i}` }))], { passes: 1 });
const aggregateOverflow = rendered('aggregate count overflow', [...Array.from({ length: 256 }, (_, i) => record([], { name: `R${i}` })),
  structure([], { name: 'S256' })]); fixtures.pop();
bad(aggregateOverflow.input, 'TooManyRecords', 'struct S256');
const recordAfterStructOverflow = rendered('record after struct aggregate count overflow', [...Array.from({ length: 256 }, (_, i) => structure([], { name: `S${i}` })),
  record([], { name: 'R256' })]); fixtures.pop();
bad(recordAfterStructOverflow.input, 'TooManyRecords', 'R256');
rendered('enum count shared across namespaces', [namespace('n', Array.from({ length: 128 }, (_, i) => enumeration([], { name: `C${i}` }))),
  namespace('n', Array.from({ length: 128 }, (_, i) => enumeration([], { name: `C${i + 128}` })))], { passes: 1 });
const namespaceEnumOverflow = rendered('enum count across namespace overflow', [namespace('n', Array.from({ length: 256 }, (_, i) => enumeration([], { name: `C${i}` }))),
  namespace('n', [enumeration([], { name: 'C256' })])]); fixtures.pop();
bad(namespaceEnumOverflow.input, 'TooManyEnums', 'C256');
const namespaceAggregateOverflow = rendered('aggregate count across namespace overflow', [namespace('n', Array.from({ length: 256 }, (_, i) => record([], { name: `R${i}` }))),
  namespace('n', [structure([], { name: 'S256' })])]); fixtures.pop();
bad(namespaceAggregateOverflow.input, 'TooManyRecords', 'struct S256');
rendered('enum full declaration arena', [...Array.from({ length: 255 }, () => enumeration([])), enumeration(enumMembers(767))], { passes: 1 });
const enumArenaOverflow = rendered('enum declaration arena overflow', [...Array.from({ length: 255 }, () => enumeration([])),
  enumeration(enumMembers(768))], { passes: 1 }); fixtures.pop();
bad(enumArenaOverflow.input, 'TooManyNodes', 'm767'); fixtures.at(-1).passes = 1;
rendered('enum member full expression arena', [enumeration([{ name: 'Big', value: { kind: 'Chain', count: 2047 } }])], { passes: 1 });
const memberExpressionOverflow = rendered('enum member expression arena overflow', [enumeration([{ name: 'Big', value: { kind: 'Chain', count: 2048 } }])]); fixtures.pop();
bad(memberExpressionOverflow.input, 'Expression', '++', { expression: 'TooManyNodes' });
rendered('enum member value shares earlier body arena', [fn({ kind: 'Chain', count: 2043 }), enumeration([{ name: 'Big', value: named('a::b::c') }])]);
const memberSharedOverflow = rendered('enum member value arena overflow', [fn({ kind: 'Chain', count: 2043 }),
  enumeration([{ name: 'Big', value: named('a::b::c::d') }])]); fixtures.pop();
bad(memberSharedOverflow.input, 'Expression', memberSharedOverflow.tree.items.next.items.body.right.right.right.start, { expression: 'TooManyNodes' });
rendered('body shares earlier enum member arena', [enumeration([{ name: 'Big', value: named('a::b::c') }]), fn({ kind: 'Chain', count: 2043 })]);
const bodyAfterMemberOverflow = rendered('body after enum member arena overflow', [enumeration([{ name: 'Big', value: named('a::b::c') }]),
  fn({ kind: 'Chain', count: 2044 })]); fixtures.pop();
bad(bodyAfterMemberOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });
let deepAggregate = [enumeration([{ name: 'Off' }, { name: 'On' }]), structure([{ name: 'x', type: 'Int' }]),
  record([{ name: 'z', type: 'Int' }]), alias()];
for (let n = 0; n < 48; n++) deepAggregate = [namespace(`n${n}`, deepAggregate)];
rendered('enums and structs add no namespace or syntax depth', deepAggregate);
let aggregateValueDepth = [enumeration([{ name: 'On', value: integer(1) }])];
for (let n = 0; n < 48; n++) aggregateValueDepth = [namespace(`n${n}`, aggregateValueDepth)];
rendered('enum member value at maximum namespace expression depth', aggregateValueDepth[0].declarations);
const aggregateValueDepthOverflow = rendered('aggregate member value syntax depth overflow', aggregateValueDepth); fixtures.pop();
bad(aggregateValueDepthOverflow.input, 'Expression', '1', { expression: 'TooDeep' });

for (const type of types) for (const exported of [false, true]) rendered(`alias ${type} ${exported}`, [alias(type, { exported }),
  fn(named('value'), { type: 'Named', typeName: 'Count', parameters: [{ name: 'value', type: 'Named', typeName: 'Count' }] })]);
for (const name of ['constructor', '__proto__', 'aliasx']) rendered(`alias identifier ${name}`, [alias('Int', { name })]);
for (const gap of ['\n', '\t', '\r', '/*gap*/', '//gap\n']) rendered(`alias trivia ${JSON.stringify(gap)}`, [
  constant({ type: 'String', body: { kind: 'Text', text: 'before\0\xff' } }),
  alias('Named', { typeName: 'pkg::types::Value', exported: true }), fn({ kind: 'Text', text: 'after\x80' }, { type: 'String' }),
], { gap, leading: '\n/*lead*/', trailing: '\n//end' });
rendered('aliases are retained syntax, not recursively expanded', [alias('Named', { name: 'A', typeName: 'B' }),
  alias('Named', { name: 'B', typeName: 'A' }), alias('Named', { name: 'Self', typeName: 'Self' }),
  record([], { name: 'R' }), alias('Named', { name: 'NotScalar', typeName: 'R' }), alias('Void'), alias('Auto')]);
rendered('aliases in field/result/local types', [alias('Int'), record([{ name: 'value', type: 'Named', typeName: 'Count' }]),
  fn(letIn([local('p', recordValue([{ name: 'value', value: integer(42) }]), { type: 'Named', typeName: 'Pair' })],
    { kind: 'Field', name: 'value', left: named('p') }), { type: 'Named', typeName: 'Count' })]);
for (const [tail, error, marker, nested] of [
  ['alias Count=int;', 'ExpectedName', 'alias'], ['using Count=int;', 'ExpectedName', 'using'],
  ['Count=alias;', 'Expression', ';', { expression: 'ExpectedType' }], ['Count=alias', 'Expression', '', { expression: 'ExpectedType' }],
  ['Count=alias int', 'ExpectedSemicolon', ''], ['Count=alias int[2];', 'ExpectedSemicolon', '['],
  ['Count=alias T();', 'ExpectedSemicolon', '('], ['Count=alias const int;', 'Expression', 'const', { expression: 'ExpectedType' }],
  ['Count=alias ns::;', 'Expression', ';', { expression: 'ExpectedName' }],
  ['x:int=let T=alias int; in 0;', 'Expression', 'alias', { expression: 'ExpectedExpression' }],
  ['x:string="old";Count=alias @;', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
]) bad(`module m; ${tail}`, error, marker, nested);
bad('module alias;', 'Header', 'alias', { header: 'ExpectedName' });
bad('module m; import p as alias;', 'Header', 'alias', { header: 'ExpectedName' });
rendered('alias declaration arena', Array.from({ length: 1023 }, () => alias()), { passes: 1 });
const aliasOverflow = rendered('alias declaration overflow', Array.from({ length: 1024 }, () => alias())); fixtures.pop();
bad(aliasOverflow.input, 'TooManyNodes', 'Count'); fixtures.at(-1).passes = 1;
rendered('alias target expression arena', [alias('Named', { typeName: Array(2047).fill('T').join('::') })]);
const aliasTypeOverflow = rendered('alias target expression overflow', [alias('Named', { typeName: Array(2048).fill('T').join('::') })]); fixtures.pop();
bad(aliasTypeOverflow.input, 'Expression', aliasTypeOverflow.tree.items.type.start, { expression: 'TooManyNodes' });
rendered('alias target after body shares arena', [fn({ kind: 'Chain', count: 2044 }), alias('Named', { typeName: 'T' })]);
const aliasAfterBodyOverflow = rendered('alias target after body overflow', [fn({ kind: 'Chain', count: 2044 }), alias('Named', { typeName: 'ns::T' })]); fixtures.pop();
bad(aliasAfterBodyOverflow.input, 'Expression', 'ns::T', { expression: 'TooManyNodes' });
rendered('body after alias shares arena', [alias('Named', { typeName: 'T' }), fn({ kind: 'Chain', count: 2044 })]);
const bodyAfterAliasOverflow = rendered('body after alias overflow', [alias('Named', { typeName: 'ns::T' }), fn({ kind: 'Chain', count: 2044 })]); fixtures.pop();
bad(bodyAfterAliasOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });
rendered('aliases do not consume function/record counts', [alias(), ...Array.from({ length: 256 }, (_, i) => record([{ name: 'x', type: 'Int' }], { name: `R${i}` })),
  ...Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}` })), alias('Bool', { name: 'Flag' })], { passes: 1 });

rendered('approved namespace spelling', [namespace('math', [fn({ kind: 'Binary', operator: '+', left: named('a'), right: named('b') },
  { name: 'add', exported: true, parameters: [{ name: 'a', type: 'Int' }, { name: 'b', type: 'Int' }] })]),
  fn({ kind: 'Call', left: named('math::add'), arguments: [integer(20), integer(22)] })]);
rendered('empty namespace', [namespace('n')]);
rendered('nested and reopened namespaces retain separate syntax', [constant(), namespace('n', [alias('Int'),
  record([{ name: 'x', type: 'Named', typeName: 'Count' }], { exported: true }),
  namespace('inner', [constant({ name: 'x', exported: true }), fn(named('missing'), { name: 'private_value' })])]),
  namespace('n', [namespace('inner', [fn(named('unknown'), { name: 'private_value', exported: true })])]),
  alias('Named', { typeName: 'n::Count' }), fn(recordValue([{ name: 'x', value: named('n::inner::x') }], { left: named('n::Pair') }))]);
for (const type of types) for (const exported of [false, true]) rendered(`namespace member ${type} ${exported}`, [namespace('outer', [
  namespace('inner', [alias(type, { exported }), record([{ name: 'x', type }], { exported }),
    constant({ type, exported }), fn(named('p'), { type, exported, parameters: [{ name: 'p', type }] })]),
])]);
for (const name of ['constructor', '__proto__', 'Namespace', 'namespaceX']) rendered(`namespace identifier ${name}`, [namespace(name, [fn()])]);
for (const gap of ['\n', '\r', '\t', '/*gap*/', '//gap\n']) rendered(`namespace trivia ${JSON.stringify(gap)}`, [
  constant({ type: 'String', body: { kind: 'Text', text: 'before\0\xff' } }), namespace('outer', [
    namespace('inner', [fn({ kind: 'Text', text: 'inside\0\x80' }, { type: 'String', exported: true })]),
    namespace('inner', [constant({ type: 'String', body: { kind: 'Text', text: 'reopened\xff' } })]),
  ]), fn({ kind: 'Text', text: 'after\0\x80' }, { type: 'String' }),
], { gap, leading: '\n/*lead*/', trailing: '\n//end', imports: [{ path: 'pkg.types', alias: 'types' }] });
for (const [tail, error, marker, nested] of [
  ['namespace n{}', 'ExpectedName', 'namespace'], ['n::inner=namespace{};', 'ExpectedName', '='],
  ['n.inner=namespace{};', 'ExpectedName', '.'], ['=namespace{};', 'ExpectedName', '='],
  ['n=namespace;', 'ExpectedNamespaceOpen', ';'], ['n=namespace{', 'ExpectedNamespaceClose', ''],
  ['n=namespace{}', 'ExpectedSemicolon', ''], ['n=namespace{int f(){return 0;}}', 'ExpectedSemicolon', ''],
  ['n=namespace{inner=namespace{};int f(){return 0;}', 'ExpectedNamespaceClose', ''],
  ['n=namespace{};}', 'ExpectedName', '}'], ['n=namespace{;};', 'ExpectedName', ';};'],
  ['pub n=namespace{};', 'NamespaceVisibility', 'pub'], ['n=namespace{pub inner=namespace{};};', 'NamespaceVisibility', 'pub'],
  ['n=namespace{module other;};', 'MisplacedHeader', 'module other'], ['n=namespace{import p;};', 'MisplacedHeader', 'import'],
  ['n=namespace{pub import p;};', 'ExpectedName', 'import'], ['n=namespace{namespace old{}};', 'ExpectedName', 'namespace old'],
  ['n=namespace{inner=namespace{} int f(){return 0;}};', 'ExpectedSemicolon', 'int f'],
  ['n=namespace{f=():int=>0;};', 'ExpectedBinding', '('], ['x:int=namespace{};', 'Expression', 'namespace', { expression: 'ExpectedExpression' }],
  ['x:int=let n=namespace{};in 0;', 'Expression', 'namespace', { expression: 'ExpectedExpression' }],
  ['n=namespace{x:string="kept";inner=namespace{Count=alias;};};', 'Expression', ';};};', { expression: 'ExpectedType' }],
  ['n=namespace{x:string="kept";inner=namespace{int f(){return @;}};};', 'Statement', '@', { statement: 'Expression', expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['n=namespace{x:string="kept";};@', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
]) bad(`module m; ${tail}`, error, marker, nested);
const inNamespaces = (count, items = []) => {
  for (let n = 0; n < count; n++) items = [namespace(`n${n}`, items)];
  return items;
};
rendered('namespace declaration arena', Array.from({ length: 1023 }, (_, i) => namespace(`n${i}`)), { passes: 1 });
const namespaceArenaOverflow = rendered('namespace declaration arena overflow', Array.from({ length: 1024 }, (_, i) => namespace(`n${i}`))); fixtures.pop();
bad(namespaceArenaOverflow.input, 'TooManyNodes', 'n1023'); fixtures.at(-1).passes = 1;
rendered('maximum empty namespace depth', inNamespaces(48));
const namespaceDepthOverflow = rendered('namespace depth overflow', inNamespaces(49)); fixtures.pop();
bad(namespaceDepthOverflow.input, 'Expression', 'namespace', { expression: 'TooDeep' });
rendered('namespace depth with function body', inNamespaces(45, [fn(integer(0))]));
const namespaceBodyDepthOverflow = rendered('namespace/function depth overflow', inNamespaces(46, [fn(integer(0))])); fixtures.pop();
bad(namespaceBodyDepthOverflow.input, 'Statement', '0', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('deep namespace types add no expression depth', inNamespaces(48, [alias('Named', { typeName: 'pkg::T' }), record(recordFields(64))]));
rendered('namespace and let share depth', [namespace('n', [fn(nested.body)])]);
const namespaceLetOverflow = rendered('namespace/let depth overflow', [namespace('n', [fn(nested)])]); fixtures.pop();
bad(namespaceLetOverflow.input, 'Statement', '0', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('namespace and conditional share depth', [namespace('n', [fn(deepConditional.negative)])]);
const namespaceConditionalOverflow = rendered('namespace/conditional depth overflow', [namespace('n', [fn(deepConditional)])]); fixtures.pop();
bad(namespaceConditionalOverflow.input, 'Statement', 'true', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('namespace and record literal share depth', [namespace('n', [fn(deepRecord.fields[0].value)])]);
const namespaceLiteralOverflow = rendered('namespace/record depth overflow', [namespace('n', [fn(deepRecord)])]); fixtures.pop();
bad(namespaceLiteralOverflow.input, 'Statement', '0', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('namespace leaves depth before sibling expressions', [...inNamespaces(48), fn(deepConditional), ...inNamespaces(48)]);
rendered('reopened namespace types share earlier body arena', [namespace('n', [fn({ kind: 'Chain', count: 2044 })]), namespace('n', [alias('Named', { typeName: 'T' })])]);
const namespaceTypeOverflow = rendered('reopened namespace type arena overflow', [namespace('n', [fn({ kind: 'Chain', count: 2044 })]), namespace('n', [alias('Named', { typeName: 'pkg::T' })])]); fixtures.pop();
bad(namespaceTypeOverflow.input, 'Expression', 'pkg::T', { expression: 'TooManyNodes' });
rendered('reopened namespace bodies share earlier type arena', [namespace('n', [alias('Named', { typeName: 'T' })]), namespace('n', [fn({ kind: 'Chain', count: 2044 })])]);
const namespaceExpressionOverflow = rendered('reopened namespace body arena overflow', [namespace('n', [alias('Named', { typeName: 'pkg::T' })]), namespace('n', [fn({ kind: 'Chain', count: 2044 })])]); fixtures.pop();
bad(namespaceExpressionOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });
rendered('record/function counts shared across namespaces', [namespace('n', [alias(),
  ...Array.from({ length: 128 }, (_, i) => record(recordFields(1), { name: `R${i}` })),
  ...Array.from({ length: 128 }, (_, i) => fn(integer(0), { name: `f${i}` })),
]), namespace('n', [namespace('inner', [
  ...Array.from({ length: 128 }, (_, i) => record(recordFields(1), { name: `R${i + 128}` })),
  ...Array.from({ length: 128 }, (_, i) => fn(integer(0), { name: `f${i + 128}` })),
])])], { passes: 1 });
const namespaceFunctionOverflow = rendered('function count across namespace overflow', [namespace('n', Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}` }))),
  namespace('n', [fn(integer(0), { name: 'f256' })])]); fixtures.pop();
bad(namespaceFunctionOverflow.input, 'TooManyFunctions', 'int f256');
const namespaceRecordOverflow = rendered('record count across namespace overflow', [namespace('n', Array.from({ length: 256 }, (_, i) => record([], { name: `R${i}` }))),
  namespace('n', [record([], { name: 'R256' })])]); fixtures.pop();
bad(namespaceRecordOverflow.input, 'TooManyRecords', 'R256');
rendered('nested declaration arena shared with earlier siblings', [namespace('n', Array.from({ length: 510 }, () => alias())),
  namespace('n', [namespace('inner', Array.from({ length: 510 }, () => alias()))])], { passes: 1 });
const namespaceSharedDeclarationOverflow = rendered('namespace shared declaration arena overflow', [namespace('n', Array.from({ length: 510 }, () => alias())),
  namespace('n', [namespace('inner', Array.from({ length: 511 }, () => alias()))])]); fixtures.pop();
bad(namespaceSharedDeclarationOverflow.input, 'TooManyNodes', 'Count'); fixtures.at(-1).passes = 1;

const cLocal = (type, name, value = integer(0), fields = {}) => ({ kind: 'Declaration', type, name, value, ...fields });
const cExpression = value => ({ kind: 'Expression', value });
const empty = () => ({ kind: 'Empty' });
const increment = name => ({ kind: 'Postfix', operator: '++', left: named(name) });
rendered('C function bodies mix imperative flow and Nix expressions', [record([{ name: 'x', type: 'Int' }]), fn(block([
  cLocal('Int', 'sum', letIn([local('base', integer(1))], named('base'), { bare: true })),
  cLocal('Named', 'p', recordValue([{ name: 'x', value: integer(42) }]), { typeName: 'Pair', immutable: true }),
  { kind: 'For', declaration: cLocal('Int', 'i'), condition: { kind: 'Binary', operator: '<', left: named('i'), right: integer(3) },
    step: increment('i'), body: block([
      { kind: 'If', condition: conditional(truth, lie, truth), body: { kind: 'Continue' } },
      cExpression({ kind: 'Assign', operator: '=', left: named('sum'), right: letIn([local('x', named('i'))], named('x')) }),
    ]) },
  { kind: 'While', condition: truth, body: block([{ kind: 'Break' }]) },
  ret(conditional(truth, { kind: 'Field', name: 'x', left: named('p') }, named('sum'), { bare: true })),
]))]);
rendered('C dangling else stays with nearest statement if', [fn(block([
  { kind: 'If', condition: truth, body: { kind: 'If', condition: lie, body: ret(integer(1)), other: ret(integer(2)) } },
  { kind: 'If', condition: truth, body: block([{ kind: 'If', condition: lie, body: ret(integer(1)) }]), other: ret(integer(3)) },
]))]);
rendered('C switch retains fallthrough labels and Nix label syntax', [fn(block([
  { kind: 'Switch', selector: named('selector'), labels: [
    { kind: 'Case', value: conditional(truth, integer(1), integer(2)), children: [] },
    { kind: 'Case', value: integer(3), children: [cExpression(recordValue()), { kind: 'Break' }] },
    { kind: 'Default', children: [ret(letIn([], integer(42)))] },
  ] },
]))]);
for (let mask = 0; mask < 8; mask++) rendered(`C optional for header ${mask}`, [fn(block([{ kind: 'For',
  init: mask & 1 ? letIn([], integer(0)) : null, condition: mask & 2 ? conditional(truth, lie, truth) : null,
  step: mask & 4 ? increment('i') : null, body: empty(),
}]))]);
for (const type of types) for (const immutable of [false, true]) rendered(`C local ${type} ${immutable}`, [fn(block([
  cLocal(type, 'x', letIn([], named('unknown')), { typeName: 'pkg::T', immutable }),
  cLocal(type, 'buffer', null, { typeName: 'pkg::T', immutable, array: conditional(truth, integer(2), integer(3)) }),
]))]);
rendered('C statement name and conversion handoff keeps replacement literals', [fn(block([
  { kind: 'Expression', value: recordValue([{ name: 'x', value: letIn([], integer(42)) }]), bare: true, headLength: 4 },
  { kind: 'Expression', value: named('pkg::value'), bare: true, headLength: 3 },
  { kind: 'Expression', value: { kind: 'Convert', operator: 'int', left: conditional(truth, integer(1), integer(0)) }, bare: true, headLength: 3 },
  cExpression(conditional(truth, integer(1), integer(2))),
]))]);
rendered('C function syntax does not execute or check context', [fn(block([
  { kind: 'Break' }, { kind: 'Continue' }, ret(), { kind: 'While', condition: truth, body: empty() },
  { kind: 'Switch', selector: truth, labels: [{ kind: 'Default', children: [] }, { kind: 'Default', children: [] }] },
]), { type: 'Void' }), fn(block([]), { type: 'Int' })]);
rendered('named result disambiguation preserves binding storage', [alias('Int'), fn(block([]), { name: 'Count', type: 'Named', typeName: 'Count', parameters: [{ name: 'Count', type: 'Named', typeName: 'pkg::Count' }] }), constant()]);
rendered('full resumed named result arena', [fn(block([]), { type: 'Named', typeName: Array(2047).fill('T').join('::') })]);
const resumedTypeOverflow = rendered('resumed named result arena overflow', [fn(block([]), { type: 'Named', typeName: Array(2048).fill('T').join('::') })]); fixtures.pop();
bad(resumedTypeOverflow.input, 'Expression', resumedTypeOverflow.tree.items.type.start, { expression: 'TooManyNodes' });
for (const [tail, error, marker, nested] of [
  ['int f(){int x;}', 'Statement', ';}', { statement: 'ExpectedInitializer' }],
  ['int f(){int x[2]=0;}', 'Statement', '=0', { statement: 'ArrayInitializer' }],
  ['int f(){return 0}', 'Statement', '}', { statement: 'ExpectedSemicolon' }],
  ['int f(){', 'Statement', '', { statement: 'ExpectedClose' }],
  ['int f(){if true then 1 else 0;}', 'Statement', 'true', { statement: 'ExpectedOpen' }],
  ['int f(){switch(0){return 0;}}', 'Statement', 'return', { statement: 'ExpectedLabel' }],
  ['int f(){case 0:;}', 'Statement', 'case', { statement: 'UnexpectedLabel' }],
  ['int f(){module other;}', 'Statement', 'module other', { statement: 'Expression', expression: 'ExpectedExpression' }],
  ['int f(){let in @;}', 'Statement', '@', { statement: 'Expression', expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
  ['int f(){let in Pair{1};}', 'Statement', '1', { statement: 'Expression', expression: 'ExpectedName' }],
  ['int f(){return "kept";} int g(){const int x;}', 'Statement', ';}', { statement: 'ExpectedInitializer' }],
  ['int f(){return "kept";} pkg:: g(){}', 'ExpectedName', '(', {}],
  ['int f(){return 0;} n=namespace{int g(){if(true)return @;}};', 'Statement', '@', { statement: 'Expression', expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
]) bad(`module m; ${tail}`, error, marker, nested);
rendered('full function statement arena', [fn(block(Array.from({ length: 1023 }, empty)))], { passes: 1 });
const statementOverflow = rendered('function statement arena overflow', [fn(block(Array.from({ length: 1024 }, empty)))]); fixtures.pop();
bad(statementOverflow.input, 'Statement', ';', { statement: 'TooManyNodes' }); fixtures.at(-1).passes = 1;
rendered('statement arena shared across functions and namespaces', [fn(block(Array.from({ length: 510 }, empty))),
  namespace('n', [fn(block(Array.from({ length: 510 }, empty))), fn(block([empty()]))])], { passes: 1 });
const sharedStatementOverflow = rendered('shared statement arena overflow', [fn(block(Array.from({ length: 510 }, empty))),
  namespace('n', [fn(block(Array.from({ length: 510 }, empty))), fn(block([empty(), empty()]))])]); fixtures.pop();
bad(sharedStatementOverflow.input, 'Statement', '; } };', { statement: 'TooManyNodes' }); fixtures.at(-1).passes = 1;
let deepBlock = empty();
for (let n = 0; n < 47; n++) deepBlock = block([deepBlock]);
rendered('full C block statement depth', [fn(deepBlock)]);
const blockDepthOverflow = rendered('C block depth overflow', [fn(block([deepBlock]))]); fixtures.pop();
bad(blockDepthOverflow.input, 'Statement', ';', { statement: 'TooDeep', expression: 'TooDeep' });
rendered('deep namespace permits empty C function block', inNamespaces(47, [fn(block([]))]));
const namespaceBlockOverflow = rendered('namespace/C block depth overflow', inNamespaces(48, [fn(block([]))])); fixtures.pop();
bad(namespaceBlockOverflow.input, 'Statement', '{', { statement: 'TooDeep', expression: 'TooDeep' });

rendered('const parameters retain independent flags and C type spelling', [alias('Int'), namespace('n', [fn(block([
  cLocal('Int', 'copy', letIn([local('x', named('left'))], named('x'))),
  ret(conditional(truth, named('copy'), named('right'))),
]), { name: 'choose', type: 'Named', typeName: 'Count', exported: true, parameters: [
  { name: 'left', type: 'Named', typeName: 'Count', immutable: true },
  { name: 'right', type: 'Named', typeName: 'pkg::Count' },
  { name: 'ready', type: 'Bool', immutable: true },
] })])]);
rendered('parameter const is syntax, not checking or overload identity', [fn(block([
  cExpression({ kind: 'Assign', operator: '=', left: named('p'), right: integer(1) }),
  cExpression(increment('p')), ret(named('p')),
]), { parameters: [{ name: 'p', type: 'Int', immutable: true }] }),
fn(named('p'), { parameters: [{ name: 'p', type: 'Int' }] })]);
for (const name of ['constructor', '__proto__', 'constant', 'constx']) rendered(`const parameter identifier ${name}`, [fn(named(name), {
  parameters: [{ name, type: 'Int', immutable: true }],
})]);
for (const gap of ['\n', '\r', '\t', '/*gap*/', '//gap\n']) rendered(`const parameter trivia ${JSON.stringify(gap)}`, [
  constant({ type: 'String', body: { kind: 'Text', text: 'before\0\xff' } }), namespace('outer', [
    fn({ kind: 'Text', text: 'inside\0\x80' }, { type: 'String', exported: true, parameters: [
      { name: 'p', type: 'Named', typeName: 'pkg::T', immutable: true }, { name: 'q', type: 'Int' },
    ] }),
  ]), fn({ kind: 'Text', text: 'after\xff' }, { type: 'String', parameters: [{ name: 'p', type: 'Bool' }] }),
], { gap, leading: '\n/*lead*/', trailing: '\n//end' });
for (const [tail, error, marker, nested] of [
  ['int f(const){}', 'Expression', ')', { expression: 'ExpectedType' }],
  ['int f(const int){}', 'ExpectedName', ')', {}], ['int f(int const p){}', 'ExpectedName', 'const', {}],
  ['int f(const int const p){}', 'ExpectedName', 'const p', {}],
  ['int f(const p:int){}', 'ExpectedName', ':', {}],
  ['int f(const int p=1){}', 'ExpectedClose', '=', {}],
  ['int f(const int p[2]){}', 'ExpectedClose', '[', {}],
  ['int f(const int p,){}', 'Expression', ')', { expression: 'ExpectedType' }],
  ['int f(const const int p){}', 'Expression', 'const int', { expression: 'ExpectedType' }],
  ['int f(const ns::){}', 'Expression', ')', { expression: 'ExpectedName' }],
  ['int f(const int p,int){}', 'ExpectedName', ')', {}],
  ['int f(){return "kept";} int g(const @ p){}', 'Expression', '@', { expression: 'Lexical', lexical: 'UnsupportedCharacter' }],
]) bad(`module m; ${tail}`, error, marker, nested);
rendered('const parameter declaration arena', [fn(integer(0), { parameters: Array.from({ length: 1022 }, () => ({ name: 'p', type: 'Int', immutable: true })) })], { passes: 1 });
const constParameterOverflow = rendered('const parameter declaration overflow', [fn(integer(0), { parameters: Array.from({ length: 1023 }, () => ({ name: 'p', type: 'Int', immutable: true })) })]); fixtures.pop();
bad(constParameterOverflow.input, 'TooManyNodes', 'const int p'); fixtures.at(-1).passes = 1;
rendered('const qualified parameter expression arena', [fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: Array(2046).fill('T').join('::'), immutable: true }] })]);
const constTypeOverflow = rendered('const parameter type arena overflow', [fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: Array(2047).fill('T').join('::'), immutable: true }] })]); fixtures.pop();
bad(constTypeOverflow.input, 'Expression', constTypeOverflow.tree.items.items.type.start, { expression: 'TooManyNodes' });
rendered('const parameter type shares earlier body arena', [fn({ kind: 'Chain', count: 2043 }), fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: 'T', immutable: true }] })]);
const constAfterBodyOverflow = rendered('const parameter type after body overflow', [fn({ kind: 'Chain', count: 2043 }), fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: 'ns::T', immutable: true }] })]); fixtures.pop();
bad(constAfterBodyOverflow.input, 'Expression', 'ns::T', { expression: 'TooManyNodes' });
rendered('body shares earlier const parameter type arena', [fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: 'T', immutable: true }] }), fn({ kind: 'Chain', count: 2043 })]);
const bodyAfterConstOverflow = rendered('body after const parameter type overflow', [fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: 'ns::T', immutable: true }] }), fn({ kind: 'Chain', count: 2043 })]); fixtures.pop();
bad(bodyAfterConstOverflow.input, 'Statement', '++', { statement: 'Expression', expression: 'TooManyNodes' });
rendered('const parameters add no namespace or syntax depth', inNamespaces(47, [fn(block([]), { parameters: [{ name: 'p', type: 'Named', typeName: 'pkg::T', immutable: true }] })]));
rendered('const parameters preserve shared function and record limits', [namespace('n', [alias(),
  ...Array.from({ length: 256 }, (_, i) => record([], { name: `R${i}` })),
  ...Array.from({ length: 256 }, (_, i) => fn(integer(0), { name: `f${i}`, parameters: [{ name: 'p', type: 'Int', immutable: true }] })),
])], { passes: 1 });

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
function generatedConditional(depth) {
  if (!depth) return generated(0);
  const choice = random(4);
  if (choice < 2) return conditional(generatedConditional(depth - 1), generatedConditional(depth - 1), generatedConditional(depth - 1));
  if (choice === 2) return letIn([local('x', generatedConditional(depth - 1), { mutable: !!random(2) })], generatedConditional(depth - 1));
  return { kind: 'Call', left: named('f'), arguments: [generatedConditional(depth - 1), generatedConditional(depth - 1)] };
}
const conditionalGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated conditional ${n}`, [fn(conditional(generatedConditional(2), generatedConditional(2), generatedConditional(2)))]);
const recordGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated record ${n}`, [record(Array.from({ length: random(6) + 1 }, (_, i) => ({ name: `field${i}`, type: types[random(types.length)] })), { exported: !!random(2) }),
  fn(recordValue(Array.from({ length: random(5) + 1 }, (_, i) => ({ name: `value${i}`, value: generatedConditional(2) }))))]);
const aliasGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated alias ${n}`, [alias(types[random(types.length)], { exported: !!random(2) }),
  record([{ name: 'x', type: 'Named', typeName: 'Count' }]), fn(generatedConditional(2), { type: 'Named', typeName: 'Count' }),
  alias('Named', { name: 'Later', typeName: 'pkg::Count' })]);
const namespaceGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated namespace ${n}`, [namespace('outer', [
  alias(types[n % types.length], { exported: !!random(2) }), namespace('inner', [
    record([{ name: 'x', type: types[(n + 1) % types.length] }], { exported: !!random(2) }),
    constant({ type: types[(n + 2) % types.length], exported: !!random(2), body: generatedConditional(2) }),
    fn(generatedConditional(2), { type: types[(n + 3) % types.length], exported: !!random(2), parameters: [{ name: 'x', type: types[(n + 4) % types.length] }] }),
  ]),
]), namespace('outer', [namespace('inner', [fn(generatedConditional(2), { type: 'Named', typeName: 'outer::Count' })])])]);
const statementsGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated C body ${n}`, [namespace('n', [fn(block([
  cLocal(types[n % types.length], 'x', generatedConditional(2), { immutable: !!random(2), typeName: 'pkg::T' }),
  { kind: 'If', condition: generatedConditional(2), body: ret(generatedConditional(2)), other: block([empty()]) },
  { kind: 'While', condition: generatedConditional(2), body: block([{ kind: 'Break' }]) },
  { kind: 'For', declaration: cLocal('Int', 'i'), condition: generatedConditional(2), step: increment('i'), body: { kind: 'Continue' } },
  { kind: 'Switch', selector: generatedConditional(2), labels: [{ kind: 'Case', value: integer(n), children: [empty()] },
    { kind: 'Default', children: [cExpression(generatedConditional(2))] }] },
  ret(generatedConditional(2)),
]), { exported: !!random(2) })])]);
const constGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated const parameter ${n}`, [namespace('n', [fn(block([
  cLocal('Int', 'copy', generatedConditional(2), { immutable: !!random(2) }), ret(generatedConditional(2)),
]), { exported: !!random(2), parameters: [
  { name: 'a', type: types[n % types.length], immutable: true },
  { name: 'b', type: types[(n + 1) % types.length] },
  { name: 'c', type: 'Named', typeName: 'pkg::T', immutable: !!random(2) },
] })]), constant()]);
function flatten(roots, links) {
  const nodes = [], ids = new Map(), pending = [...roots].reverse();
  while (pending.length) { const node = pending.pop(); if (!node || ids.has(node)) continue;
    ids.set(node, nodes.length); nodes.push(node); for (const key of [...links].reverse()) if (node[key]) pending.push(node[key]); }
  return { nodes, ids };
}
function arenas(tree) {
  const d = flatten([tree], ['items', 'next']);
  const h = flatten(d.nodes.map(n => n.header).filter(Boolean), ['path', 'alias', 'items', 'next']);
  const s = flatten(d.nodes.filter(n => n.kind === 'Function').map(n => n.body), ['body', 'other', 'next', 'declaration']);
  const e = flatten([...d.nodes.flatMap(n => [n.type, n.kind === 'Function' ? null : n.body]),
    ...s.nodes.flatMap(n => [n.expression, n.init, n.condition, n.step, n.typeName, n.array])].filter(Boolean), ['left', 'right', 'next']);
  return { d, h, s, e };
}
const generatedNodes = fixtures.slice(generatedStart).flatMap(f => arenas(f.tree).e.nodes);
for (const kind of ['Let', 'Binding', 'Type', 'Integer', 'Bool', 'Text', 'Name', 'Call', 'Unary', 'Binary', 'Conditional', 'Branches', 'Record', 'FieldInit']) assert.ok(generatedNodes.some(n => n.kind === kind), kind);
for (const mutable of [0, 1]) assert.ok(generatedNodes.some(n => n.kind === 'Binding' && n.value === mutable), `generated mutability ${mutable}`);
for (let tag = 1; tag <= 7; tag++) assert.ok(generatedNodes.some(n => n.kind === 'Type' && n.value === tag), `generated type ${tag}`);
const conditionalGeneratedNodes = fixtures.slice(conditionalGeneratedStart).flatMap(f => arenas(f.tree).e.nodes);
for (const position of ['left', 'right']) assert.ok(conditionalGeneratedNodes.some(n => n.kind === 'Conditional' &&
  (position === 'left' ? n.left.kind === 'Conditional' : [n.right.left.kind, n.right.right.kind].includes('Conditional'))), `nested conditional ${position}`);
for (const node of conditionalGeneratedNodes.filter(n => n.kind === 'Branches')) assert.equal(node.next, null);
const generatedRecordArenas = fixtures.slice(recordGeneratedStart).map(f => arenas(f.tree));
for (const kind of ['Record', 'Field']) assert.ok(generatedRecordArenas.some(a => a.d.nodes.some(n => n.kind === kind)), kind);
for (let tag = 1; tag <= 7; tag++) assert.ok(generatedRecordArenas.some(a => a.d.nodes.some(n => n.kind === 'Field' && n.type.value === tag)), `record field type ${tag}`);
for (const exported of [false, true]) assert.ok(generatedRecordArenas.some(a => a.d.nodes.some(n => n.kind === 'Record' && n.exported === exported)), `record visibility ${exported}`);
const generatedAliasNodes = fixtures.slice(aliasGeneratedStart).flatMap(f => arenas(f.tree).d.nodes).filter(n => n.kind === 'Alias');
for (let tag = 1; tag <= 7; tag++) assert.ok(generatedAliasNodes.some(n => n.type.value === tag), `alias target type ${tag}`);
for (const exported of [false, true]) assert.ok(generatedAliasNodes.some(n => n.exported === exported), `alias visibility ${exported}`);
const generatedNamespaceNodes = fixtures.slice(namespaceGeneratedStart).flatMap(f => arenas(f.tree).d.nodes);
for (const kind of ['Namespace', 'Alias', 'Constant', 'Record', 'Field', 'Function', 'Parameter']) assert.ok(generatedNamespaceNodes.some(n => n.kind === kind), `namespace member ${kind}`);
assert.ok(generatedNamespaceNodes.some(n => n.kind === 'Namespace' && n.items?.kind === 'Namespace'), 'nested namespace');
for (const kind of ['Alias', 'Constant', 'Record', 'Function']) for (const exported of [false, true]) {
  assert.ok(generatedNamespaceNodes.some(n => n.kind === kind && n.exported === exported), `namespace ${kind} visibility ${exported}`);
}
for (const kind of ['Alias', 'Constant', 'Field', 'Function', 'Parameter']) for (let tag = 1; tag <= 7; tag++) {
  assert.ok(generatedNamespaceNodes.some(n => n.kind === kind && n.type.value === tag), `namespace ${kind} type ${tag}`);
}
const generatedStatements = fixtures.slice(statementsGeneratedStart).flatMap(f => arenas(f.tree).s.nodes);
for (const kind of ['Block', 'Return', 'Declaration', 'Expression', 'Empty', 'If', 'While', 'For', 'Continue', 'Break', 'Switch', 'Case', 'Default']) {
  assert.ok(generatedStatements.some(n => n.kind === kind), `generated C statement ${kind}`);
}
for (const type of types) assert.ok(generatedStatements.some(n => n.declaredType === type), `generated C local ${type}`);
for (const immutable of [false, true]) assert.ok(generatedStatements.some(n => n.kind === 'Declaration' && n.immutable === immutable), `generated C const ${immutable}`);
const generatedConstNodes = fixtures.slice(constGeneratedStart).flatMap(f => arenas(f.tree).d.nodes);
for (const type of types.keys()) for (const immutable of [false, true]) {
  assert.ok(generatedConstNodes.some(n => n.kind === 'Parameter' && n.type.value === type + 1 && n.immutable === immutable), `parameter type ${type + 1} const ${immutable}`);
}
assert.ok(generatedConstNodes.filter(n => n.kind !== 'Parameter').every(n => !n.immutable), 'only parameter nodes use declaration immutable flag');
const aggregateGeneratedStart = fixtures.length;
for (let n = 0; n < 32; n++) rendered(`generated aggregates ${n}`, [namespace('n', [
  enumeration([
    { name: 'a', value: integer(n) }, { name: 'b' },
    { name: 'c', value: conditional(truth, named('a'), named('b'), { bare: true }) },
    { name: 'd', value: letIn([local('x', integer(1))], named('x'), { bare: true }) },
    { name: 'e', value: { kind: 'Text', text: 'v\0\x80' } },
  ], { name: `C${n}`, exported: !!(n % 2) }),
  structure([
    { name: 'x', type: types[n % types.length] }, { name: 'y', type: 'Named', typeName: 'pkg::T' },
  ], { name: `S${n}`, exported: !(n % 2) }),
  record([{ name: 'z', type: 'Int' }], { name: `R${n}` }), alias(),
])]);
const generatedAggregateNodes = fixtures.slice(aggregateGeneratedStart).flatMap(f => arenas(f.tree).d.nodes);
for (const kind of ['Enum', 'Member', 'Struct', 'Field']) assert.ok(generatedAggregateNodes.some(n => n.kind === kind), `generated aggregate ${kind}`);
for (let index = 0; index < types.length; index++) {
  assert.ok(generatedAggregateNodes.some(n => n.kind === 'Field' && n.type?.value === index + 1), `generated struct field type ${index + 1}`);
}
for (const kind of ['Enum', 'Struct']) for (const exported of [false, true]) {
  assert.ok(generatedAggregateNodes.some(n => n.kind === kind && n.exported === exported), `generated ${kind} visibility ${exported}`);
}
assert.ok(generatedAggregateNodes.some(n => n.kind === 'Member' && n.body), 'generated member values');
assert.ok(generatedAggregateNodes.some(n => n.kind === 'Member' && !n.body), 'generated plain members');

const helpers = `
static int dids[parser::max_nodes]; static bool dseen[parser::max_nodes];
static int hids[headers::max_nodes]; static bool hseen[headers::max_nodes];
static int sids[statements::max_nodes]; static bool sseen[statements::max_nodes];
static int eids[expressions::max_nodes]; static bool eseen[expressions::max_nodes];
bool load(string input){lexer::reset();for(int i=0;i<input.length;i++)if(!lexer::append(input[i]))return false;return true;}
bool invalid(int id){parser::Node n=parser::node(id);return n.kind==parser::kind::Invalid&&n.start==0&&n.length==0&&n.line==0&&n.column==0&&n.name_start==0&&n.name_length==0&&!n.exported&&n.header==-1&&n.type==-1&&n.items==-1&&n.body==-1&&n.next==-1&&!n.immutable;}
bool check_d(int index,int kind,int start,int length,int line,int column,int ns,int nl,bool exported,int header,int type,int items,int body,int next,bool immutable){
 int id=dids[index];if(id<0||id>=parser::node_count()||dseen[id])return false;dseen[id]=true;parser::Node n=parser::node(id);
  if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.name_start!=ns||n.name_length!=nl||n.exported!=exported||n.immutable!=immutable)return false;
 if(header==-1){if(n.header!=-1)return false;}else hids[header]=n.header;
 if(type==-1){if(n.type!=-1)return false;}else eids[type]=n.type;
 if(items==-1){if(n.items!=-1)return false;}else dids[items]=n.items;
  if(body==-1){if(n.body!=-1)return false;}else if(n.kind==parser::kind::Function)sids[body]=n.body;else eids[body]=n.body;
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
 }
bool check_s(int index,int kind,int start,int length,int line,int column,int expression,int init,int condition,int step,int body,int other,int next,int type,int tn,int ns,int nl,bool immutable,int array,int declaration){
 int id=sids[index];if(id<0||id>=statements::node_count()||sseen[id])return false;sseen[id]=true;statements::Node n=statements::node(id);
 if(n.kind!=kind||n.start!=start||n.length!=length||n.line!=line||n.column!=column||n.declared_type!=type||n.name_start!=ns||n.name_length!=nl||n.immutable!=immutable)return false;
 if(expression==-1){if(n.expression!=-1)return false;}else eids[expression]=n.expression;
 if(init==-1){if(n.init!=-1)return false;}else eids[init]=n.init;
 if(condition==-1){if(n.condition!=-1)return false;}else eids[condition]=n.condition;
 if(step==-1){if(n.step!=-1)return false;}else eids[step]=n.step;
 if(body==-1){if(n.body!=-1)return false;}else sids[body]=n.body;
 if(other==-1){if(n.other!=-1)return false;}else sids[other]=n.other;
 if(next==-1){if(n.next!=-1)return false;}else sids[next]=n.next;
 if(tn==-1){if(n.type_name!=-1)return false;}else eids[tn]=n.type_name;
 if(array==-1){if(n.array!=-1)return false;}else eids[array]=n.array;
 if(declaration==-1){if(n.declaration!=-1)return false;}else sids[declaration]=n.declaration;return true;
 }`;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    let assertions = '';
    if (fixture.error) {
      const at = position(fixture.input, fixture.start);
      assertions = `if(parser::parse()!=-1||parser::node_count()!=0||headers::node_count()!=0||statements::node_count()!=0||expressions::node_count()!=0||!invalid(0))return false;
        parser::Diagnostic n=parser::diagnostic();if(n.kind!=parser::Error::${fixture.error}||n.header!=headers::Error::${fixture.header}||n.statement!=statements::Error::${fixture.statement}||n.expression!=expressions::Error::${fixture.expression}||n.lexical!=lexer::Error::${fixture.lexical}||n.start!=${fixture.start}||n.length!=${fixture.length}||n.line!=${at.line}||n.column!=${at.column})return false;`;
    } else {
      const all = arenas(fixture.tree), chunks = [], tests = [];
      const ref = (arena, node) => all[arena].ids.get(node) ?? -1;
      for (const arena of ['d', 'h', 's', 'e']) {
        const { nodes } = all[arena];
        assertions += `if(${{ d: 'parser', h: 'headers', s: 'statements', e: 'expressions' }[arena]}::node_count()!=${nodes.length})return false;for(int i=0;i<${nodes.length};i++){${arena}seen[i]=false;${arena}ids[i]=-1;}`;
        for (const [id, node] of nodes.entries()) {
          const at = position(fixture.input, node.start), prefix = `${id},${{ d: 'parser', h: 'headers', s: 'statements', e: 'expressions' }[arena]}::kind::${node.kind}`;
          const metadata = `${node.start},${node.length},${at.line},${at.column}`;
          let args;
          if (arena === 'd') args = `${prefix},${metadata},${node.nameStart},${node.nameLength},${node.exported},${ref('h', node.header)},${ref('e', node.type)},${ref('d', node.items)},${ref(node.kind === 'Function' ? 's' : 'e', node.body)},${ref('d', node.next)},${node.immutable}`;
          if (arena === 'h') args = `${prefix},${metadata},${[node.path, node.alias, node.items, node.next].map(n => ref('h', n)).join(',')}`;
          if (arena === 'e') args = `${prefix},expressions::op::${node.op},${metadata},${node.value},${quote(node.text)},${[node.left, node.right, node.next].map(n => ref('e', n)).join(',')}`;
          if (arena === 's') args = `${prefix},${metadata},${[node.expression, node.init, node.condition, node.step].map(n => ref('e', n)).join(',')},${[node.body, node.other, node.next].map(n => ref('s', n)).join(',')},statements::type_kind::${node.declaredType},${ref('e', node.typeName)},${node.nameStart},${node.nameLength},${node.immutable},${ref('e', node.array)},${ref('s', node.declaration)}`;
          tests.push(`if(!check_${arena}(${args}))return false;`);
        }
        checks[arena] += nodes.length * 2 * (fixture.passes ?? 2);
      }
      for (let at = 0; at < tests.length; at += 24) {
        const name = `check_${index}_${at}`; functions.push(`bool ${name}(){${tests.slice(at, at + 24).join('\n')}return true;}`); chunks.push(`if(!${name}())return false;`);
      }
      assertions = `int root=parser::parse();if(root==-1||!invalid(-1)||!invalid(parser::node_count()))return false;${assertions}dids[0]=root;lexer::rewind();lexer::next();${chunks.join('')}
        parser::Diagnostic n=parser::diagnostic();if(n.kind!=parser::Error::None||n.header!=headers::Error::None||n.statement!=statements::Error::None||n.expression!=expressions::Error::None||n.lexical!=lexer::Error::None||n.start!=0||n.length!=0||n.line!=1||n.column!=1)return false;`;
    }
    functions.push(`bool case_${index}(){if(!load(${quote(fixture.input)}))return false;for(int pass=0;pass<${fixture.passes ?? 2};pass++){${assertions}}return !lexer::append(byte(32));}`);
    cases.push(`if(!case_${index}())return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main; import l.compiler.lexer as lexer; import l.compiler.expressions as expressions; import l.compiler.headers as headers; import l.compiler.statements as statements; import l.compiler.bindings as parser;${helpers}\n${functions.join('\n')}\nint main(){${cases.join('')}return 0;}`);
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
writeFileSync(source, `module tests.main;import l.compiler.lexer as lexer;import l.compiler.expressions as expressions;import l.compiler.statements as statements;import l.compiler.bindings as parser;
bool load(string s){lexer::reset();for(int i=0;i<s.length;i++)if(!lexer::append(s[i]))return false;return true;}
int main(){for(int pass=0;pass<2;pass++){
 if(!load("module m; int f(){return let x=1; in x;}")||parser::parse()==-1)return 1;
 if(!load("let in 1")||expressions::parse()!=-1||expressions::diagnostic().kind!=expressions::Error::TrailingInput)return 2;
 if(!load("let+in+var+then+record+alias")||expressions::parse()==-1)return 6;
 if(!load("module m; int f(){return if true then 1 else 0;}")||parser::parse()==-1)return 7;
 if(!load("module m;n=namespace{int f(){return 0;}};")||parser::parse()==-1)return 9;
 if(!load("if true then 1 else 0")||expressions::parse()!=-1||expressions::diagnostic().kind!=expressions::Error::ExpectedExpression)return 8;
 if(!load("1+2")||expressions::parse()==-1)return 3;
 if(parser::parse()!=-1||parser::node_count()!=0||statements::node_count()!=0||expressions::node_count()!=0)return 4;
 if(!load("module m; int f(){return let in @;}")||parser::parse()!=-1)return 5;
 if(!load("{int alias=0;return alias;}")||statements::parse()==-1)return 10;
}return 0;}`);
const isolation = resolve(work, 'isolation.lbc');
command(0, ['run', source, '--manifest', manifest]); command(0, ['compile', source, '--manifest', manifest, '-o', isolation]);
command(0, ['check', isolation]); command(0, ['run', isolation]);
const driver = resolve(root, 'bootstrap/stage1/binding_main.l'), driverManifest = resolve(root, 'bootstrap/stage1/package.json'), output = resolve(work, 'binding.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
const driverBad = (input, marker, message) => [input, 65, `binding:1:${(marker ? input.indexOf(marker) : input.length) + 1}: error: ${message}\n`];
for (const [input, status, error] of [
  ['module m; pub int add(int a,int b){return a+b;} int main(){return let value:int=add(20,22); in value;}', 0, ''],
  ['module m; int main(){return let var x=0; in x=unknown();}', 0, ''],
  ['module m; void main(){unknown(2147483648);}', 0, ''],
  ['module m; int main(){return if true then 42 else unknown(1/0);}', 0, ''],
  ['module m; int main(){return if 1 then "wrong" else false;}', 0, ''],
  ['module m;pub Pair=record{x:int;ready:bool;};int main(){return let p:Pair=Pair{x=42;ready=true;};in p.x;}', 0, ''],
  ['module m;Pair=record{};void main(){Unknown{extra=missing();};}', 0, ''],
  ['module m;pub Count=alias int;Count increment(Count value){return value+1;}', 0, ''],
  ['module m;A=alias B;B=alias A;Self=alias Self;', 0, ''],
  ['module m;math=namespace{pub int add(int a,int b){return a+b;}};int main(){return math::add(20,22);}', 0, ''],
  ['module m;n=namespace{Count=alias int;};n=namespace{Count=alias n::Count;};', 0, ''],
  ['', 65, 'binding:1:1: error: source must begin with a module declaration\n'],
  ['module m; int main(){}', 0, ''],
  ['module m; pub int read(const int value){return let saved=value;in saved;}', 0, ''],
  ['module m; int f(const int p){p++;return p;}', 0, ''],
  ['module m;pub Color=enum{Red;Green=1;Blue;};int main(){return 0;}', 0, ''],
  ['module m;pub struct Point{int x;bool ready;};Point make(){return Point(1,true);}', 0, ''],
  ['module m;math=namespace{pub E=enum{A;B=2;};pub struct P{int v;};};int main(){return 0;}', 0, ''],
  driverBad('module m; struct Point{int x=1;};', '=1', "expected ';' after scalar struct field"),
  driverBad('module m; struct Point{int;};', ';}', 'expected struct field name'),
  driverBad('module m; struct {int x;};', '{', 'expected struct name'),
  ['module m; struct Point;', 65, "binding:1:23: error: expected '{' after struct name\n"],
  driverBad('module m; struct Point{int x;', '', "expected '}' after struct fields"),
  driverBad('module m; Color=enum{1;};', '1', 'expected enum member name'),
  ['module m; Color=enum;', 65, "binding:1:21: error: expected '{' after enum\n"],
  driverBad('module m; Point=struct{};', 'struct', "expected record, enum, alias or namespace after binding '='"),
  driverBad('module m; f=():int=>0;', '(', "expected record, enum, alias or namespace after binding '='"),
  driverBad('module m; int f(){return let x=1 in x;}', 'in x', "expected ';' after local binding"),
  driverBad('module m; int f(){return let in @;}', '@', 'unsupported character in Stage 0 source'),
  driverBad('module m; int f(){return if true 1 else 0;}', '1 else', "expected 'then' after condition"),
  driverBad('module m; int f(){return if true then 1;}', ';}', "expected 'else' after conditional branch"),
  driverBad('module m; int f(){int x;}', ';}', 'local scalar declarations require an initializer'),
  driverBad('module m; int f(const const int p){}', 'const int', 'expected primitive or qualified type'),
  driverBad('module m; int f(const int){}', ')', 'expected binding or parameter name'),
  ['module m; n=namespace{', 65, "binding:1:23: error: expected '}' after namespace declarations\n"],
  ['module m; pub n=namespace{};', 65, 'binding:1:11: error: namespace bindings cannot use pub; export their members individually\n'],
  [Buffer.concat([Buffer.from('module m;'), Buffer.alloc(65526, 32)]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'binding: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) command(status, args, { input, error });
console.log(`stage1 bindings: ${fixtures.length} fixtures, ${JSON.stringify(checks)} modeled node checks, ${batches} batches, ${commands} commands passed`);
