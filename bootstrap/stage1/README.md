# Stage 1: L-written lexer and expression parser

These are the first L-written implementation slices. Stage 0 compiles them to
existing **1.9 bytecode**, and the Stage 0 VM executes them. There is no L-written
statement/module parser, semantic checker, code generator or complete compiler
yet. Running a lexer over its own source is **not self-hosting**.

## Build and run

From the repository root:

```sh
make
make stage1
./build/l run build/stage1-lexer.lbc < examples/answer.l
./build/l run build/stage1-lexer.lbc < bootstrap/stage1/lexer.l
printf 'a = f(1, 2) + -3' | ./build/l run build/stage1-expression.lbc
node tests/stage1.mjs ./build/l
node tests/stage1-expressions.mjs ./build/l
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
Signs are separate tokens. A future parser must decide where that boundary
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
  at the next parse or source replacement; they are not generation-checked handles.

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

## Limits and verification

The **65535-byte total input limit is this Stage 1 seed's buffer profile**, not a
new language rule or a Stage 0 source-file limit. It also bounds decoded strings:
quotes and escapes consume input capacity. The existing VM still enforces its
10-million-instruction, 256-call-depth and 128-MiB working-memory limits; satisfying
the input-size bound does not disable those limits.

The parser additionally permits **2048 AST nodes** and **48 active expression
parses**. These are separate arena and recursion budgets, not language rules or
the VM's stack limit. A bare literal uses one parse level, so 47 nested grouping
pairs or prefix operators fit. Exhaustion reports a normal diagnostic before an
out-of-bounds access or VM call-depth trap. Argument links reuse existing nodes;
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

Driver tests cover diagnostics, maximum-size input and overflow. Both suites run
under `make test`, `make sanitize`, `make coverage` and the Nix checks. The existing
**100% line/function/branch gate applies to Stage 0 C code only**; there is not yet
a coverage gate for L source. No arbitrary mutant bytecode or cyclic verifier
graphs are executed by these tests.
