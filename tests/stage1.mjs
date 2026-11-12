import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const compiler = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'build'), { recursive: true });
const work = mkdtempSync(resolve(root, 'build/stage1.'));
const manifest = resolve(work, 'package.json');
writeFileSync(manifest, JSON.stringify({ version: 1, package: 'tests', module_roots: [
  { package: 'tests', prefix: 'tests', path: work },
  { package: 'l_compiler', prefix: 'l.compiler', path: resolve(root, 'bootstrap/stage1') },
], dependencies: [{ from: 'tests', to: 'l_compiler' }] }));
let executions = 0, tokenChecks = 0;
function command(status, args, options = {}) {
  const result = spawnSync(compiler, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stderr}`);
  ++executions;
  return result;
}
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
const quote = value => `"${[...bytes(value)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
const keywords = new Map([
  'int', 'bool', 'void', 'auto', 'const', 'true', 'false', 'if', 'else', 'while', 'for',
  'return', 'module', 'break', 'continue', 'switch', 'case', 'default', 'import', 'as',
  'pub', 'namespace', 'static', 'using', 'struct', 'enum', 'byte', 'string', 'extern', 'let', 'in', 'var', 'then',
].map(word => [word, word[0].toUpperCase() + word.slice(1)]));
const singles = Object.fromEntries([...('{}()[];:,.+-*/%!<>=')].map((value, index) => [value, [
  'LeftBrace', 'RightBrace', 'LeftParen', 'RightParen', 'LeftBracket', 'RightBracket',
  'Semicolon', 'Colon', 'Comma', 'Dot', 'Plus', 'Minus', 'Star', 'Slash', 'Percent',
  'Bang', 'Less', 'Greater', 'Assign',
][index]]));
const pairs = { '==': 'Equal', '!=': 'NotEqual', '<=': 'LessEqual', '>=': 'GreaterEqual',
  '&&': 'And', '||': 'Or', '++': 'Increment', '--': 'Decrement', '::': 'Scope', '=>': 'Arrow' };
function position(source, start) {
  const prefix = source.subarray(0, start).toString('latin1');
  return { line: prefix.split('\n').length, column: start - prefix.lastIndexOf('\n') };
}
function token(source, kind, start, length, fields = {}) {
  return { kind, start, length, ...position(source, start), magnitude: 0, text: Buffer.alloc(0), error: 'None', ...fields };
}

// Independent successful-input model: regex spans, BigInt magnitudes, prefix-derived positions.
function model(input) {
  const source = bytes(input), text = source.toString('latin1'), tokens = [];
  let at = 0;
  while (at < text.length) {
    const tail = text.slice(at);
    const trivia = /^(?:[ \t\r\n]+|\/\/[^\n\0]*|\/\*(?:(?!\*\/|\0)[\s\S])*\*\/)/.exec(tail);
    if (trivia) { at += trivia[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(tail);
    const integer = /^[0-9]+/.exec(tail);
    const literal = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\(?:["\\nrt0]|x[0-9a-fA-F]{2}))*"/.exec(tail);
    let kind, length, fields = {};
    if (name) { kind = keywords.get(name[0]) ?? 'Name'; length = name[0].length; }
    else if (integer) {
      assert.ok(BigInt(integer[0]) <= 2147483648n);
      assert.doesNotMatch(tail.slice(integer[0].length), /^[A-Za-z_]/);
      kind = 'Integer'; length = integer[0].length; fields.magnitude = -Number(BigInt(integer[0]));
    } else if (literal) {
      kind = 'Text'; length = literal[0].length;
      fields.text = Buffer.from(literal[0].slice(1, -1).replace(/\\(?:x([0-9a-fA-F]{2})|(["\\nrt0]))/g,
        (_, hex, escape) => String.fromCharCode(hex ? parseInt(hex, 16) :
          ({ '"': 34, '\\': 92, n: 10, r: 13, t: 9, 0: 0 })[escape])), 'latin1');
    } else if (pairs[tail.slice(0, 2)]) { kind = pairs[tail.slice(0, 2)]; length = 2; }
    else { kind = singles[tail[0]]; length = 1; }
    assert.ok(kind, `invalid successful model input at ${at}: ${JSON.stringify(tail.slice(0, 30))}`);
    tokens.push(token(source, kind, at, length, fields));
    at += length;
  }
  tokens.push(token(source, 'End', source.length, 0));
  return tokens;
}

const fixtures = [];
function good(name, input) { fixtures.push({ name, input: bytes(input), tokens: model(input) }); }
function bad(name, input, error, length, start = 0, prefix = []) {
  const source = bytes(input);
  fixtures.push({ name, input: source, tokens: [...prefix, token(source, 'Invalid', start, length, { error })] });
}
good('empty', '');
good('whitespace', ' \t\r\n\r\n  ');
good('punctuation', Object.keys(singles).join(' ') + ' ' + Object.keys(pairs).join(' '));
good('maximal munch', '=== !== <== >== && || +++ --- ::: a/**/b//tail\nZ');
good('replacement tokens and adjacency', 'let in var => ==> =>= = > if then else letx inner var1 thenx Let In Var Then');
for (const word of keywords.keys()) {
  good(`keyword ${word}`, [word, `${word}x`, `x${word}`, word.toUpperCase(), word.slice(0, -1)].join(' '));
}
for (const name of ['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
  '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'valueOf', '__proto__', 'toLocaleString']) {
  assert.equal(model(name)[0].kind, 'Name');
  good(`prototype identifier ${name}`, name);
}
good('numbers', '0 00 00017 2147483647 2147483648 -2147483648 0002147483648 12.3');
good('strings', '"" "hello" "\\n\\r\\t\\0\\\\\\\"" "\\x00\\x7f\\x80\\xFF\\xAa\\xaA"');
good('all decoded byte values', `"${Array.from({ length: 256 }, (_, value) => `\\x${value.toString(16).padStart(2, '0')}`).join('')}"`);
good('comments', '/* outer /* not nested */name //tail\r\n/*\n\r\t*/ int');
for (const [input, error, length] of [
  ['2147483649', 'IntegerRange', 10], ['999999999999999999', 'IntegerRange', 10],
  ['21474836480', 'IntegerRange', 11], ['12name', 'IntegerSuffix', 2],
  ['0x10', 'IntegerSuffix', 1], ['1_', 'IntegerSuffix', 1],
  ['/*', 'UnterminatedComment', 2], ['/*abc*', 'UnterminatedComment', 6],
  ['/*\0*/', 'Nul', 3], ['//\0', 'Nul', 3],
  ['"', 'UnterminatedString', 1], ['"abc', 'UnterminatedString', 4],
  ['"\\', 'UnterminatedEscape', 2], ['"\\x', 'HexEscape', 3], ['"\\xA', 'HexEscape', 3],
  ['"\\xG0"', 'HexEscape', 4], ['"\\x0G"', 'HexEscape', 5],
  ['"\\q"', 'UnsupportedEscape', 3], ['"ok\\q"', 'UnsupportedEscape', 5],
  ['"\n"', 'NonPrintableString', 2], ['"\0"', 'NonPrintableString', 2],
  ['&', 'UnsupportedCharacter', 1], ['|', 'UnsupportedCharacter', 1],
]) bad(`malformed ${JSON.stringify(input)}`, input, error, length);
bad('multiline location', ' \r\n\t/*missing', 'UnterminatedComment', 9, 4);
for (let value = 0; value < 256; ++value) {
  const one = Buffer.from([value]);
  if (value === 34) bad('lone quote', one, 'UnterminatedString', 1);
  else if (/[A-Za-z_0-9 \t\r\n]/.test(one.toString('latin1')) || singles[String.fromCharCode(value)]) good(`byte ${value}`, one);
  else bad(`byte ${value}`, one, value === 0 ? 'Nul' : 'UnsupportedCharacter', 1);
  const string = Buffer.from([34, value, 34]);
  if (value === 34) bad('quote ends string', string, 'UnterminatedString', 1, 2, [token(string, 'Text', 0, 2)]);
  else if (value === 92) bad('escaped closing quote', string, 'UnterminatedString', 3);
  else if (value >= 32 && value <= 126) good(`string byte ${value}`, string);
  else bad(`string byte ${value}`, string, 'NonPrintableString', 2);
  for (const [name, input] of [
    ['line', Buffer.concat([Buffer.from('//'), one, Buffer.from('\nname')])],
    ['block', Buffer.concat([Buffer.from('/*'), one, Buffer.from('*/name')])],
  ]) {
    if (value === 0) bad(`${name} NUL`, input, 'Nul', 3);
    else good(`${name} byte ${value}`, input);
  }
}
let state = 0x51a9c037;
function random(limit) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; }
const atoms = [...keywords.keys(), ...Object.keys(singles), ...Object.keys(pairs),
  '_', 'Name09', 'intx', 'xint', '2147483648', '00042', '""', '"\\x00\\xff"', '"a\\n"'];
const separators = [' ', '\t', '\r', '\n', '/*x*/', '//x\n', '/*\n*/'];
for (let index = 0; index < 64; ++index) {
  let input = '';
  for (let part = 0; part < 48; ++part) input += atoms[random(atoms.length)] + separators[random(separators.length)];
  good(`model ${index}`, input);
}
for (const path of ['bootstrap/stage1/lexer.l', 'bootstrap/stage1/main.l',
  'bootstrap/stage1/expressions.l', 'bootstrap/stage1/expression_main.l', 'stdlib/io.l',
  'bootstrap/stage1/statements.l', 'bootstrap/stage1/statement_main.l',
  'bootstrap/stage1/headers.l', 'bootstrap/stage1/header_main.l',
  'bootstrap/stage1/functions.l', 'bootstrap/stage1/function_main.l',
  'bootstrap/stage1/bindings.l', 'bootstrap/stage1/binding_main.l',
  'examples/struct_demo.l', 'examples/enum_demo.l', 'examples/static_buffers.l']) {
  good(path, readFileSync(resolve(root, path)));
}

const helpers = `
bool load(string source) {
    lexer::reset();
    if (lexer::source_byte(0) != -1 || lexer::text_byte(0) != -1) return false;
    for (int index = 0; index < source.length; index++) {
        if (!lexer::append(source[index])) return false;
        if (lexer::source_byte(index) != int(source[index])) return false;
    }
    return lexer::source_byte(-1) == -1 && lexer::source_byte(source.length) == -1;
}
bool expect(lexer::Kind kind, int start, int length, int line, int column,
            int magnitude, lexer::Error error, string text) {
    lexer::Token token = lexer::next();
    if (token.kind != kind || token.start != start || token.length != length ||
        token.line != line || token.column != column || token.magnitude != magnitude ||
        token.error != error || token.text_length != text.length) return false;
    for (int index = 0; index < text.length; index++) {
        if (lexer::text_byte(index) != int(text[index])) return false;
    }
    return lexer::text_byte(-1) == -1 && lexer::text_byte(text.length) == -1;
}
`;
let batches = 0;
function runBatch(batch) {
  const functions = [];
  const cases = [];
  for (const [index, fixture] of batch.entries()) {
    const tokens = [...fixture.tokens, fixture.tokens.at(-1), fixture.tokens.at(-1)];
    const chunks = [];
    for (let at = 0; at < tokens.length; at += 24) {
      const name = `check_${index}_${at}`;
      functions.push(`bool ${name}() {\n${tokens.slice(at, at + 24).map(token =>
        `if (!expect(lexer::Kind::${token.kind},${token.start},${token.length},${token.line},${token.column},${token.magnitude},lexer::Error::${token.error},${quote(token.text)})) return false;`).join('\n')}\nreturn true;}`);
      chunks.push(`if (!${name}()) return false;`);
    }
    functions.push(`bool case_${index}() {
      if (!load(${quote(fixture.input)})) return false;
      for (int pass = 0; pass < 2; pass++) {
        lexer::rewind();
        ${chunks.join('\n')}
        if (lexer::append(byte(65))) return false;
      }
      return true;
    }`);
    cases.push(`if (!case_${index}()) return ${index + 1};`);
    tokenChecks += tokens.length * 4;
  }
  const source = resolve(work, 'main.l'), output = resolve(work, 'model.lbc');
  writeFileSync(source, `module tests.main;\nimport l.compiler.lexer as lexer;\n${helpers}\n${functions.join('\n')}\nint main(){${cases.join('\n')}return 0;}\n`);
  try {
    command(0, ['run', source, '--manifest', manifest]);
    command(0, ['compile', source, '--manifest', manifest, '-o', output]);
    command(0, ['check', output]);
    const result = command(0, ['run', output]);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  } catch (error) { error.message += `\nFixtures: ${batch.map(f => f.name).join(', ')}`; throw error; }
  ++batches;
}
// Large repository sources get their own program to stay inside the seed's function/budget limits.
let batch = [];
for (const fixture of fixtures) {
  if (fixture.tokens.length > 100) {
    if (batch.length) runBatch(batch);
    batch = [];
    runBatch([fixture]);
  } else {
    batch.push(fixture);
    if (batch.length === 12) { runBatch(batch); batch = []; }
  }
}
if (batch.length) runBatch(batch);

const driver = resolve(root, 'bootstrap/stage1/main.l');
const driverManifest = resolve(root, 'bootstrap/stage1/package.json');
const output = resolve(work, 'lexer.lbc');
command(0, ['compile', driver, '--manifest', driverManifest, '-o', output]);
for (const [input, status, error] of [
  ['', 0, ''], ['module missing; return', 0, ''],
  [readFileSync(resolve(root, 'bootstrap/stage1/lexer.l')), 0, ''],
  [' \n\t@', 65, 'lexer:2:2: error: unsupported character in Stage 0 source\n'],
  ['2147483649', 65, 'lexer:1:1: error: integer literal exceeds int range\n'],
  ['"\\q"', 65, 'lexer:1:1: error: unsupported string escape\n'],
  ['\0', 65, 'lexer:1:1: error: NUL byte in source\n'],
  ['/*x', 65, 'lexer:1:1: error: unterminated block comment\n'],
  ['"x', 65, 'lexer:1:1: error: unterminated string literal\n'],
  ['"\\', 65, 'lexer:1:1: error: unterminated string escape\n'],
  ['"\\xG0"', 65, 'lexer:1:1: error: string hex escape requires two hexadecimal digits\n'],
  ['"\x80"', 65, 'lexer:1:1: error: string literals require printable ASCII or byte escapes\n'],
  ['12x', 65, 'lexer:1:1: error: invalid integer literal\n'],
  [Buffer.alloc(65535, 32), 0, ''],
  [Buffer.concat([Buffer.alloc(65534, 32), Buffer.from('@')]), 65,
    'lexer:1:65535: error: unsupported character in Stage 0 source\n'],
  [Buffer.alloc(65536, 32), 65, 'lexer: source exceeds 65535 bytes\n'],
]) {
  for (const args of [['run', driver, '--manifest', driverManifest], ['run', output]]) {
    const result = command(status, args, { input });
    assert.equal(result.stdout, ''); assert.equal(result.stderr, error);
  }
}
console.log(`stage1 lexer: ${fixtures.length} fixtures, ${tokenChecks} modeled token checks, ${batches} batches, ${executions} commands passed`);
