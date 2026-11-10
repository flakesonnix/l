# Stage 1: L-written frontend slices

These are the first L-written implementation slices. Stage 0 compiles them to
existing **1.9 bytecode**, and the Stage 0 VM executes them. There is no L-written
full source-file/top-level declaration parser, semantic checker, code generator or
complete compiler yet. The statement parser includes local declarations; the
header parser handles module/import prefixes only. Running a
lexer over its own source is **not self-hosting**.

## Build and run

From the repository root:

```sh
make
make stage1
./build/l run build/stage1-lexer.lbc < examples/answer.l
./build/l run build/stage1-lexer.lbc < bootstrap/stage1/lexer.l
printf 'a = f(1, 2) + -3' | ./build/l run build/stage1-expression.lbc
printf '{ int sum=0; for(int i=0;i<3;i++) sum=sum+i; return sum; }' | ./build/l run build/stage1-statement.lbc
printf 'module app.main; import std.io; import app.types::{Pair as P,};' | ./build/l run build/stage1-header.lbc
node tests/stage1.mjs ./build/l
node tests/stage1-expressions.mjs ./build/l
node tests/stage1-statements.mjs ./build/l
node tests/stage1-headers.mjs ./build/l
```

Alternatively run the driver directly from source:

```sh
./build/l run bootstrap/stage1/main.l \
  --manifest bootstrap/stage1/package.json < examples/answer.l
```

The lexer driver reads raw stdin bytes. Success produces no output and exits 0. A
lexical error produces a diagnostic on stderr and exits 65; input overflow also exits 65.
Reported stream errors retain the VM's trap behavior (70). It validates tokens
only: input such as `module missing; return` intentionally succeeds. It does not
resolve the input's modules or check its entry point, grammar or types.

The separate expression driver accepts exactly one expression, without a trailing
semicolon. It also produces no output on success (0), reports syntax/input-limit
errors on stderr (65), and retains stream-trap behavior (70). Run it from source
with `bootstrap/stage1/expression_main.l` and the same manifest. It does **not**
evaluate expressions, resolve names or check types: `1 + true`, `unknown(42)` and
the boundary magnitude `2147483648` are syntactically accepted. The later semantic
checker must enforce the integer boundary's use under unary minus, as Stage 0 does.

The statement driver (`bootstrap/stage1/statement_main.l`, with the same manifest)
checks exactly one statement or block. It uses the same 0/65/70 success, diagnostic
and stream-trap conventions. Blocks, expression/empty statements, `if`/`else`,
`while`, `for`, `return`, `break`, `continue`, and `switch` labels are supported.
Local scalar/array declarations are supported, including declaration initializers
in `for` headers. Statement sequences must be wrapped in a block; full source files
with modules/functions are not accepted.

This is still syntax only: `break;` outside a loop, non-bool conditions, unknown
names and duplicate switch labels are not semantically checked. Input loops,
calls and other expressions are parsed, **never executed**.

The header driver (`bootstrap/stage1/header_main.l`, with the same manifest)
checks a module declaration followed by zero or more imports and EOF. It uses the
same 0/65/70 conventions. Dotted paths, module aliases, selective imports, qualified
selected names, selective aliases and optional trailing selection commas follow
the existing Stage 0 grammar and the normative module specification. Empty
selection lists and wildcard imports are rejected. Top-level bodies are rejected
as trailing input: this driver does **not** check complete source files.

The manifest explicitly registers the `l.compiler` and `std` roots and the compiler
package's direct standard-library dependency. Nothing is implicitly searched.
The Nix package installs this directory under `share/l/bootstrap/stage1/`, together
with the stdlib at the relative location required by its manifest.

## Current scanner contract

`lexer.l` is an internal, single-scanner module, not a new standard-library API.
Its declarations use the existing module, enum, struct and static-array syntax.

- `reset()` discards the logical input and opens a fresh load phase.
- `append(byte)` accepts bytes until the 65535-byte capacity is reached. It returns
  false without changing the input when full or after scanning has started.
- `next()` seals the input and returns one `Token`. Comments and whitespace are
  skipped. EOF repeats without moving; the first error is sticky and also repeats.
- `rewind()` resets scanning and errors while retaining the source. It does not
  reopen sealed input for appending. `reset()` is required to load another source.
- `source_byte(index)` returns the original byte as an int, or -1 outside the
  logical input. It remains available after EOF or an error.
- `text_byte(index)` returns a decoded byte from the current `Text` token, or -1
  outside its logical decoded length. Those bytes expire at the next `next()`,
  `rewind()` or `reset()`. Errors expose no partially decoded string.

Each token has its kind, zero-based byte offset, raw source length, one-based line
and column, nonpositive decimal magnitude, decoded string length and error kind.
Only LF advances the line; tabs and CR each advance the byte column by one.
Quoted-token spans include quotes and escapes, while `text_length` counts decoded
bytes. Errors point to the opening token/comment; their raw span includes consumed
input up to detection. The unconsumed identifier suffix of an invalid integer is
not part of that span.

Integer magnitudes are stored as **minus the written decimal value**, allowing
`2147483648` to be represented as `-2147483648` using only an existing 32-bit int.
Signs are separate tokens. The later semantic checker must decide where that boundary
magnitude is legal; the lexer does not accept it as an ordinary positive int value.

The recognized keywords, ASCII identifiers, decimal literals, punctuation,
two-byte operators, comments and literal-backed string escapes match Stage 0's
lexical subset. Comments are non-nesting and may contain high bytes, but not NUL.
Raw string contents must be printable ASCII; escapes preserve all 256 byte values.
Error kinds are internal diagnostics, not a serialized token or compiler-artifact
format.

## Current expression parser contract

`expressions.l` is another internal module, with no serialized AST format or new
standard-library API. It supports the existing expression syntax: literals,
qualified names, grouping, prefix `+`/`-`/`!`, all binary operators, right-associative
assignment, calls, positional struct literals, field/index access, postfix updates
and `int(...)`/`byte(...)` conversions. Calls reject a trailing comma; struct
literals permit one, matching Stage 0. Syntax acceptance does not imply semantic
validity (for example, assigning to a literal is not type/lvalue checked here).

Load bytes through the existing lexer API, then call `expressions::parse()`:

- Parsing rewinds the source and rebuilds its arena. It returns a root node ID or
  -1 on failure and requires EOF after the expression.
- `node_count()` and `node(id)` expose the complete successful tree. IDs are
  zero-based; -1 means an absent child. An invalid ID returns an `Invalid` sentinel
  with zero metadata and absent children. Failed parses expose no partial nodes.
- `diagnostic()` returns the first encountered error, its byte span and location,
  plus the lexer error kind for a lexical failure. Diagnostics are streaming;
  their precedence need not match Stage 0's full-file lexical prepass.
- Repeating `parse()` replays the same input and resets both failures and storage.
  Loading another input requires the lexer's `reset()` as before. Node IDs expire
  at the next parse/begin or source replacement; they are not generation-checked handles.

Each `Node` contains an integer `kind` and `op` tag (from the module's `kind`/`op`
namespaces), an associated token's start/length/line/column, `value`, `text_length`,
and `left`/`right`/`next` links. Operator nodes refer to the operator token; calls,
struct literals and indexes refer to their opening delimiter; fields refer to the
field identifier. These spans are **not whole-expression spans**. Grouping is
discarded, while unary minus is retained rather than evaluated or folded.

- `Integer.value` retains the lexer's nonpositive decimal magnitude; `Bool.value`
  is 0/1. Other nodes use zero.
- Qualified names use a `right` chain of individual `Name` segments.
- Calls/struct literals use `left` for the callee/type expression and `right` for
  the first argument. Argument roots use `next` to link siblings. Other `next`
  links are absent. Index nodes use `right` for the index expression.
- String bytes are copied before advancing the lexer. `text_byte(node, index)`
  returns a retained decoded byte, or -1 outside that text node. Rewinding or
  advancing the lexer does not replace those copies; parsing again does.

The larger statement parser uses internal streaming operations:
`begin()` resets the expression arena/cursor, `current()` exposes the current
token, `consume(kind)` advances a matching token, and `parse_next()` parses an
expression without requiring EOF. They retain multiple roots in one arena.
Balanced `enter()`/`leave()` calls share the syntax-depth budget. Streaming callers
must check diagnostics and call `discard()` on failure; unlike standalone
`parse()`, intermediate streaming operations are not whole-input transactions.
`statements::parse()` owns that transaction and hides both arenas on failure.

## Current statement and local-declaration contract

`statements::parse()` rewinds the loaded source, resets both syntax arenas, and
returns a statement root ID or -1. It requires EOF after that one statement.
`node_count()`, `node(id)` and `diagnostic()` follow the expression parser's
checked-access/replay conventions. Invalid statement IDs produce zero token
metadata and -1 for all child/expression links. Failed parses expose no partial
statement or expression nodes. IDs expire at the next parse/source replacement.

Statement and expression IDs are **different arenas**:

- `expression` refers to an expression-statement value, return operand, switch
  selector or case label in `expressions.l`.
- `condition` refers to an if/while/for condition. For loops additionally use
  `init` and `step` as expression IDs; omitted header expressions are -1. A
  declaration initializer instead uses `declaration` as a statement ID and leaves
  `init` at -1. These initializer forms are mutually exclusive.
- `body` is a statement ID: a block's first child, a control statement's body, a
  switch's first label, or a label's first child. `other` is an if's else branch.
- `next` links block/label-body siblings or switch labels. Empty case chaining
  and fallthrough structure are preserved, without executing dispatch.

Nodes have an integer `kind` tag and the associated opening/keyword token's
start/length/line/column; expression statements refer to their first token.
These are not whole-statement spans. All absent links are -1. Diagnostics carry
the statement error plus underlying expression/lexer errors where applicable;
the first detected error is preserved. All these interfaces remain internal,
with no serialized statement or AST format.

### Local declarations

The existing Stage 0 declaration grammar is recognized: an optional `const`, a
primitive or qualified named type, one variable name, and either `= expression;`
for scalars or `[expression];` for arrays. Scalars require an initializer; array
initializers, empty array lengths, multidimensional arrays and comma-separated
declarators are rejected syntactically. `int(...)`/`byte(...)` remain conversion
expressions, while a qualified name followed by another identifier is a named-type
declaration. This disambiguation is one-pass: no source rewind or decoder snapshot
is needed.

A `Declaration` node keeps the original fields and additionally records:

- `declared_type`: an integer tag in `type_kind` (`Int`, `Bool`, `Byte`, `String`,
  `Void`, `Auto` or `Named`; `Invalid` on non-declaration nodes).
- `type_name`: an expression-arena `Name` chain for a named type, otherwise -1.
- `name_start`/`name_length`: the variable identifier's raw source span.
- `immutable`: whether `const` was written.
- `expression`: the scalar initializer, or -1 for an array.
- `array`: the length expression, or -1 for a scalar.

Its associated token is the leading `const` or type token. Non-declaration nodes
have zero name metadata, false `immutable`, and absent `type_name`/`array` links.
The `declaration` link is only used by a `For` node. Type references and array
lengths also consume expression-arena nodes and participate in whole-parse rollback.

Types, inference, visibility, duplicate bindings, constant array lengths, element
restrictions and readonly writes are **not checked**. For example,
`void value=1;` and `int items[true];` are syntactically accepted here but are not
valid typed Stage 0 programs. The driver does not allocate or initialize input
arrays, run initializers, or execute loop bodies.

Internal prefix operations `parse_name()`, `parse_from_name()` and
`parse_from_conversion()` let the statement parser distinguish declarations from
expressions without losing postfix/binary operators. Captured starting tokens
preserve the original location when the shared syntax-depth limit is exceeded.
These are provisional compiler-internal operations, not standard-library APIs.

## Current module/import header contract

`headers.l` uses the shared expression cursor, but allocates only header nodes:

- `parse_prefix()` rewinds the loaded source, resets the header and expression
  arenas/cursor, and parses one module declaration followed by consecutive imports.
  It leaves the first non-import body token in `expressions::current()`. This is a
  handoff boundary, **not validation of the remaining body**. The one-token
  lookahead can detect a lexical error at that boundary; later body errors are not
  scanned. Subsequent expression parsing does not change the header arena.
- `parse()` uses the same prefix parser but additionally requires EOF. A repeated
  module declaration at the header boundary is rejected by both entry points.
- On failure, both the header and expression arenas are hidden. `diagnostic()`
  preserves the first detected error's raw span, line/column and lexer error kind.
  Repeating either parse entry point replays the source and resets diagnostics.
- `node_count()` and `node(id)` expose successful nodes. Invalid IDs produce an
  `Invalid` node with zero metadata and absent (-1) links. IDs expire at the next
  header parse or source replacement; they are not generation-checked handles.

The separate **2048-node header arena** stores `Module`, `Import`, `Selection`
and `Name` integer tags in `kind`. Each `Node` has start/length/line/column metadata
and four links (`path`, `alias`, `items`, `next`), all in that same arena:

- A `Module` root's `path` is a `Name` chain, and `items` is its first `Import`.
- An `Import`'s `path` is its dotted module-name chain; `alias` is the optional
  explicit alias `Name`; `items` is its first selective `Selection` or -1.
- A `Selection`'s `path` is its `::`-qualified name chain; `alias` is an explicit
  rename or -1. With no rename, the eventual binding is the path's final segment;
  the parser does not synthesize a second name node.
- `Name.next` links path components. `Import.next` and `Selection.next` link their
  respective sibling lists. Other links are absent. The token metadata belongs
  to `module`/`import`, the selection's first identifier, or each name segment;
  spans are not whole-declaration spans. Names refer to the original source bytes.

All path/list parsing is iterative, without recursive syntax-depth growth. Node
exhaustion is a seed resource diagnostic, not a language restriction. No header
AST format or new standard-library API is introduced.

There is no package/file lookup, canonical-path checking, dependency graph, alias
uniqueness, selective-binding resolution, visibility checking or cycle detection.
Duplicate/conflicting imports remain syntax-valid here. Header-only parsing does
not check import placement inside or after an unparsed top-level body. These
semantic and whole-file responsibilities still belong to Stage 0; this slice does
not claim a complete implementation of the module system.

## Limits and verification

The **65535-byte total input limit is this Stage 1 seed's buffer profile**, not a
new language rule or a Stage 0 source-file limit. It also bounds decoded strings:
quotes and escapes consume input capacity. The existing VM still enforces its
10-million-instruction, 256-call-depth and 128-MiB working-memory limits; satisfying
the input-size bound does not disable those limits.

The expression arena permits **2048 nodes**, the statement arena **1024 nodes**,
and both parsers share **48 active syntax parses**. These are separate arena and
recursion budgets, not language rules or the VM's stack limit. A standalone bare
literal uses one parse level, so 47 nested grouping pairs or prefix operators fit.
A bare expression statement uses an additional statement level. A block counts
as a statement node/level; 47 nested blocks around an empty statement fit, and a
flat block can contain 1023 empty children. Exhaustion reports a normal diagnostic
before an out-of-bounds access or VM call-depth trap. Argument links reuse nodes;
the retained text pool cannot exceed the raw input's byte bound.

`tests/stage1.mjs` uses regex spans, BigInt decimal values and independently derived
positions as its successful-input model. Explicit malformed cases check error
categories and detection spans. Generated L assertions run through both direct
source execution and serialized bytecode, including replay, sticky EOF/errors and
loading a new source after failure. The corpus includes every input byte in plain,
quoted, line-comment and block-comment contexts, keyword near misses, deterministic
mixed-token models and repository sources (including the lexer itself).

`tests/stage1-expressions.mjs` checks every pair of binary precedences with an
independent shunting-yard model, then tests generated trees with explicitly marked
source spans. Assertions check all node fields, unique/reachable arena IDs,
argument/name links, retained decoded bytes, diagnostics, replay and recovery.
Exact arena/depth boundaries and their first rejected cases are exercised. Input
expressions are **parsed, never evaluated** by this test suite.

`tests/stage1-statements.mjs` generates control-flow trees before emitting syntax,
then checks all statement fields and all referenced expression fields, unique
reachable IDs in both arenas, copied strings, dangling-else binding, switch
fallthrough and optional for headers. It checks first-error diagnostics, replay,
recovery, shared-depth limits and both arena boundaries through source and
serialized execution. Declaration models check primitive/named types, exact name
spans, qualifiers, scalar/array forms, for-initializer links and prefix ambiguity.
Generated corpora assert coverage of all declared-type and expression-leaf kinds.
Large success and failure fixtures are isolated to avoid exhausting the VM budget
through test batching. Existing expression-only tests remain unchanged in meaning.

`tests/stage1-headers.mjs` emits headers from independent trees, checks every field
and unique/reachable node, and asserts generated coverage of every node/import
form. It checks exact spans with comments/newlines, alias/default-binding forms,
replay, failure rollback, shared-cursor handoff, repository-source prefixes and
the exact path/import/selection/alias arena boundaries through source and bytecode
execution. The header driver also rejects actual top-level bodies and checks input
capacity and diagnostics. Parsing imports never loads files or evaluates input.

Driver tests cover diagnostics, maximum-size input and overflow. All suites run
under `make test`, `make sanitize`, `make coverage` and the Nix checks. The existing
**100% line/function/branch gate applies to Stage 0 C code only**; there is not yet
a coverage gate for L source. No arbitrary mutant bytecode or cyclic verifier
graphs are executed by these tests.
