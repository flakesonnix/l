import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1-headers.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
const quote = value => `"${[...Buffer.from(value, 'latin1')].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
const position = (input, start) => ({ line: input.slice(0, start).split('\n').length,
  column: start - input.slice(0, start).lastIndexOf('\n') });
let commands = 0, nodeChecks = 0;
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stdout, ''); ++commands; return result;
}
const node = (kind, start, length, fields = {}) => ({ kind, start, length,
  path: null, alias: null, items: null, next: null, ...fields });
const fixtures = [];
function bad(input, error, start = input.length, length = start === input.length ? 0 : 1, lexical = 'None', prefix = false) {
  fixtures.push({ name: `bad ${JSON.stringify(input.slice(0, 55))}`, input, error, start, length, lexical, prefix });
}

// Trees precede syntax; emitted offsets are recorded, never reparsed.
function rendered(name, tree, options = {}) {
  let input = options.leading ?? '';
  const gap = options.gap ?? ' ';
  const put = text => { const start = input.length; input += text; return start; };
  function identifier(text) { return node('Name', put(text), text.length); }
  function path(text, separator) {
    let first = null, last = null;
    for (const part of text.split(separator)) {
      if (last) put(`${gap}${separator}${gap}`);
      const current = identifier(part);
      if (last) last.next = current; else first = current;
      last = current;
    }
    return first;
  }
  const result = node('Module', put('module'), 6);
  put(gap); result.path = path(tree.module, '.'); put(';');
  let last = null;
  for (const item of tree.imports ?? []) {
    put(gap); const imported = node('Import', put('import'), 6);
    put(gap); imported.path = path(item.path, '.');
    if (item.alias) {
      put(`${gap}as${gap}`); imported.alias = identifier(item.alias);
    } else if (item.selections) {
      put(`${gap}::${gap}{${gap}`); let previous = null;
      for (const selection of item.selections) {
        if (previous) put(`,${gap}`);
        const selected = node('Selection', input.length, selection.path.split('::')[0].length);
        selected.path = path(selection.path, '::');
        if (selection.alias) { put(`${gap}as${gap}`); selected.alias = identifier(selection.alias); }
        if (previous) previous.next = selected; else imported.items = selected;
        previous = selected;
      }
      if (item.trailing) put(',');
      put(`${gap}}`);
    }
    put(';');
    if (last) last.next = imported; else result.items = imported;
    last = imported;
  }
  put(options.trailing ?? '');
  const boundary = input.length;
  if (options.body) put(options.body);
  fixtures.push({ name, input, tree: result, prefix: !!options.body,
    cursor: options.body ? { start: boundary, kind: options.bodyKind, length: options.bodyLength } : null });
}

rendered('module only', { module: 'app.main' });
rendered('all import forms', { module: 'app.main', imports: [
  { path: 'std.io' }, { path: 'std.network.http', alias: 'http' },
  { path: 'app.types', selections: [{ path: 'Pair' }, { path: 'nested::Choice', alias: 'C' }], trailing: true },
] });
for (const gap of [' ', '\n', '\t', '\r', '/*gap*/', '//gap\n']) {
  rendered(`trivia ${JSON.stringify(gap)}`, { module: 'a.b.c', imports: [
    { path: 'd.e', alias: 'q' }, { path: 'd.e', selections: [{ path: 'ns::value', alias: 'x' }], trailing: true },
  ] }, { gap, leading: '\n/*before\xff*/\t', trailing: '\n//after\xff\n' });
}
for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'Module', 'IMPORT']) {
  rendered(`identifier ${name}`, { module: name, imports: [
    { path: name, alias: name }, { path: name, selections: [{ path: name, alias: name }] },
  ] });
}
rendered('duplicate bindings are semantic', { module: 'm', imports: [
  { path: 'p', alias: 'q' }, { path: 'p', alias: 'q' },
  { path: 'p', selections: [{ path: 'x' }, { path: 'x', alias: 'q' }] },
] });
for (const [body, kind, length] of [['int main(){}', 'Int', 3], ['pub struct T{};', 'Pub', 3],
  ['namespace n{}', 'Namespace', 9], ['seed + 1', 'Name', 4], ['"body"', 'Text', 6]]) {
  rendered(`prefix boundary ${kind}`, { module: 'm', imports: [{ path: 'p', alias: 'q' }] },
    { trailing: '\n/*body*/ ', body, bodyKind: kind, bodyLength: length });
}
// No body validation: a later lexical failure is beyond the prefix parser's remit.
rendered('prefix does not scan body', { module: 'm' }, { body: 'int @', bodyKind: 'Int', bodyLength: 3 });

let state = 0x6e17ba93;
function random(limit) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor(state / 0x100000000 * limit);
}
const names = ['app', 'net', 'io', 'Value', 'ns', 'constructor', '__proto__'];
const name = () => names[random(names.length)];
const path = separator => Array.from({ length: random(4) + 1 }, name).join(separator);
const generatedStart = fixtures.length;
for (let index = 0; index < 96; index++) {
  const imports = Array.from({ length: random(7) }, () => {
    const kind = random(3), result = { path: path('.') };
    if (kind === 1) result.alias = name();
    if (kind === 2) {
      result.selections = Array.from({ length: random(5) + 1 }, () => ({ path: path('::'), alias: random(2) ? name() : null }));
      result.trailing = !!random(2);
    }
    return result;
  });
  rendered(`generated ${index}`, { module: path('.'), imports }, { gap: [' ', '\n', '/*x*/'][random(3)] });
}
const generated = fixtures.slice(generatedStart).flatMap(fixture => flatten(fixture.tree).nodes);
for (const kind of ['Module', 'Import', 'Selection', 'Name']) assert.ok(generated.some(node => node.kind === kind), `missing ${kind}`);
for (const [description, condition] of [
  ['plain import', n => n.kind === 'Import' && !n.alias && !n.items],
  ['module alias', n => n.kind === 'Import' && n.alias],
  ['selection list', n => n.kind === 'Import' && n.items],
  ['selection alias', n => n.kind === 'Selection' && n.alias],
  ['default selection binding', n => n.kind === 'Selection' && !n.alias],
]) assert.ok(generated.some(condition), `generated headers must cover ${description}`);

for (const [input, error, marker] of [
  ['', 'ExpectedModule', ''], ['import p;', 'ExpectedModule', 'import'], ['pub module m;', 'ExpectedModule', 'pub'],
  ['module;', 'ExpectedName', ';'], ['module .m;', 'ExpectedName', '.'], ['module m.;', 'ExpectedName', ';'],
  ['module int;', 'ExpectedName', 'int'], ['module m::n;', 'ExpectedSemicolon', '::'], ['module m', 'ExpectedSemicolon', ''],
  ['module m; module n;', 'DuplicateModule', 'module n'], ['module m; import;', 'ExpectedName', ';'],
  ['module m; import p.;', 'ExpectedName', ';'], ['module m; import p as;', 'ExpectedName', ';'],
  ['module m; import p as int;', 'ExpectedName', 'int'], ['module m; import p as a.b;', 'ExpectedSemicolon', '.'],
  ['module m; import p as a::{x};', 'ExpectedSemicolon', '::'], ['module m; import p::*;', 'ExpectedSelection', '*'],
  ['module m; import p::x;', 'ExpectedSelection', 'x'], ['module m; import p::{};', 'ExpectedName', '}'],
  ['module m; import p::{x,,y};', 'ExpectedName', ',y'], ['module m; import p::{x::};', 'ExpectedName', '}'],
  ['module m; import p::{x.y};', 'ExpectedClose', '.'], ['module m; import p::{x as};', 'ExpectedName', '}'],
  ['module m; import p::{x as a::b};', 'ExpectedClose', '::b'], ['module m; import p::{x', 'ExpectedClose', ''],
  ['module m; import p::{x}; import', 'ExpectedName', ''], ['module m; import p', 'ExpectedSemicolon', ''],
  ['module m; import p::{x} as y;', 'ExpectedSemicolon', 'as'], ['module m;;', 'TrailingInput', ';'],
  ['module m; int main(){}', 'TrailingInput', 'int'], ['module m; pub import p;', 'TrailingInput', 'pub'],
  ['module m; namespace n {import p;}', 'TrailingInput', 'namespace'],
]) {
  let start = marker ? input.indexOf(marker) : input.length;
  if (marker === ';') start = input.lastIndexOf(';');
  const length = marker && /^[A-Za-z]/.test(marker) ? marker.split(' ')[0].length : marker.startsWith('::') ? 2 : undefined;
  bad(input, error, start, length);
}
bad('@', 'Lexical', 0, 1, 'UnsupportedCharacter');
bad('module m; import p as @;', 'Lexical', 22, 1, 'UnsupportedCharacter');
bad('module m; /*', 'Lexical', 10, 2, 'UnterminatedComment');
bad('module m; @', 'Lexical', 10, 1, 'UnsupportedCharacter', true);
bad('module m; module n;', 'DuplicateModule', 10, 6, 'None', true);
bad('module m; import p; module n;', 'DuplicateModule', 20, 6);
rendered('full path arena', { module: Array(2047).fill('x').join('.') }, { gap: ' ' });
const overflowPath = 'module ' + Array(2048).fill('x').join('.') + ';';
bad(overflowPath, 'TooManyNodes', overflowPath.length - 2);
rendered('full import arena', { module: 'm', imports: Array.from({ length: 1023 }, () => ({ path: 'p' })) });
const overflowImports = 'module m;' + 'import p;'.repeat(1024);
bad(overflowImports, 'TooManyNodes', overflowImports.length - 9, 6);
rendered('full selection arena', { module: 'm', imports: [{ path: 'p', selections: Array.from({ length: 1022 }, () => ({ path: 'x' })) }] });
const overflowSelections = 'module m;import p::{' + Array(1023).fill('x').join(',') + '};';
bad(overflowSelections, 'TooManyNodes', overflowSelections.length - 3);
rendered('full alias arena', { module: Array(2044).fill('x').join('.'), imports: [{ path: 'p', alias: 'q' }] });
const overflowAlias = 'module ' + Array(2045).fill('x').join('.') + ';import p as q;';
bad(overflowAlias, 'TooManyNodes', overflowAlias.lastIndexOf('q'));

// Repository headers use simple module/alias imports; regex spans are an
// independent oracle for these concrete sources, not a general header parser.
for (const [file, bodyKind, bodyLength] of [['lexer.l', 'Pub', 3], ['expressions.l', 'Pub', 3],
  ['statements.l', 'Pub', 3], ['headers.l', 'Pub', 3], ['header_main.l', 'Void', 4]]) {
  const input = readFileSync(resolve(root, 'bootstrap/stage1', file), 'utf8');
  const declaration = /\bmodule ([A-Za-z_][A-Za-z_0-9.]*)\s*;/.exec(input);
  assert.ok(declaration);
  function pathAt(text, start) {
    let first = null, last = null;
    for (const part of text.split('.')) {
      const item = node('Name', start, part.length);
      if (last) last.next = item; else first = item;
      last = item; start += part.length + 1;
    }
    return first;
  }
  const tree = node('Module', declaration.index, 6,
    { path: pathAt(declaration[1], declaration.index + 7) });
  let last = null, end = declaration.index + declaration[0].length;
  for (const imported of input.matchAll(/\bimport ([A-Za-z_][A-Za-z_0-9.]*)(?: as ([A-Za-z_][A-Za-z_0-9]*))?\s*;/g)) {
    const item = node('Import', imported.index, 6, { path: pathAt(imported[1], imported.index + 7) });
    if (imported[2]) item.alias = node('Name', imported.index + imported[0].indexOf(' as ') + 4, imported[2].length);
    if (last) last.next = item; else tree.items = item;
    last = item; end = imported.index + imported[0].length;
  }
  const start = input.indexOf(bodyKind.toLowerCase(), end);
  assert.ok(start >= end);
  fixtures.push({ name: `repository prefix ${file}`, input, tree, prefix: true,
    cursor: { start, kind: bodyKind, length: bodyLength } });
}

function flatten(tree) {
  const nodes = [], ids = new Map(), pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    assert.ok(!ids.has(node), 'model must not alias nodes'); ids.set(node, nodes.length); nodes.push(node);
    for (const field of ['next', 'items', 'alias', 'path']) if (node[field]) pending.push(node[field]);
  }
  return { nodes, ids };
}
const helpers = `
static int ids[headers::max_nodes];
static bool seen[headers::max_nodes];
bool load(string input) {
    lexer::reset();
    for (int at = 0; at < input.length; at++) if (!lexer::append(input[at])) return false;
    return true;
}
bool invalid(int id) {
    headers::Node n = headers::node(id);
    return n.kind == headers::kind::Invalid && n.start == 0 && n.length == 0 && n.line == 0 && n.column == 0 &&
        n.path == -1 && n.alias == -1 && n.items == -1 && n.next == -1;
}
bool check(int index, int kind, int start, int length, int line, int column, int path, int alias, int items, int next) {
    int id = ids[index];
    if (id < 0 || id >= headers::node_count() || seen[id]) return false;
    seen[id] = true;
    headers::Node n = headers::node(id);
    if (n.kind != kind || n.start != start || n.length != length || n.line != line || n.column != column) return false;
    if (path == -1) { if (n.path != -1) return false; } else ids[path] = n.path;
    if (alias == -1) { if (n.alias != -1) return false; } else ids[alias] = n.alias;
    if (items == -1) { if (n.items != -1) return false; } else ids[items] = n.items;
    if (next == -1) { if (n.next != -1) return false; } else ids[next] = n.next;
    return true;
}
bool handoff() {
    if (!load("module m; import p as q; seed+1")) return false;
    if (headers::parse_prefix() == -1 || expressions::node_count() != 0) return false;
    int count = headers::node_count();
    int root = expressions::parse_next();
    if (root == -1 || expressions::node_count() != 3 || headers::node_count() != count) return false;
    if (expressions::node(root).kind != expressions::kind::Binary || expressions::current().kind != lexer::Kind::End) return false;
    if (headers::parse() != -1 || headers::diagnostic().kind != headers::Error::TrailingInput) return false;
    return headers::node_count() == 0 && expressions::node_count() == 0 && invalid(0);
}
`;
let batches = 0;
function runBatch(batch) {
  const functions = [], cases = [];
  for (const [index, fixture] of batch.entries()) {
    const method = fixture.prefix ? 'parse_prefix' : 'parse';
    let checks;
    if (fixture.error) {
      const at = position(fixture.input, fixture.start);
      checks = `if (headers::${method}() != -1 || headers::node_count() != 0 || expressions::node_count() != 0 || !invalid(0)) return false;
        headers::Diagnostic error = headers::diagnostic();
        if (error.kind != headers::Error::${fixture.error} || error.lexical != lexer::Error::${fixture.lexical} ||
            error.start != ${fixture.start} || error.length != ${fixture.length} || error.line != ${at.line} || error.column != ${at.column}) return false;`;
    } else {
      const { nodes, ids } = flatten(fixture.tree), chunks = [];
      const assertions = nodes.map((node, id) => {
        const at = position(fixture.input, node.start);
        return `if (!check(${id},headers::kind::${node.kind},${node.start},${node.length},${at.line},${at.column},
          ${[node.path, node.alias, node.items, node.next].map(value => ids.get(value) ?? -1).join(',')})) return false;`;
      });
      for (let at = 0; at < nodes.length; at += 24) {
        const name = `check_${index}_${at}`;
        functions.push(`bool ${name}(){${assertions.slice(at, at + 24).join('\n')}return true;}`);
        chunks.push(`if (!${name}()) return false;`);
      }
      const cursor = fixture.cursor;
      checks = `ids[0] = headers::${method}();
        if (ids[0] == -1 || headers::node_count() != ${nodes.length} || expressions::node_count() != 0) return false;
        if (!invalid(-1) || !invalid(${nodes.length})) return false;
        ${cursor ? `lexer::Token at = expressions::current();
          if (at.kind != lexer::Kind::${cursor.kind} || at.start != ${cursor.start} || at.length != ${cursor.length}) return false;` : ''}
        for (int id = 0; id < ${nodes.length}; id++) seen[id] = false;
        lexer::rewind(); lexer::next();
        ${chunks.join('\n')}
        headers::Diagnostic error = headers::diagnostic();
        if (error.kind != headers::Error::None || error.lexical != lexer::Error::None || error.start != 0 ||
            error.length != 0 || error.line != 1 || error.column != 1) return false;`;
      nodeChecks += nodes.length * 4;
    }
    functions.push(`bool case_${index}(){if (!load(${quote(fixture.input)})) return false;
      for (int pass = 0; pass < 2; pass++){${checks}}return !lexer::append(byte(32));}`);
    cases.push(`if (!case_${index}()) return ${index + 1};`);
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main;\nimport l.compiler.lexer as lexer;\nimport l.compiler.expressions as expressions;\nimport l.compiler.headers as headers;\n${helpers}\n${functions.join('\n')}\nint main(){${cases.join('\n')}if(!handoff())return 63;return 0;}`);
  try {
    assert.equal(command(0, ['run', source, '--manifest', manifest]).stderr, '');
    command(0, ['compile', source, '--manifest', manifest, '-o', output]);
    command(0, ['check', output]); assert.equal(command(0, ['run', output]).stderr, '');
  } catch (error) {
    throw new Error(`Fixtures: ${batch.map(f => f.name).join(', ')}\n${error.message}`, { cause: error });
  }
  ++batches;
}
let batch = [];
for (const fixture of fixtures) {
  if (fixture.input.length > 1000 || (fixture.tree && flatten(fixture.tree).nodes.length > 100)) {
    if (batch.length) runBatch(batch);
    batch = []; runBatch([fixture]);
  } else {
    batch.push(fixture); if (batch.length === 4) { runBatch(batch); batch = []; }
  }
}
if (batch.length) runBatch(batch);
const driver = resolve(root, 'bootstrap/stage1/header_main.l');
const driverManifest = resolve(root, 'bootstrap/stage1/package.json');
const output = resolve(work, 'headers.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['module app.main; import std.io; import app.types::{Pair, ns::Value as V,};', 0, ''],
  ['module m; import p as q; import p as q;', 0, ''],
  ['', 65, 'header:1:1: error: source must begin with a module declaration\n'],
  ['module m', 65, "header:1:9: error: expected ';' after module/import declaration\n"],
  ['module m; import p::*;', 65, "header:1:21: error: selective imports require '{'; wildcard imports are not supported\n"],
  ['module m; import p::{};', 65, 'header:1:22: error: expected identifier\n'],
  ['module m; import p::{x', 65, "header:1:23: error: expected '}' after selective imports\n"],
  ['module m; module n;', 65, 'header:1:11: error: module declaration must not repeat\n'],
  ['module m; int main(){}', 65, 'header:1:11: error: unexpected token after module/import header\n'],
  ['module m; @', 65, 'header:1:11: error: unsupported character in Stage 0 source\n'],
  [overflowPath, 65, `header:1:${overflowPath.length - 1}: error: header exceeds 2048 AST nodes\n`],
  [Buffer.concat([Buffer.from('module m;'), Buffer.alloc(65526, 32)]), 0, ''],
  [Buffer.alloc(65536, 32), 65, 'header: source exceeds 65535 bytes\n'],
]) for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) {
  assert.equal(command(status, args, { input }).stderr, error);
}
for (const file of ['lexer.l', 'expressions.l', 'statements.l', 'headers.l', 'header_main.l']) {
  const input = readFileSync(resolve(root, 'bootstrap/stage1', file), 'utf8');
  // The header-only driver must reject actual source bodies rather than claim full-file parsing.
  assert.match(command(65, ['run', output], { input }).stderr, /unexpected token after module\/import header/);
}
console.log(`stage1 headers: ${fixtures.length} fixtures, ${nodeChecks} modeled node checks, ${batches} batches, ${commands} commands passed`);
