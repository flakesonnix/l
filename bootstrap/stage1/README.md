# Stage 1: L-written lexer

This is the first L-written implementation slice. Stage 0 compiles it to existing
**1.9 bytecode**, and the Stage 0 VM executes it. There is no L-written parser,
semantic checker, code generator or complete compiler yet. Running a lexer over
its own source is **not self-hosting**.

## Build and run

From the repository root:

```sh
make
make stage1
./build/l run build/stage1-lexer.lbc < examples/answer.l
./build/l run build/stage1-lexer.lbc < bootstrap/stage1/lexer.l
node tests/stage1.mjs ./build/l
```

Alternatively run the driver directly from source:

```sh
./build/l run bootstrap/stage1/main.l \
  --manifest bootstrap/stage1/package.json < examples/answer.l
```

The driver reads raw stdin bytes. Success produces no output and exits 0. A lexical
error produces a diagnostic on stderr and exits 65; input overflow also exits 65.
Reported stream errors retain the VM's trap behavior (70). It validates tokens
only: input such as `module missing; return` intentionally succeeds. It does not
resolve the input's modules or check its entry point, grammar or types.

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

## Limits and verification

The **65535-byte total input limit is this Stage 1 seed's buffer profile**, not a
new language rule or a Stage 0 source-file limit. It also bounds decoded strings:
quotes and escapes consume input capacity. The existing VM still enforces its
10-million-instruction, 256-call-depth and 128-MiB working-memory limits; satisfying
the input-size bound does not disable those limits.

`tests/stage1.mjs` uses regex spans, BigInt decimal values and independently derived
positions as its successful-input model. Explicit malformed cases check error
categories and detection spans. Generated L assertions run through both direct
source execution and serialized bytecode, including replay, sticky EOF/errors and
loading a new source after failure. The corpus includes every input byte in plain,
quoted, line-comment and block-comment contexts, keyword near misses, deterministic
mixed-token models and repository sources (including the lexer itself).

Driver tests cover diagnostics, maximum-size input and overflow. These tests run
under `make test`, `make sanitize`, `make coverage` and the Nix checks. The existing
**100% line/function/branch gate applies to Stage 0 C code only**; there is not yet
a coverage gate for L source. No arbitrary mutant bytecode or cyclic verifier
graphs are executed by these tests.
