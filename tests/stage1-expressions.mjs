import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1-expressions.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
const quote = value => `"${[...Buffer.from(value, 'latin1')].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
let commands = 0, nodeChecks = 0;
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, '');
  ++commands;
  return result;
}
const operators = { '+': 'Plus', '-': 'Minus', '!': 'Bang', '*': 'Star', '/': 'Slash', '%': 'Percent',
  '<': 'Less', '>': 'Greater', '<=': 'LessEqual', '>=': 'GreaterEqual', '==': 'Equal', '!=': 'NotEqual',
  '&&': 'And', '||': 'Or', '=': 'Assign', '++': 'Increment', '--': 'Decrement', int: 'Int', byte: 'Byte' };
const levels = { '=': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5,
  '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };
const node = (kind, start, length, fields = {}) => ({ kind, op: 'None', start, length, value: 0,
  text: '', left: null, right: null, next: null, ...fields });
const fixtures = [];
function good(name, input, tree) { fixtures.push({ name, input, tree }); }
function bad(input, error, start = input.length, length = start === input.length ? 0 : 1, lexical = 'None') {
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 60))}`, input, error, start, length, lexical });
}

// Independent unparenthesized model: shunting-yard reduction, not Pratt parsing.
for (const first of Object.keys(levels)) for (const second of Object.keys(levels)) {
  const input = `a ${first} b ${second} c`, values = [], stack = [];
  const tokens = [{ name: 'a', start: 0 }, { op: first, start: 2 }, { name: 'b', start: first.length + 3 },
    { op: second, start: first.length + 5 }, { name: 'c', start: first.length + second.length + 6 }];
  function reduce() {
    const operator = stack.pop(), right = values.pop(), left = values.pop();
    values.push(node(operator.op === '=' ? 'Assign' : 'Binary', operator.start, operator.op.length,
      { op: operators[operator.op], left, right }));
  }
  for (const token of tokens) {
    if (token.name) values.push(node('Name', token.start, 1));
    else {
      while (stack.length && (levels[stack.at(-1).op] > levels[token.op] ||
        (levels[stack.at(-1).op] === levels[token.op] && token.op !== '='))) reduce();
      stack.push(token);
    }
  }
  while (stack.length) reduce();
  good(`precedence ${first} ${second}`, input, values[0]);
}

// Generate trees first, then emit fully parenthesized syntax with independently marked spans.
function rendered(name, tree) {
  let input = '';
  const put = text => { const start = input.length; input += text; return start; };
  const mark = (kind, text, fields = {}) => node(kind, put(text), text.length, fields);
  function render(tree) {
    if (tree.kind === 'Name') {
      let first = null, last = null;
      for (const part of tree.name.split('::')) {
        if (last) put(' /*path*/ :: ');
        const current = mark('Name', part);
        if (last) last.right = current; else first = current;
        last = current;
      }
      return first;
    }
    if (tree.kind === 'Integer') return mark('Integer', tree.number, { value: -Number(BigInt(tree.number)) });
    if (tree.kind === 'Bool') return mark('Bool', String(tree.bool), { value: Number(tree.bool) });
    if (tree.kind === 'Text') return mark('Text', quote(tree.text), { text: tree.text });
    if (tree.kind === 'Unary') {
      put('('); const result = mark('Unary', tree.operator, { op: operators[tree.operator] });
      put(' '); result.left = render(tree.left); put(')'); return result;
    }
    if (tree.kind === 'Binary' || tree.kind === 'Assign') {
      put('('); const left = render(tree.left); put(' ');
      const result = mark(tree.kind, tree.operator, { op: operators[tree.operator], left });
      put(' '); result.right = render(tree.right); put(')'); return result;
    }
    if (tree.kind === 'Convert') {
      const result = mark('Convert', tree.operator, { op: operators[tree.operator] });
      put('('); result.left = render(tree.left); put(')'); return result;
    }
    put('('); const left = render(tree.left); put(')');
    if (tree.kind === 'Field') { put('.'); return mark('Field', tree.field, { left }); }
    if (tree.kind === 'Postfix') return mark('Postfix', tree.operator, { op: operators[tree.operator], left });
    if (tree.kind === 'Index') {
      const result = mark('Index', '[', { left }); result.right = render(tree.right); put(']'); return result;
    }
    const result = mark(tree.kind, tree.kind === 'Call' ? '(' : '{', { left });
    let last = null;
    for (const argument of tree.arguments) {
      if (last) put(',\n');
      const current = render(argument);
      if (last) last.next = current; else result.right = current;
      last = current;
    }
    if (tree.trailing && last) put(',');
    put(tree.kind === 'Call' ? ')' : '}');
    return result;
  }
  const expected = render(tree);
  good(name, input, expected);
}
const integer = number => ({ kind: 'Integer', number: String(number) });
const named = name => ({ kind: 'Name', name });
for (const number of ['0', '0000', '42', '2147483647', '2147483648']) rendered(`integer ${number}`, integer(number));
for (const bool of [false, true]) rendered(`bool ${bool}`, { kind: 'Bool', bool });
rendered('qualified name', named('app::ns::item'));
rendered('empty call', { kind: 'Call', left: named('f'), arguments: [] });
rendered('empty struct', { kind: 'Struct', left: named('P'), arguments: [] });
rendered('trailing struct comma', { kind: 'Struct', left: named('P'), arguments: [integer(1), integer(2)], trailing: true });
rendered('all decoded bytes', { kind: 'Text', text: Buffer.from(Array.from({ length: 256 }, (_, value) => value)).toString('latin1') });
rendered('retained strings and argument links', { kind: 'Call', left: named('f'), arguments:
  ['', 'a\0b', '\xff\x80', 'last'].map(text => ({ kind: 'Text', text })) });
rendered('boundary unary minus', { kind: 'Unary', operator: '-', left: integer('2147483648') });
rendered('conversion', { kind: 'Convert', operator: 'int', left: { kind: 'Convert', operator: 'byte', left: integer(42) } });
const chain = 'f(1,g(2))[3].field++';
const call = node('Call', 1, 1, { left: node('Name', 0, 1), right: node('Integer', 2, 1, { value: -1 }) });
call.right.next = node('Call', 5, 1, { left: node('Name', 4, 1), right: node('Integer', 6, 1, { value: -2 }) });
good('unparenthesized postfix chain', chain, node('Postfix', 18, 2, { op: 'Increment', left:
  node('Field', 13, 5, { left: node('Index', 9, 1, { left: call, right: node('Integer', 10, 1, { value: -3 }) }) }) }));
good('unparenthesized unary/postfix binding', '-x++', node('Unary', 0, 1, { op: 'Minus', left:
  node('Postfix', 2, 2, { op: 'Increment', left: node('Name', 1, 1) }) }));
let state = 0xc172e49b;
function random(limit) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; }
function tree(depth) {
  if (depth === 0) return [integer(random(100000)), named('ns::value'), { kind: 'Bool', bool: !!random(2) },
    { kind: 'Text', text: `x${String.fromCharCode(random(256))}` }][random(4)];
  switch (random(9)) {
    case 0: return { kind: 'Unary', operator: ['+', '-', '!'][random(3)], left: tree(depth - 1) };
    case 1: case 2: {
      const operator = Object.keys(levels)[random(Object.keys(levels).length)];
      return { kind: operator === '=' ? 'Assign' : 'Binary', operator, left: tree(depth - 1), right: tree(depth - 1) };
    }
    case 3: return { kind: 'Call', left: tree(depth - 1), arguments: [tree(depth - 1), tree(depth - 1)] };
    case 4: return { kind: 'Struct', left: named('P'), arguments: [tree(depth - 1)], trailing: !!random(2) };
    case 5: return { kind: 'Index', left: tree(depth - 1), right: tree(depth - 1) };
    case 6: return { kind: 'Field', left: tree(depth - 1), field: 'member' };
    case 7: return { kind: 'Postfix', operator: random(2) ? '++' : '--', left: tree(depth - 1) };
    default: return { kind: 'Convert', operator: random(2) ? 'int' : 'byte', left: tree(depth - 1) };
  }
}
for (let index = 0; index < 96; ++index) rendered(`tree ${index}`, tree(3));
for (const [input, error, marker] of [
  ['', 'ExpectedExpression', ''], [')', 'ExpectedExpression', ')'], ['+', 'ExpectedExpression', ''],
  ['a b', 'TrailingInput', 'b'], ['a;', 'TrailingInput', ';'], ['a::', 'ExpectedName', ''],
  ['a::int', 'ExpectedName', 'int'], ['a.', 'ExpectedName', ''], ['a.42', 'ExpectedName', '42'],
  ['f(', 'ExpectedExpression', ''], ['f(1,)', 'ExpectedExpression', ')'], ['P{1,,2}', 'ExpectedExpression', ',2'],
  ['a[]', 'ExpectedExpression', ']'], ['a[1', 'ExpectedClose', ''], ['(1', 'ExpectedClose', ''],
  ['(1]', 'ExpectedClose', ']'], ['int 1', 'ExpectedOpen', '1'], ['int()', 'ExpectedExpression', ')'],
  ['int(1,2)', 'ExpectedClose', ',2'], ['bool(1)', 'ExpectedExpression', 'bool'],
  ['1+', 'ExpectedExpression', ''], ['a:::b', 'ExpectedName', ':b'], [' \n a + )', 'ExpectedExpression', ')'],
]) {
  const start = marker ? input.indexOf(marker) : input.length;
  const length = marker && /^[a-z0-9]/.test(marker) ? (/^[a-z0-9]+/.exec(marker)[0].length) : undefined;
  bad(input, error, start, length);
}
bad('@', 'Lexical', 0, 1, 'UnsupportedCharacter');
bad('\0', 'Lexical', 0, 1, 'Nul');
bad('2147483649', 'Lexical', 0, 10, 'IntegerRange');
bad('12x', 'Lexical', 0, 2, 'IntegerSuffix');
bad('f("ok","\\q")', 'Lexical', 7, 3, 'UnsupportedEscape');
good('maximum parenthesis depth', '('.repeat(47) + '1' + ')'.repeat(47), node('Integer', 47, 1, { value: -1 }));
bad('('.repeat(48) + '1' + ')'.repeat(48), 'TooDeep', 48);
let deep = node('Bool', 47, 4, { value: 1 });
for (let index = 46; index >= 0; --index) deep = node('Unary', index, 1, { op: 'Bang', left: deep });
good('maximum unary depth', '!'.repeat(47) + 'true', deep);
bad('!'.repeat(48) + 'true', 'TooDeep', 48, 4);
let nested = node('Integer', 94, 1, { value: -1 });
for (let index = 46; index >= 0; --index) nested = node('Call', index * 2 + 1, 1,
  { left: node('Name', index * 2, 1), right: nested });
good('maximum call depth', 'f('.repeat(47) + '1' + ')'.repeat(47), nested);
bad('f('.repeat(48) + '1' + ')'.repeat(48), 'TooDeep', 96);
let assignment = node('Name', 94, 1);
for (let index = 46; index >= 0; --index) assignment = node('Assign', index * 2 + 1, 1,
  { op: 'Assign', left: node('Name', index * 2, 1), right: assignment });
good('maximum assignment depth', 'a='.repeat(47) + 'z', assignment);
bad('a='.repeat(48) + 'z', 'TooDeep', 96);
let large = node('Name', 0, 1);
for (let index = 0; index < 2047; ++index) large = node('Postfix', 1 + index * 2, 2, { op: 'Increment', left: large });
good('maximum arena', 'x' + '++'.repeat(2047), large);
bad('x' + '++'.repeat(2048), 'TooManyNodes', 4095, 2);
bad(Array(1025).fill('a').join('+'), 'TooManyNodes', 2047);
bad('a::'.repeat(2048) + 'a', 'TooManyNodes', 6144);
const manyArguments = node('Call', 1, 1, { left: node('Name', 0, 1) });
let lastArgument = null;
for (let index = 0; index < 2046; ++index) {
  const argument = node('Integer', 2 + index * 2, 1);
  if (lastArgument) lastArgument.next = argument; else manyArguments.right = argument;
  lastArgument = argument;
}
good('maximum argument arena', `f(${Array(2046).fill('0').join(',')})`, manyArguments);
bad(`f(${Array(2047).fill('0').join(',')})`, 'TooManyNodes', 1);

function flatten(tree) {
  const nodes = [], pending = [tree], ids = new Map();
  while (pending.length) {
    const current = pending.pop();
    assert.ok(!ids.has(current), 'model must be a tree, not an aliased graph');
    ids.set(current, nodes.length); nodes.push(current);
    for (const child of [current.next, current.right, current.left]) if (child) pending.push(child);
  }
  return { nodes, ids };
}
const helpers = `
static int ids[parser::max_nodes];
static bool seen[parser::max_nodes];
bool load(string input) {
    lexer::reset();
    for (int index = 0; index < input.length; index++) if (!lexer::append(input[index])) return false;
    return true;
}
bool invalid_node(int id) {
    parser::Node value = parser::node(id);
    return value.kind == parser::kind::Invalid && value.op == parser::op::None &&
        value.start == 0 && value.length == 0 && value.line == 0 && value.column == 0 &&
        value.value == 0 && value.text_length == 0 && value.left == -1 && value.right == -1 && value.next == -1 &&
        parser::text_byte(id, 0) == -1;
}
bool check(int index, int kind, int op, int start, int length, int line, int column,
           int value, string text, int left, int right, int next) {
    int id = ids[index];
    if (id < 0 || id >= parser::node_count() || seen[id]) return false;
    seen[id] = true;
    parser::Node actual = parser::node(id);
    if (actual.kind != kind || actual.op != op || actual.start != start || actual.length != length ||
        actual.line != line || actual.column != column || actual.value != value || actual.text_length != text.length) return false;
    if (left == -1) { if (actual.left != -1) return false; } else ids[left] = actual.left;
    if (right == -1) { if (actual.right != -1) return false; } else ids[right] = actual.right;
    if (next == -1) { if (actual.next != -1) return false; } else ids[next] = actual.next;
    for (int at = 0; at < text.length; at++) if (parser::text_byte(id, at) != int(text[at])) return false;
    return parser::text_byte(id, -1) == -1 && parser::text_byte(id, text.length) == -1;
}
`;
let batches = 0;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    let assertions;
    if (fixture.error) {
      const prefix = fixture.input.slice(0, fixture.start);
      assertions = `if (parser::parse() != -1 || parser::node_count() != 0 || !invalid_node(0)) return false;
        parser::Diagnostic error = parser::diagnostic();
        if (error.kind != parser::Error::${fixture.error} || error.lexical != lexer::Error::${fixture.lexical} ||
            error.start != ${fixture.start} || error.length != ${fixture.length} ||
            error.line != ${prefix.split('\n').length} || error.column != ${fixture.start - prefix.lastIndexOf('\n')}) return false;`;
    } else {
      const { nodes, ids } = flatten(fixture.tree), chunks = [];
      for (let at = 0; at < nodes.length; at += 24) {
        const name = `check_${index}_${at}`;
        const assertions = nodes.slice(at, at + 24).map((node, offset) => {
          const prefix = fixture.input.slice(0, node.start);
          return `if (!check(${at + offset},parser::kind::${node.kind},parser::op::${node.op},${node.start},${node.length},
            ${prefix.split('\n').length},${node.start - prefix.lastIndexOf('\n')},${node.value},${quote(node.text)},
            ${ids.get(node.left) ?? -1},${ids.get(node.right) ?? -1},${ids.get(node.next) ?? -1})) return false;`;
        });
        functions.push(`bool ${name}(){${assertions.join('\n')}return true;}`); chunks.push(`if (!${name}()) return false;`);
      }
      assertions = `ids[0] = parser::parse();
        if (ids[0] == -1 || parser::node_count() != ${nodes.length}) return false;
        if (!invalid_node(-1) || !invalid_node(${nodes.length})) return false;
        for (int id = 0; id < ${nodes.length}; id++) seen[id] = false;
        lexer::rewind();
        lexer::next();
        ${chunks.join('\n')}
        parser::Diagnostic error = parser::diagnostic();
        if (error.kind != parser::Error::None || error.lexical != lexer::Error::None ||
            error.start != 0 || error.length != 0 || error.line != 1 || error.column != 1) return false;`;
      nodeChecks += nodes.length * 4;
    }
    functions.push(`bool case_${index}(){
      if (!load(${quote(fixture.input)})) return false;
      for (int pass = 0; pass < 2; pass++) { ${assertions} }
      return !lexer::append(byte(32));
    }`);
    cases.push(`if (!case_${index}()) return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main;\nimport l.compiler.lexer as lexer;\nimport l.compiler.expressions as parser;\n${helpers}\n${functions.join('\n')}\nint main(){${cases.join('\n')}return 0;}`);
  try {
    assert.equal(command(0, ['run', source, '--manifest', manifest]).stderr, '');
    command(0, ['compile', source, '--manifest', manifest, '-o', output]);
    command(0, ['check', output]);
    assert.equal(command(0, ['run', output]).stderr, '');
  } catch (error) { error.message += `\nFixtures: ${batch.map(f => f.name).join(', ')}`; throw error; }
  ++batches;
}
let batch = [];
for (const fixture of fixtures) {
  if (fixture.tree && flatten(fixture.tree).nodes.length > 100) {
    if (batch.length) runBatch(batch);
    batch = []; runBatch([fixture]);
  } else {
    batch.push(fixture);
    if (batch.length === 6) { runBatch(batch); batch = []; }
  }
}
if (batch.length) runBatch(batch);
const driver = resolve(root, 'bootstrap/stage1/expression_main.l');
const driverManifest = resolve(root, 'bootstrap/stage1/package.json');
const output = resolve(work, 'expressions.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['a = f(1, P{2,}).field[0] + -2147483648', 0, ''],
  ['1 + true', 0, ''], ['unknown(42)', 0, ''], ['2147483648', 0, ''],
  ['', 65, 'expression:1:1: error: expected expression\n'],
  ['a.', 65, 'expression:1:3: error: expected identifier\n'],
  ['int 1', 65, "expression:1:5: error: expected '(' after conversion type\n"],
  ['f(1,)', 65, 'expression:1:5: error: expected expression\n'],
  ['(1', 65, 'expression:1:3: error: expected closing delimiter\n'],
  ['1 2', 65, 'expression:1:3: error: unexpected token after expression\n'],
  ['\n @', 65, 'expression:2:2: error: unsupported character in Stage 0 source\n'],
  ['!'.repeat(48) + 'true', 65, 'expression:1:49: error: expression nesting exceeds 48\n'],
  ['x' + '++'.repeat(2048), 65, 'expression:1:4096: error: expression exceeds 2048 AST nodes\n'],
  [Buffer.concat([Buffer.alloc(65534, 32), Buffer.from('1')]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'expression: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) {
  assert.equal(command(status, args, { input }).stderr, error);
}
console.log(`stage1 expressions: ${fixtures.length} fixtures, ${nodeChecks} modeled AST node checks, ${batches} batches, ${commands} commands passed`);
