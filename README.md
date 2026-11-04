# Language L — Stage 0

C11 bootstrap for the first end-to-end slice of the L 0.1.0 specification.
**Not yet L 0.1 conformant, and not yet a complete L-Core implementation.**
No LLVM or external library dependencies.

```sh
make
./build/l check examples/answer.l
./build/l run examples/answer.l                  # Exit code 42
./build/l compile examples/answer.l -o build/answer.lbc
./build/l run build/answer.lbc                   # Exit code 42
./build/l inspect build/answer.lbc
make test
make fuzz                                      # Deterministic mutation/model tests
make sanitize
make coverage                                  # Requires GCC/gcov and Node.js 22+
```

## Supported subset

- ASCII identifiers, decimal literals, `//` and `/* … */` comments.
- Optional `module a.b;` identity, one source file per program.
- `int` (exactly 32 bits), `bool`, `void` functions, local inference with `auto`.
- Initialized local variables, `const`, lexical scopes and shadowing.
- Fixed local `int`/`bool` arrays: `int values[10];`, indexing and element
  assignment with runtime bounds checks.
- Direct calls, forward function references, recursion and value parameters.
- Blocks, `if`/`else`, `while`, `for`, `return`, empty statements.
- C-style `switch` over `int` with `case`/`default` labels, empty-case chaining
  and fallthrough; unmatched selectors without `default` continue past the switch.
- `break` and `continue` targeting the innermost loop or switch (`continue`
  binds to the innermost loop only).
- `=`, postfix `++`/`--`, unary `+`/`-`/`!`, `+ - * / %`, comparisons,
  short-circuit `&&`/`||` and C operator precedence.

No implicit conversions between `int` and `bool`. Conditions must be `bool`.
Scalar local declarations require initializers; parameters and function returns
require explicit types. Entry point: `int main()`.
Non-`void` functions must structurally return on all paths; a loop alone is not
yet considered proof of a return. Operands and arguments evaluate left to right.

`break` exits the innermost `while`/`for` loop or `switch`. `continue` rechecks
a `while` condition; in a `for` loop it executes the step expression first; inside
a `switch` it targets the enclosing loop. Both statements require a semicolon and
are compilation errors without a matching enclosing construct (`break` needs a
loop or switch, `continue` needs a loop). Unreachable source is still type-checked.
Case labels are decimal integer literals, optionally preceded by `-`; duplicate
case values and duplicate `default` labels are compilation errors. Cases share
one switch scope; use explicit blocks for separate case scopes. Dispatch that
skips a scalar or array initializer cannot read an uninitialized scalar or access
an uninitialized array. Assignment before reading a scalar is allowed. The seed
allows at most 1024 labels per switch and 1024 non-default table entries per
function. A non-void function proves its return through a switch only when every
case group returns and a `default` exists.
Switch dispatch uses a case-entry table with `switch`/`trap` opcodes; bytecode is 1.2.

Arrays initialize to `0` or `false` each time their declaration executes.
Lengths must be decimal literals from 1 to 65535, with at most 65536 array elements
per function. Index expressions must be `int`. Negative indexes and indexes at or
above the array length produce a defined trap. Element assignment evaluates and
checks the index exactly once, before evaluating the right-hand side. `const`
arrays prohibit element mutation. Initializer lists, array parameters/returns,
whole-array assignment and multidimensional arrays are not supported yet.

Overflow, division/remainder by zero, and `INT32_MIN / -1` or `% -1` produce
defined traps without C overflow UB. The VM limits execution to 10 million
instructions, call depth to 256 and managed working memory to 128 MiB.
These are seed-profile limits, not general L language limits.

Not implemented yet: imports/module resolution, other primitive types,
strings/IO, structs/enums, pointers/slices, ownership/borrows, generics/concepts,
dynamic values, GC, classes, effects, native/LLVM, self-hosting and build/package
management. The repository does not imply these subsystems have been implemented.

## Pipeline and artifacts

Lexer → AST → name resolution/type checking → typed SSA register IR with explicit
local storage slots → verification → bytecode → VM.
The seed does not materialize separate HIR, Typed IR and MIR representations yet.
The implemented subset has no ownership model yet.

IR and bytecode are versioned independently, currently both **1.2**.
Bytecode 1.1 added a 32-bit length per slot (0 for scalars), `bounds_check` and
`clear`; 1.2 adds a per-function `switch` case-entry table and the `switch`/`trap`
opcodes. The loader accepts only the exact format version; recompile older
artifacts from source. The verifier checks instruction types, jump targets, unique
register definitions, dominance, slot initialization, array metadata, addressing
modes, switch targets, duplicate case values, call signatures and returns. Index
register definitions must also dominate their uses; element accesses require an
initialized array. Loaded bytecode is fully verified before execution.
The `switch` operands are `a` = selector register, `b` = table offset, `c` = entry
count and `dst` = fallback PC. A low-level `dst == L_NONE` traps on an unmatched
value; source switches without `default` instead continue after the switch.
The `trap` opcode terminates execution with a defined VM trap.
The VM additionally checks bounds at each element access, so manipulated bytecode
cannot bypass safety by omitting a preceding `bounds_check`.
`inspect` displays the IR, not an ABI-stable text representation.

Artifacts contain no timestamps or absolute source paths. Identical source files
produce identical bytecode regardless of the input path. This is **not yet a
hermetic build system** or stage-2/3 bootstrap verification.

CLI exit codes: program result modulo 256, usage `64`, compilation/format errors
`65`, VM trap `70`, startup allocation failure `71`, file errors `74`.
Program results can overlap these codes; diagnostics are written to stderr.

## Tests

`make test` checks the frontend, source and serialized-bytecode execution, IR
roundtrips, reproducible output and defined failures.
It also runs `make fuzz`: a fixed-seed bytecode mutation corpus plus generated
array, switch and expression programs checked against independent host-side
models. Mutations include truncation, bit/word replacement, insertion, deletion,
splicing and random data.
The semantic tests compare full 32-bit results before and after serialization and
check signed index boundaries for integer/boolean array reads and writes. Switch
models check signed boundary labels, default placement, unmatched selectors,
fallthrough, returns, nested breaks/continues and single selector evaluation.
Expression models check full-width arithmetic, overflow and division traps,
short-circuit side effects, assignments, postfix updates and nested call arguments.
Generated control-flow graphs are checked against a separate path-state model for
register dominance and scalar/array initialization, both directly and after
serialization. These graphs may contain loops and are verified, never executed.
The seed is `0x4c313146`; diagnostics and generated sources are in `build/fuzz.log`.
Arbitrary bytecode mutants are parsed and verified, not executed, because they
may contain nonterminating loops. VM executions use bounded generated programs
with known expected values or traps. This is bounded, deterministic mutation and
model-based testing, not an exhaustive or coverage-guided fuzzing campaign.
`make sanitize` builds and tests with AddressSanitizer and UndefinedBehaviorSanitizer.
`make coverage` measures all stage-0 C files without source exclusions and fails
below 100% line, function **or branch coverage**. It also runs fault-injection,
verifier and bytecode-mutation tests. The report is `build/coverage/report.json`.
100% coverage does not establish correctness or full language conformance.
