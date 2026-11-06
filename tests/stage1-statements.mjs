import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1-statements.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
const quote = value => `"${[...Buffer.from(value, 'latin1')].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
const position = (input, start) => ({ line: input.slice(0, start).split('\n').length,
  column: start - input.slice(0, start).lastIndexOf('\n') });
let commands = 0, statementChecks = 0, expressionChecks = 0;
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, ''); ++commands; return result;
}
const expression = (kind, start, length, fields = {}) => ({ kind, op: 'None', start, length,
  value: 0, text: '', left: null, right: null, next: null, ...fields });
const statement = (kind, start, length, fields = {}) => ({ kind, start, length,
  expression: null, init: null, condition: null, step: null, body: null, other: null, next: null, ...fields });
const fixtures = [];
function good(name, input, tree) { fixtures.push({ name, input, tree }); }
function bad(input, error, start = input.length, length = start === input.length ? 0 : 1,
  expressionError = 'None', lexical = 'None') {
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 50))}`, input, error, start, length, expressionError, lexical });
}

// Generate trees before syntax. Metadata is marked during emission, not reparsed.
function rendered(name, tree) {
  let input = '';
  const put = text => { const start = input.length; input += text; return start; };
  function expr(tree) {
    if (tree.kind === 'Integer') return expression('Integer', put(tree.number), tree.number.length,
      { value: -Number(BigInt(tree.number)) });
    if (tree.kind === 'Bool') return expression('Bool', put(String(tree.bool)), String(tree.bool).length, { value: Number(tree.bool) });
    if (tree.kind === 'Text') { const raw = quote(tree.text); return expression('Text', put(raw), raw.length, { text: tree.text }); }
    if (tree.kind === 'Name') {
      let first = null, last = null;
      for (const part of tree.name.split('::')) {
        if (last) put('::');
        const node = expression('Name', put(part), part.length);
        if (last) last.right = node; else first = node;
        last = node;
      }
      return first;
    }
    if (tree.kind === 'Convert') {
      const node = expression('Convert', put(tree.operator), tree.operator.length,
        { op: tree.operator === 'int' ? 'Int' : 'Byte' });
      put('('); node.left = expr(tree.left); put(')'); return node;
    }
    if (['Call', 'Struct', 'Index', 'Field', 'Postfix'].includes(tree.kind)) {
      put('('); const left = expr(tree.left); put(')');
      if (tree.kind === 'Field') { put('.'); return expression('Field', put(tree.field), tree.field.length, { left }); }
      if (tree.kind === 'Postfix') return expression('Postfix', put('++'), 2, { op: 'Increment', left });
      const node = expression(tree.kind, put(tree.kind === 'Call' ? '(' : tree.kind === 'Struct' ? '{' : '['), 1, { left });
      if (tree.kind === 'Index') node.right = expr(tree.right);
      else {
        let last = null;
        for (const argument of tree.arguments) {
          if (last) put(',');
          const current = expr(argument);
          if (last) last.next = current; else node.right = current;
          last = current;
        }
      }
      put(tree.kind === 'Call' ? ')' : tree.kind === 'Struct' ? '}' : ']'); return node;
    }
    put('(');
    const left = expr(tree.left);
    put(' ');
    const node = expression(tree.operator === '=' ? 'Assign' : 'Binary', put(tree.operator), tree.operator.length,
      { op: ({ '+': 'Plus', '*': 'Star', '=': 'Assign', '<': 'Less', '&&': 'And' })[tree.operator], left });
    put(' '); node.right = expr(tree.right); put(')'); return node;
  }
  function list(trees) {
    let first = null, last = null;
    for (const tree of trees) {
      put('\n'); const node = stmt(tree);
      if (last) last.next = node; else first = node;
      last = node;
    }
    return first;
  }
  function stmt(tree) {
    if (tree.kind === 'Block') {
      const node = statement('Block', put('{'), 1); node.body = list(tree.children); put('\n}'); return node;
    }
    if (tree.kind === 'Empty') return statement('Empty', put(';'), 1);
    if (tree.kind === 'Expression') {
      const start = input.length, value = expr(tree.value), tail = input.slice(start);
      const leading = /^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9]+|"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\(?:["\\nrt0]|x[0-9a-fA-F]{2}))*")/.exec(tail);
      const node = statement('Expression', start, leading ? leading[0].length : 1, { expression: value });
      put(';'); return node;
    }
    if (tree.kind === 'Return' || tree.kind === 'Break' || tree.kind === 'Continue') {
      const keyword = tree.kind.toLowerCase(), node = statement(tree.kind, put(keyword), keyword.length);
      if (tree.value) { put(' '); node.expression = expr(tree.value); }
      put(';'); return node;
    }
    const keyword = tree.kind.toLowerCase(), node = statement(tree.kind, put(keyword), keyword.length);
    put('(');
    if (tree.kind === 'For') {
      if (tree.init) node.init = expr(tree.init); put(';');
      if (tree.condition) node.condition = expr(tree.condition); put(';');
      if (tree.step) node.step = expr(tree.step);
    } else if (tree.kind === 'Switch') node.expression = expr(tree.selector);
    else node.condition = expr(tree.condition);
    put(')');
    if (tree.kind === 'Switch') {
      put('{'); let last = null;
      for (const label of tree.labels) {
        put('\n'); const keyword = label.kind.toLowerCase();
        const current = statement(label.kind, put(keyword), keyword.length);
        if (label.value) { put(' '); current.expression = expr(label.value); }
        put(':'); current.body = list(label.children);
        if (last) last.next = current; else node.body = current;
        last = current;
      }
      put('\n}');
    } else {
      node.body = stmt(tree.body);
      if (tree.other) { put(' else '); node.other = stmt(tree.other); }
    }
    return node;
  }
  const expected = stmt(tree);
  good(name, input, expected);
}
const integer = value => ({ kind: 'Integer', number: String(value) });
const named = name => ({ kind: 'Name', name });
const bool = value => ({ kind: 'Bool', bool: value });
const empty = () => ({ kind: 'Empty' });
const block = children => ({ kind: 'Block', children });
rendered('empty', empty());
rendered('empty block', block([]));
rendered('return', { kind: 'Return' });
rendered('syntax-only context', block([{ kind: 'Break' }, { kind: 'Continue' }, { kind: 'Return', value: integer('2147483648') }]));
rendered('strings survive multiple expressions', block(['first\0', '\xff\x80', 'last'].map(text =>
  ({ kind: 'Expression', value: { kind: 'Text', text } }))));
for (let mask = 0; mask < 8; ++mask) rendered(`for header ${mask}`, { kind: 'For',
  init: mask & 1 ? named('init') : null, condition: mask & 2 ? bool(true) : null,
  step: mask & 4 ? named('step') : null, body: empty() });
rendered('fallthrough and empty labels', { kind: 'Switch', selector: named('selector'), labels: [
  { kind: 'Case', value: integer(1), children: [] }, { kind: 'Case', value: integer(2), children: [{ kind: 'Break' }] },
  { kind: 'Default', children: [block([empty()]), { kind: 'Return', value: integer(3) }] },
] });
rendered('empty switch', { kind: 'Switch', selector: integer(0), labels: [] });
rendered('duplicate defaults are semantic', { kind: 'Switch', selector: bool(true), labels: [
  { kind: 'Default', children: [] }, { kind: 'Default', children: [empty()] },
] });
rendered('compound return and copied call arguments', { kind: 'Return', value: { kind: 'Index',
  left: { kind: 'Call', left: named('ns::f'), arguments: [
    { kind: 'Struct', left: named('P'), arguments: [integer(1)] }, { kind: 'Text', text: 'a\0\xff' },
    { kind: 'Convert', operator: 'int', left: { kind: 'Convert', operator: 'byte', left: integer(42) } },
  ] }, right: integer(0) } });
rendered('compound condition and step', { kind: 'For',
  init: { kind: 'Call', left: named('setup'), arguments: [] },
  condition: { kind: 'Field', left: named('record'), field: 'ready' },
  step: { kind: 'Postfix', left: named('index') }, body: empty() });
rendered('qualified case labels', { kind: 'Switch', selector: named('state'), labels: [
  { kind: 'Case', value: named('State::Ready'), children: [{ kind: 'Return', value: integer(1) }] },
] });
good('nearest dangling else', 'if(a)if(b);else;', statement('If', 0, 2, { condition: expression('Name', 3, 1),
  body: statement('If', 5, 2, { condition: expression('Name', 8, 1), body: statement('Empty', 10, 1), other: statement('Empty', 15, 1) }) }));
let state = 0x1b7c304f;
function random(limit) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor(state / 0x100000000 * limit);
}
function value() {
  const leaves = [integer(random(10000)), bool(!!random(2)), named('ns::value'), { kind: 'Text', text: `x${String.fromCharCode(random(256))}` }];
  if (random(2)) return leaves[random(leaves.length)];
  return { kind: 'Binary', operator: ['+', '*', '=', '<', '&&'][random(5)], left: leaves[random(4)], right: integer(random(10)) };
}
function tree(depth) {
  if (depth === 0) return [{ kind: 'Expression', value: value() }, { kind: 'Return', value: value() },
    { kind: 'Break' }, { kind: 'Continue' }, empty()][random(5)];
  switch (random(6)) {
    case 0: return block([tree(depth - 1), tree(depth - 1)]);
    case 1: return { kind: 'If', condition: value(), body: block([tree(depth - 1)]), other: block([tree(depth - 1)]) };
    case 2: return { kind: 'While', condition: value(), body: block([tree(depth - 1)]) };
    case 3: return { kind: 'For', init: value(), condition: value(), step: value(), body: block([tree(depth - 1)]) };
    case 4: return { kind: 'Switch', selector: value(), labels: [
      { kind: 'Case', value: value(), children: [tree(depth - 1)] }, { kind: 'Default', children: [tree(depth - 1)] },
    ] };
    default: return tree(0);
  }
}
const generatedStart = fixtures.length;
for (let index = 0; index < 96; ++index) rendered(`tree ${index}`, tree(3));
const generatedStatements = fixtures.slice(generatedStart).flatMap(fixture =>
  flatten([fixture.tree], ['body', 'other', 'next']).nodes);
const generatedExpressions = flatten(generatedStatements.flatMap(node =>
  [node.expression, node.init, node.condition, node.step].filter(Boolean)), ['left', 'right', 'next']).nodes;
const generatedKinds = new Set(generatedExpressions.map(node => node.kind));
for (const kind of ['Integer', 'Bool', 'Text', 'Name']) {
  assert.ok(generatedKinds.has(kind), `generated statement corpus must cover ${kind} leaves`);
}
for (const [input, error, marker] of [
  ['{', 'ExpectedClose', ''], ['if true;', 'ExpectedOpen', 'true'], ['if(true];', 'ExpectedClose', ']'],
  ['while(true)', 'Expression', ''], ['for(a b;;);', 'ExpectedSemicolon', 'b'],
  ['for(;;a];', 'ExpectedClose', ']'], ['return 1', 'ExpectedSemicolon', ''],
  ['break', 'ExpectedSemicolon', ''], ['continue x;', 'ExpectedSemicolon', 'x'],
  ['switch(1);', 'ExpectedOpen', ';'], ['switch(1){;}', 'ExpectedLabel', ';'],
  ['switch(1){case 1;}', 'ExpectedColon', ';'], ['switch(1){default}', 'ExpectedColon', '}'],
  ['switch(1){case 1:', 'ExpectedClose', ''], ['case 1:;', 'UnexpectedLabel', 'case'],
  ['default:;', 'UnexpectedLabel', 'default'], [';;', 'TrailingInput', ';'],
]) {
  const start = marker ? (input === ';;' ? 1 : input.indexOf(marker)) : input.length;
  const length = marker && /^[a-z]/.test(marker) ? marker.length : undefined;
  bad(input, error, start, length, error === 'Expression' ? 'ExpectedExpression' : 'None');
}
bad('', 'Expression', 0, 0, 'ExpectedExpression');
bad('int x=1;', 'Expression', 4, 1, 'ExpectedOpen');
bad('T x=1;', 'ExpectedSemicolon', 2);
bad('for(int i=0;;);', 'Expression', 8, 1, 'ExpectedOpen');
bad('return @;', 'Expression', 7, 1, 'Lexical', 'UnsupportedCharacter');
bad('{"old";"\\q";}', 'Expression', 7, 3, 'Lexical', 'UnsupportedEscape');
let deep = statement('Empty', 47, 1);
for (let index = 46; index >= 0; --index) deep = statement('Block', index, 1, { body: deep });
good('maximum statement depth', '{'.repeat(47) + ';' + '}'.repeat(47), deep);
bad('{'.repeat(48) + ';' + '}'.repeat(48), 'TooDeep', 48, 1, 'TooDeep');
let mixed = statement('Expression', 46, 1, { expression: expression('Integer', 46, 1, { value: -1 }) });
for (let index = 45; index >= 0; --index) mixed = statement('Block', index, 1, { body: mixed });
good('maximum mixed depth', '{'.repeat(46) + '1;' + '}'.repeat(46), mixed);
bad('{'.repeat(47) + '1;' + '}'.repeat(47), 'TooDeep', 47, 1, 'TooDeep');
let whiles = statement('Empty', 517, 1);
for (let index = 46; index >= 0; --index) whiles = statement('While', index * 11, 5,
  { condition: expression('Bool', index * 11 + 6, 4, { value: 1 }), body: whiles });
good('maximum while depth', 'while(true)'.repeat(47) + ';', whiles);
bad('while(true)'.repeat(48) + ';', 'TooDeep', 523, 4, 'TooDeep');
const full = statement('Block', 0, 1);
let last = null;
for (let index = 0; index < 1023; ++index) {
  const current = statement('Empty', index + 1, 1);
  if (last) last.next = current; else full.body = current;
  last = current;
}
good('full statement arena', '{' + ';'.repeat(1023) + '}', full);
bad('{' + ';'.repeat(1024) + '}', 'TooManyNodes', 1024);
bad('if(true){' + ';'.repeat(1023) + '}', 'TooManyNodes', 0, 2);
let large = expression('Name', 0, 1);
for (let index = 0; index < 2047; ++index) large = expression('Postfix', index * 2 + 1, 2, { op: 'Increment', left: large });
good('full shared expression arena', 'x' + '++'.repeat(2047) + ';', statement('Expression', 0, 1, { expression: large }));
bad('x' + '++'.repeat(2048) + ';', 'Expression', 4095, 2, 'TooManyNodes');

function flatten(roots, links) {
  const nodes = [], ids = new Map(), pending = [...roots].reverse();
  while (pending.length) {
    const node = pending.pop();
    assert.ok(!ids.has(node), 'model must not alias nodes'); ids.set(node, nodes.length); nodes.push(node);
    for (const field of [...links].reverse()) if (node[field]) pending.push(node[field]);
  }
  return { nodes, ids };
}
const helpers = `
static int sids[statements::max_nodes];
static bool sseen[statements::max_nodes];
static int eids[expressions::max_nodes];
static bool eseen[expressions::max_nodes];
bool load(string input) {
    lexer::reset();
    for (int at = 0; at < input.length; at++) if (!lexer::append(input[at])) return false;
    return true;
}
bool invalid(int id) {
    statements::Node node = statements::node(id);
    return node.kind == statements::kind::Invalid && node.start == 0 && node.length == 0 &&
        node.line == 0 && node.column == 0 && node.expression == -1 && node.init == -1 && node.condition == -1 &&
        node.step == -1 && node.body == -1 && node.other == -1 && node.next == -1;
}
bool check_s(int index, int kind, int start, int length, int line, int column,
             int expression, int init, int condition, int step, int body, int other, int next) {
    int id = sids[index];
    if (id < 0 || id >= statements::node_count() || sseen[id]) return false;
    sseen[id] = true;
    statements::Node node = statements::node(id);
    if (node.kind != kind || node.start != start || node.length != length || node.line != line || node.column != column) return false;
    if (expression == -1) { if (node.expression != -1) return false; } else eids[expression] = node.expression;
    if (init == -1) { if (node.init != -1) return false; } else eids[init] = node.init;
    if (condition == -1) { if (node.condition != -1) return false; } else eids[condition] = node.condition;
    if (step == -1) { if (node.step != -1) return false; } else eids[step] = node.step;
    if (body == -1) { if (node.body != -1) return false; } else sids[body] = node.body;
    if (other == -1) { if (node.other != -1) return false; } else sids[other] = node.other;
    if (next == -1) { if (node.next != -1) return false; } else sids[next] = node.next;
    return true;
}
bool check_e(int index, int kind, int op, int start, int length, int line, int column,
             int value, string text, int left, int right, int next) {
    int id = eids[index];
    if (id < 0 || id >= expressions::node_count() || eseen[id]) return false;
    eseen[id] = true;
    expressions::Node node = expressions::node(id);
    if (node.kind != kind || node.op != op || node.start != start || node.length != length || node.line != line ||
        node.column != column || node.value != value || node.text_length != text.length) return false;
    if (left == -1) { if (node.left != -1) return false; } else eids[left] = node.left;
    if (right == -1) { if (node.right != -1) return false; } else eids[right] = node.right;
    if (next == -1) { if (node.next != -1) return false; } else eids[next] = node.next;
    for (int at = 0; at < text.length; at++) if (expressions::text_byte(id, at) != int(text[at])) return false;
    return expressions::text_byte(id, -1) == -1 && expressions::text_byte(id, text.length) == -1;
}
`;
let batches = 0;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    let checks;
    if (fixture.error) {
      const at = position(fixture.input, fixture.start);
      checks = `if (statements::parse() != -1 || statements::node_count() != 0 || expressions::node_count() != 0 || !invalid(0)) return false;
        expressions::Node empty = expressions::node(0);
        if (empty.kind != expressions::kind::Invalid || expressions::text_byte(0, 0) != -1) return false;
        statements::Diagnostic error = statements::diagnostic();
        if (error.kind != statements::Error::${fixture.error} || error.expression != expressions::Error::${fixture.expressionError} ||
            error.lexical != lexer::Error::${fixture.lexical} || error.start != ${fixture.start} || error.length != ${fixture.length} ||
            error.line != ${at.line} || error.column != ${at.column}) return false;`;
    } else {
      const s = flatten([fixture.tree], ['body', 'other', 'next']);
      const e = flatten(s.nodes.flatMap(node => [node.expression, node.init, node.condition, node.step].filter(Boolean)), ['left', 'right', 'next']);
      const chunks = [];
      const assertions = [
        ...s.nodes.map((node, id) => {
          const at = position(fixture.input, node.start);
          return `if (!check_s(${id},statements::kind::${node.kind},${node.start},${node.length},${at.line},${at.column},
            ${[node.expression, node.init, node.condition, node.step].map(value => e.ids.get(value) ?? -1).join(',')},
            ${[node.body, node.other, node.next].map(value => s.ids.get(value) ?? -1).join(',')})) return false;`;
        }),
        ...e.nodes.map((node, id) => {
          const at = position(fixture.input, node.start);
          return `if (!check_e(${id},expressions::kind::${node.kind},expressions::op::${node.op},${node.start},${node.length},${at.line},${at.column},${node.value},${quote(node.text)},
            ${[node.left, node.right, node.next].map(value => e.ids.get(value) ?? -1).join(',')})) return false;`;
        }),
      ];
      for (let at = 0; at < assertions.length; at += 24) {
        const name = `check_${index}_${at}`;
        functions.push(`bool ${name}(){${assertions.slice(at, at + 24).join('\n')}return true;}`);
        chunks.push(`if (!${name}()) return false;`);
      }
      checks = `sids[0] = statements::parse();
        if (sids[0] == -1 || statements::node_count() != ${s.nodes.length} || expressions::node_count() != ${e.nodes.length}) return false;
        if (!invalid(-1) || !invalid(${s.nodes.length})) return false;
        for (int id = 0; id < ${s.nodes.length}; id++) sseen[id] = false;
        for (int id = 0; id < ${e.nodes.length}; id++) eseen[id] = false;
        lexer::rewind(); lexer::next();
        ${chunks.join('\n')}
        statements::Diagnostic error = statements::diagnostic();
        if (error.kind != statements::Error::None || error.expression != expressions::Error::None || error.lexical != lexer::Error::None ||
            error.start != 0 || error.length != 0 || error.line != 1 || error.column != 1) return false;`;
      statementChecks += s.nodes.length * 4; expressionChecks += e.nodes.length * 4;
    }
    functions.push(`bool case_${index}(){if (!load(${quote(fixture.input)})) return false;
      for (int pass = 0; pass < 2; pass++){${checks}}return !lexer::append(byte(32));}`);
    cases.push(`if (!case_${index}()) return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main;\nimport l.compiler.lexer as lexer;\nimport l.compiler.expressions as expressions;\nimport l.compiler.statements as statements;\n${helpers}\n${functions.join('\n')}\nint main(){${cases.join('\n')}return 0;}`);
  try {
    assert.equal(command(0, ['run', source, '--manifest', manifest]).stderr, '');
    command(0, ['compile', source, '--manifest', manifest, '-o', output]);
    command(0, ['check', output]); assert.equal(command(0, ['run', output]).stderr, '');
  } catch (error) { error.message += `\nFixtures: ${batch.map(f => f.name).join(', ')}`; throw error; }
  ++batches;
}
let batch = [];
for (const fixture of fixtures) {
  if (fixture.tree && (flatten([fixture.tree], ['body', 'other', 'next']).nodes.length > 100 || fixture.input.length > 1000)) {
    if (batch.length) runBatch(batch);
    batch = []; runBatch([fixture]);
  } else {
    batch.push(fixture); if (batch.length === 4) { runBatch(batch); batch = []; }
  }
}
if (batch.length) runBatch(batch);
const driver = resolve(root, 'bootstrap/stage1/statement_main.l');
const driverManifest = resolve(root, 'bootstrap/stage1/package.json');
const output = resolve(work, 'statements.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['{ for(i=0;i<3;i++) { if(i==1) continue; } return i; }', 0, ''],
  ['break;', 0, ''], ['if(1)return unknown;', 0, ''],
  ['', 65, 'statement:1:1: error: expected expression\n'],
  ['{', 65, 'statement:1:2: error: expected closing delimiter\n'],
  ['if true;', 65, 'statement:1:4: error: expected opening delimiter\n'],
  ['return 1', 65, "statement:1:9: error: expected ';' after statement\n"],
  ['switch(1){case 1;}', 65, "statement:1:17: error: expected ':' after switch label\n"],
  ['switch(1){;}', 65, 'statement:1:11: error: expected case or default label\n'],
  ['case 1:;', 65, 'statement:1:1: error: case/default requires an enclosing switch body\n'],
  [';;', 65, 'statement:1:2: error: unexpected token after statement\n'],
  ['@;', 65, 'statement:1:1: error: unsupported character in Stage 0 source\n'],
  ['{'.repeat(48) + ';' + '}'.repeat(48), 65, 'statement:1:49: error: syntax nesting exceeds 48\n'],
  ['{' + ';'.repeat(1024) + '}', 65, 'statement:1:1025: error: statement exceeds 1024 AST nodes\n'],
  ['int x=1;', 65, "statement:1:5: error: expected '(' after conversion type\n"],
  [Buffer.concat([Buffer.alloc(65534, 32), Buffer.from(';')]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'statement: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) {
  assert.equal(command(status, args, { input }).stderr, error);
}
console.log(`stage1 statements: ${fixtures.length} fixtures, ${statementChecks} statement and ${expressionChecks} expression node checks, ${batches} batches, ${commands} commands passed`);
