# Language L — Stage 0

C11 bootstrap for the first end-to-end slice of the L 0.1.0 specification.
**Not yet L 0.1 conformant, and not yet a complete L-Core implementation.**
No LLVM or external library dependencies.

```sh
make
./build/l check examples/answer.l --manifest examples/package.json
./build/l run examples/answer.l --manifest examples/package.json  # Exit code 42
./build/l compile examples/answer.l --manifest examples/package.json -o build/answer.lbc
./build/l run build/answer.lbc                   # Exit code 42
./build/l inspect build/answer.lbc
./build/l run examples/modules.l --manifest examples/package.json
./build/l run examples/constants.l --manifest examples/package.json
./build/l run examples/static_demo.l --manifest examples/package.json
make test                                      # Requires Node.js 22+
make fuzz                                      # Deterministic mutation/model tests
make sanitize
make coverage                                  # Requires GCC/gcov and Node.js 22+
```

## Supported subset

- ASCII identifiers, decimal literals, `//` and `/* … */` comments.
- Mandatory `module a.b;`, one file per module, explicitly configured source roots.
- Module imports, aliases, selective imports, private-by-default functions and
  explicit `pub` exports; qualification uses `::`, not `.`.
- Nested/reopened namespaces and statically resolved `int`/`bool` function overloads.
- Module/namespace `const int` and `const bool` declarations, compile-time checked
  initializers, forward references and normal import/visibility rules.
- Module/namespace `static int` and `static bool` storage, with compile-time
  initializers and shared runtime values across calls, recursion and imports.
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
require explicit types. Entry point: module-scope `int main()` in the entry file.
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
Switch dispatch uses a case-entry table with `switch`/`trap` opcodes.

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

Not implemented yet: other primitive types,
strings/IO, structs/enums, pointers/slices, ownership/borrows, generics/concepts,
dynamic values, GC, classes, effects, native/LLVM, self-hosting and build/package
management. The repository does not imply these subsystems have been implemented.

## Modules and manifests

Module behavior follows [the normative module-system specification 0.1.1](spec/module-system-v0.1.1.md)
for the currently implemented declaration and type subset. This does not add
structs, classes, enums, type aliases, aggregate globals, generic constraints or
runtime overload resolution. Public signatures currently contain
only public primitives.

Every source command requires an explicit `--manifest FILE.json`. No manifest,
module directory, standard library or dependency is implicitly searched for.
Manifest version 1 has exactly these required fields:

```json
{
  "version": 1,
  "package": "my_application",
  "module_roots": [
    {"package": "my_application", "prefix": "app", "path": "src/app"},
    {"package": "standard_library", "prefix": "std", "path": "deps/std"}
  ],
  "dependencies": [
    {"from": "my_application", "to": "standard_library"}
  ]
}
```

Root paths resolve relative to the manifest's canonical directory; absolute root
paths are also accepted. `app.main` maps to `src/app/main.l`. An explicitly
registered empty prefix maps the entire dotted module path beneath its root.
A prefix by itself has no implicit `index.l` module. Package identities use ASCII
letters/underscores initially, then letters, digits, underscores or hyphens.
Unknown/duplicate keys, invalid UTF-8/Unicode escapes and unregistered dependency
packages are errors. JSON strings support standard escapes, including surrogate
pairs. The seed permits 256 root registrations and 1024 dependency registrations.

Resolution uses the longest matching prefix; equally matching registrations are
ambiguous. Imports across packages require a direct declared dependency, not just
a transitive one. Source locations must be canonical and declarations must match
their root-relative module paths; source-file symlinks cannot alias module
identities. Reachable units are registered before dependency-cycle detection and
processed in dependency order. Diagnostics include the complete cycle path.
The seed permits 256 reachable modules, 1024 imports per module, 256 functions and
1024 module constants plus 1024 scalar static globals across the linked program. Filesystem
discovery/resolution, graph ordering and declaration lookup are separate compiler
operations. The current filesystem implementation uses POSIX `realpath` and
`access`.

```c
module app.main;
import std.math as math;
import std.math::{numbers::answer as answer};

int main() {
    return math::numbers::answer(10) + answer(true) - 20;
}
```

Module imports expose qualified declarations only. Aliases are module-local;
selective imports bind public constants, static globals, function names or overload groups.
Redundant module imports warn; conflicting aliases/bindings fail. Lexical bindings,
enclosing namespaces and module declarations precede selective imports in lookup. Failed
qualified lookup never falls back to an unqualified name. Namespace reopening
does not change declaration visibility; private helpers/constants/static globals remain
module-private.
Wildcard imports, re-exports, import cycles and executable module initialization
are rejected. Dependencies do not supply a hidden entry point: imported functions
named `main` are ordinary functions. Bytecode requires no manifest. Artifact
version **1.3** rejects older versions, including **1.2**; recompile from source.

### Compile-time constants

```c
module app.values;

const int base = 40;
namespace numbers {
    pub const int answer = base + increment;
    const int increment = 2;
    pub const bool ready = answer == 42;
}
```

Module constants require explicit `int` or `bool` types and scalar initializers.
Their initializer syntax permits literals, constant references, and the supported
unary/binary operators. Function calls, assignments, postfix updates and indexing
are rejected, including in unevaluated operands. All operands are name/type
checked; evaluation honors short-circuiting and skips unevaluated operands.
Forward references work, and evaluated constant-dependency cycles report their
complete qualified-name path. Compilation also rejects overflow, division by zero,
and `INT32_MIN / -1` or `% -1`, even in unused constant declarations.

Imports, aliases, namespace lookup, private-by-default visibility and `pub` work
as for functions. Locals/parameters may shadow constant names; module constants
cannot be assigned or incremented. Constant values are inlined, without runtime
storage or initialization instructions. Local `const`
declarations keep their existing runtime-initializer behavior. Array lengths and
case labels still require literals. Compile-time evaluation uses the existing
256-level nesting limit.

### Mutable static storage

```c
module app.counter;

const int initial = 40;
static int count = initial;
pub static bool enabled = true;

pub int next() {
    return count++;
}
```

`static` declarations are scalar, module/namespace-scoped bindings with explicit
`int`/`bool` types and required compile-time initializers. Initializers follow the
constant-expression rules above: literals, constant references and checked pure
operators only. They cannot read mutable static storage, call functions, assign,
update or index anything, even in unevaluated operands. Unused declarations are
checked too. Initial values are stored as data; no module initialization function
or arbitrary code runs before `main`.

Each VM execution initializes its own static cells once before the entry call.
Cells are shared by all functions, recursive calls, namespaces and importing
modules in that execution. Separate executions of the same `Program` start fresh;
executing it does not mutate the IR initializer table. Runtime assignment and
postfix updates preserve left-to-right evaluation and checked-overflow behavior.
`pub` permits cross-module reads and writes; private cells remain module-private.
Aliases/selective imports refer to the same cell, not copies. Locals/parameters
may shadow static names. Function-local statics, static functions, global arrays
and implicit mutable module variables are not supported by this seed.

## Pipeline and artifacts

Manifest → source-module discovery/registration → import resolution → cycle
detection/dependency ordering → namespace/visibility/name resolution/type checking
→ typed SSA register IR with explicit
local storage slots and a scalar global-data table → verification → bytecode → VM.
The seed does not materialize separate HIR, Typed IR and MIR representations yet.
The implemented subset has no ownership model yet.

IR and bytecode are versioned independently, currently both **1.3**.
Bytecode 1.1 added a 32-bit length per slot (0 for scalars), `bounds_check` and
`clear`; 1.2 added a per-function `switch` case-entry table and the `switch`/`trap`
opcodes. Version 1.3 adds a global-data table and `global.load`/`global.store`.
The loader accepts only the exact format version; recompile older
artifacts from source. The verifier checks instruction types, jump targets, unique
register definitions, dominance, slot initialization, array metadata, addressing
modes, switch targets, duplicate case values, call signatures and returns. It also
checks global counts/indices, scalar types, canonical boolean initializers and
load/store register types. Global stores require dominating source definitions;
global loads define SSA registers and need no local-slot initialization proof. Index
register definitions must also dominate their uses; element accesses require an
initialized array. Loaded bytecode is fully verified before execution.
The `switch` operands are `a` = selector register, `b` = table offset, `c` = entry
count and `dst` = fallback PC. A low-level `dst == L_NONE` traps on an unmatched
value; source switches without `default` instead continue after the switch.
The `trap` opcode terminates execution with a defined VM trap.
The VM additionally checks bounds at each element access, so manipulated bytecode
cannot bypass safety by omitting a preceding `bounds_check`.
`inspect` displays the IR, not an ABI-stable text representation.

The 1.3 header is magic (4 bytes), major/minor (2 bytes each), function count,
entry function index and global count (4 bytes each). Global entries precede
functions: name length (4 bytes), name bytes, scalar type (1 byte), initial signed
32-bit value (4 bytes). Integers use little-endian encoding; negative initializers
use their 32-bit bit patterns. `global.load` uses `dst` = destination register and
`a` = global index; `global.store` uses `dst` = global index and `a` = value
register. Constant-only programs have an empty global table.

Artifacts contain no timestamps or absolute source paths. Identical source
dependency closures and package identities produce identical bytecode after
relocation or source-root registration reordering. This is **not yet a
hermetic build system** or stage-2/3 bootstrap verification.

CLI exit codes: program result modulo 256, usage `64`, compilation/format errors
`65`, VM trap `70`, startup allocation failure `71`, file errors `74`.
Program results can overlap these codes; diagnostics are written to stderr.

## Tests

`make test` checks the frontend, source and serialized-bytecode execution, IR
roundtrips, reproducible output and defined failures.
Module tests exercise manifest validation, aliases, overloads, visibility, cycle
paths, limits, imported-source diagnostics, root ordering, relocation and changes
of working directory. They include 32 fixed-seed dependency DAGs (`0x4d4f4455`)
whose source and bytecode results are checked against independent host-side sums.
Constant tests compare 927 scalar expression cases against a host-side BigInt
oracle and exercise 32 constant-import DAGs (seed `0x434f4e53`), visibility,
forward references, cycles, short-circuiting, inlining, limits and defined errors.
Static tests cover shared state, visibility, initialization, recursion, aliasing,
evaluation order, signed/boolean metadata, limits, traps and version rejection.
The fuzz suite adds 128 independent shared-state models, runs each source and
bytecode program twice, and tests global-store dominance in generated verifier
graphs. Arbitrary bytecode mutants and potentially cyclic verifier graphs are
still verified, not executed.
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
