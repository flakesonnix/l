# Language L — Stage 0

C11 bootstrap for the first end-to-end slice of the L 0.1.0 specification.
**Not yet L 0.1 conformant, and not yet a complete L-Core implementation.**
No LLVM or external library dependencies.

Build, Nix and CI instructions: [development guide](docs/DEVELOPMENT.md).
GitHub review order and merge instructions: [review guide](docs/REVIEWING.md).

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
./build/l run examples/alias_demo.l --manifest examples/package.json
./build/l run examples/constant_shapes.l --manifest examples/package.json
./build/l run examples/struct_demo.l --manifest examples/package.json
./build/l run examples/enum_demo.l --manifest examples/package.json
./build/l run examples/byte_demo.l --manifest examples/package.json
./build/l run examples/string_demo.l --manifest examples/package.json
printf 'hello\n' | ./build/l run examples/io_demo.l --manifest examples/package.json
printf 'hello' | ./build/l run examples/static_buffers.l --manifest examples/package.json
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
- Nested/reopened namespaces and statically resolved function overloads.
- Transparent module/namespace scalar type aliases: `using Count = int;`, with
  forward references, imports, visibility checks and cycle diagnostics.
- Nominal, nonempty scalar-field structs, positional literals, field reads/writes,
  copying and by-value function parameters/returns. Fields are public by default.
- Scoped nominal enums, checked explicit/implicit values, enum constants/statics,
  struct fields, value parameters/returns, equality and same-enum switches.
- Module/namespace `const` declarations with `int`, `bool`, `byte`, `string` or enum types,
  checked initializers, forward references and normal import/visibility rules.
- Module/namespace `static` storage with `int`, `bool`, `byte`, `string` or enum types,
  compile-time initializers and shared runtime values across calls and imports.
- Zero-initialized module/namespace `static int`/`bool`/`byte` arrays with checked
  element access and shared storage across calls and imports.
- `int` (exactly 32 bits), `bool`, `void` functions, local inference with `auto`.
- `byte` (0..255), explicit checked `byte(intExpr)` narrowing and lossless
  `int(byteExpr)` widening, including in compile-time expressions.
- Immutable literal-backed `string` values, bytewise equality, integer `.length`
  and checked indexing returning `byte`, including in compile-time expressions.
- Explicitly imported `std.io` byte input, byte/string stdout and string stderr,
  backed by four fixed `pub extern` VM intrinsics.
- Initialized local variables, `const`, lexical scopes and shadowing.
- Fixed local `int`/`bool`/`byte` arrays: `int values[10];`, indexing and element
  assignment with runtime bounds checks; lengths may be compile-time expressions.
- Direct calls, forward function references, recursion and value parameters.
- Blocks, `if`/`else`, `while`, `for`, `return`, empty statements.
- C-style `switch` over `int`, `byte` or an enum with `case`/`default` labels,
  empty-case chaining and fallthrough; unmatched selectors without `default`
  continue past the switch.
- `break` and `continue` targeting the innermost loop or switch (`continue`
  binds to the innermost loop only).
- `=`, postfix `++`/`--`, unary `+`/`-`/`!`, `+ - * / %`, comparisons,
  short-circuit `&&`/`||` and C operator precedence.

No implicit conversions between `int`, `bool`, `byte`, `string` or nominal enums.
Conditions must be `bool`.
Scalar local declarations require initializers; parameters and function returns
require explicit types. Entry point: module-scope `int main()` in the entry file.
Non-`void` functions must structurally return on all paths; a loop alone is not
yet considered proof of a return. Operands and arguments evaluate left to right.

`break` exits the innermost `while`/`for` loop or `switch`. `continue` rechecks
a `while` condition; in a `for` loop it executes the step expression first; inside
a `switch` it targets the enclosing loop. Both statements require a semicolon and
are compilation errors without a matching enclosing construct (`break` needs a
loop or switch, `continue` needs a loop). Unreachable source is still type-checked.
Case labels are checked compile-time expressions of the selector's type; duplicate folded case
values and duplicate `default` labels are compilation errors. Cases share
one switch scope; use explicit blocks for separate case scopes. Dispatch that
skips a scalar or array initializer cannot read an uninitialized scalar or access
an uninitialized array. Assignment before reading a scalar is allowed. The seed
allows at most 1024 labels per switch and 1024 non-default table entries per
function. A non-void function proves its return through a switch only when every
case group returns and a `default` exists.
Switch dispatch uses a case-entry table with `switch`/`trap` opcodes.

Arrays initialize to `0`, `false` or `byte(0)` each time their declaration executes.
Lengths must be compile-time `int` expressions from 1 to 65535, with at most 65536
array elements per function. Index expressions must be `int`. Negative indexes and indexes at or
above the array length produce a defined trap. Element assignment evaluates and
checks the index exactly once, before evaluating the right-hand side. `const`
arrays prohibit element mutation. Initializer lists, array parameters/returns,
whole-array assignment and multidimensional arrays are not supported yet.

Overflow, division/remainder by zero, and `INT32_MIN / -1` or `% -1` produce
defined traps without C overflow UB. The VM limits execution to 10 million
instructions, call depth to 256 and managed working memory to 128 MiB.
These are seed-profile limits, not general L language limits.

Not implemented yet: other primitive types,
dynamic strings, file/network I/O, nested/array-field structs, pointers/slices, ownership/borrows,
generics/concepts, dynamic values, GC, classes, effects, native/LLVM, self-hosting and build/package
management. The repository does not imply these subsystems have been implemented.

## Modules and manifests

Module behavior follows [the normative module-system specification 0.1.1](spec/module-system-v0.1.1.md)
for the currently implemented declaration and type subset. This does not add
classes, aggregate globals, generic constraints or runtime overload
resolution. Public function signatures may contain public primitives and public
struct/enum types, but must not expose private nominal types. Public constants,
statics and struct fields must also expose only publicly accessible types.

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
The seed permits 256 reachable modules, 1024 imports per module, 256 functions,
1024 module constants, 1024 static declarations and 1024 type aliases across the
linked program, plus 256 structs with 1..64 scalar fields each and 256 enums with
1..1024 members each. Enum members do not consume module-constant slots. Filesystem
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

Module imports expose qualified declarations only. Import aliases are module-local;
selective imports bind public structs, enums/members, type aliases, constants, static globals,
function names or overload groups.
Redundant module imports warn; conflicting aliases/bindings fail. Lexical bindings,
enclosing namespaces and module declarations precede selective imports in lookup. Failed
qualified lookup never falls back to an unqualified name. Namespace reopening
does not change declaration visibility; private helpers, constants, static globals
and type aliases remain module-private.
Wildcard imports, re-exports, import cycles and executable module initialization
are rejected. Dependencies do not supply a hidden entry point: imported functions
named `main` are ordinary functions. Bytecode requires no manifest. Artifact
version **1.9** rejects older versions, including **1.8**; recompile from source.
No new keywords are introduced by static arrays (`extern` remains reserved).

`compile -o` rejects an existing output that aliases the manifest or any source in
the reachable module graph, including relative-path variants, symlinks and hard
links. Rejected aliases return usage status `64` without truncating inputs;
file-identity inspection failures return `74`. These are preflight checks, not an
atomic-write or concurrent-filesystem-mutation guarantee.

### Scalar type aliases

```c
module app.types;

using InternalCount = int;
pub using Count = InternalCount;
namespace flags {
    pub using Enabled = bool;
}
```

`using Name = Type;` declares a transparent alias at module or namespace scope.
The target must resolve to `int`, `bool`, `byte` or `string`, directly or through
other aliases.
Forward references and namespace reopening work; every alias is checked, including
unused declarations. Alias cycles report the complete qualified-name path, and
resolution uses the existing 256-level nesting limit.

Alias names follow ordinary lookup, private-by-default visibility, `pub`, module
aliases and selective-import rules. They share the declaration namespace with
functions, constants, static storage and namespaces; duplicate names are errors.
Locals and parameters can shadow alias names, including in later parameter types.
Failed qualified lookup never falls back to another type of the same name.

Aliases may appear in function results/parameters, local scalar/array types and
module constant/static types. They are not new nominal types: overload matching
uses the underlying primitive, and `f(Count)` conflicts with `f(int)` when `Count`
aliases `int`. Private alias names may be used in public function signatures
because the resolved signature exposes only public primitives, not the alias.
Aliases cannot be called, used as values or used as casts.

Local aliases, `using namespace`, generic aliases, aliases to `void`/`auto`, and
array/function aliases are not supported. `using` is now a reserved keyword.
Aliases disappear before IR lowering and add no runtime objects or bytecode
metadata. The current IR/bytecode version is **1.9**; the exact-version policy is
unchanged.

### Byte values and conversions

```c
module app.bytes;

using Octet = byte;
const Octet initial = byte(20);
static byte current = initial;

byte add(byte a, byte b) {
    return byte(int(a) + int(b));
}

int main() {
    byte data[2];
    data[0] = current;
    data[1] = byte(22);
    current = add(data[0], data[1]);
    switch (current) {
        case byte(42): return int(current);
        default: return 0;
    }
}
```

`byte` is a distinct scalar type with values 0..255. It works in locals, `auto`,
`const`, module constants/statics, transparent aliases, struct fields, parameters,
returns, overloads, equality and same-byte switches. `byte` is a reserved keyword.
Decimal literals still have type `int`; initializing a byte requires a byte value.

`byte(intExpr)` evaluates its operand once and traps if the result is outside
0..255; it never truncates or wraps. `int(byteExpr)` widens without loss. These
are the only conversions in this slice, each taking exactly one operand.
Same-type conversions, boolean/string/enum/struct conversions and calls through aliases
are rejected. Arithmetic, ordering and postfix updates require `int`; byte
arithmetic must explicitly widen operands and, when needed, narrow the result.
Assignments, field writes and call arguments preserve left-to-right evaluation.

Conversions are also pure constant expressions: evaluated out-of-range narrowing
is a compilation error in module initializers, lengths and labels. Evaluation
honors short-circuiting; all operands are still name/type checked. Runtime locals,
including local `const`, keep runtime conversion/trap behavior. Case labels must
have exactly the selector's type, so `case byte(42)` matches a byte selector while
`case 42` does not. Duplicate folded values remain errors.

Fixed byte arrays initialize to zero on each declaration, use integer lengths and
indices, and obey the same bounds, initialization and `const` rules as other
arrays. The existing limits count elements, not packed octets. Stage 0 currently
stores every byte value/array element in one 32-bit VM cell; it exposes no packed
memory layout. Character literals, slices and general lifetime rules remain
future language slices.

### Literal-backed strings

```c
module app.text;

using Text = string;
const Text payload = "\x14\x16\0";
const int size = payload.length;
static string current = payload;

string take() {
    string old = current;
    current = "";
    return old;
}

int main() {
    const Text saved = take();
    if (saved != payload || saved[size - 1] != byte(0)) return 1;
    return int(saved[0]) + int(saved[1]) + current.length;
}
```

`string` is an immutable sequence of bytes backed by literals with program
lifetime. Strings work in initialized locals, `auto`, local/module `const`,
statics, transparent aliases, scalar struct fields, overloads and by-value
parameters/returns. Mutable bindings and fields can be reassigned to another
string; existing copies retain their original contents. `const` prevents
reassignment, and string contents and `.length` are always read-only.

Double-quoted literals accept printable ASCII (0x20..0x7e), with quotes and
backslashes escaped. Supported escapes are `\n`, `\r`, `\t`, `\0`, `\\`, `\"`
and `\xNN`. Hex escapes consume exactly two hexadecimal digits, accepting either
case; a subsequent digit is an ordinary byte. Raw control/non-ASCII bytes,
multiline literals and other escapes are rejected. Empty strings, embedded NULs
and escaped bytes 0x80..0xff are valid. There is no implicit encoding conversion,
Unicode normalization or terminator in the logical string value.

`==` and `!=` compare lengths and all bytes, including bytes after NUL. `.length`
returns an `int` byte count. `text[index]` requires an `int` index and returns a
`byte`. It evaluates the string expression once, then the index once; negative
indices and indices at or beyond the length trap. An index expression that
reassigns the original string binding still indexes the previously evaluated
value. Temporary strings, returned strings and string-valued fields support the
same reads. Ordering, concatenation, string conversions, string switches, string
arrays, slices and dynamic allocation are not supported.

String literals/references, equality, `.length` and indexing are also pure
constant expressions. Evaluated out-of-bounds indices are compilation errors in
module initializers, array lengths, enum values and case labels. Short-circuit
evaluation skips bounds checks in unevaluated operands, but every operand is
still name/type checked. Mutable static reads, calls, assignment, updates and
ordinary array indexing remain forbidden in constant expressions. Locals,
parameters and local `const` remain runtime-only and shadow outer constants.

The seed permits 1024 distinct decoded strings, 65535 bytes per string and
1048576 total pooled bytes per linked program. Source literals are interned by
decoded content across modules, including literals in unused declarations and
unevaluated operands. Different spellings of equal bytes share storage. String
values occupy one opaque 32-bit pool-index cell; no address or index is exposed
to L code. Literal storage remains valid for the lifetime of its `Program` and
survives individual VM executions and trap cleanup.

### Standard stream I/O

`stdlib/io.l` declares the complete intrinsic interface:

```c
module std.io;

pub extern int read_byte();
pub extern void write_byte(byte value);
pub extern void write_string(string value);
pub extern void write_error(string value);
```

Callers must explicitly `import std.io;` and use `std::io::read_byte()` etc.,
or use normal module aliases/selective imports. No implicit imports or search
paths are added. Register `stdlib` as a source root with prefix `std` and a
package dependency, as shown in `examples/package.json`.

`read_byte()` consumes one stdin byte and returns an `int` in 0..255, or -1 at
EOF, including on repeated EOF reads. Check EOF before calling `byte(value)`.
`write_byte` writes exactly one byte to stdout. `write_string` and `write_error`
write every string byte to stdout and stderr respectively, without implicit
newlines, encoding conversion or NUL termination. Empty strings are valid.
Writes flush their stream before returning, including empty writes. Reported
read, short-write and flush failures trap with status `70`; already consumed
input and written output are not rolled back. The CLI ignores `SIGPIPE` where
available so broken pipes report stream errors rather than terminating by signal.

`pub extern Result name(parameters);` has no L body. Stage 0 accepts it only at
module scope in `std.io`, with one of these four exact resolved signatures.
Private, namespaced, unknown or incorrectly typed externs are compilation errors,
even when unused. Transparent scalar aliases work in signatures; parameter names
and `const` do not change them. Other declarations retain their ordinary behavior;
matching an intrinsic name without `extern` does not give a function VM behavior.
This is not general FFI or a new linker protocol. Intrinsics are impure calls,
not constant expressions, and obey normal argument order and call/step budgets.

The C embedding API retains `execute_program(ctx, program)` for standard streams
and adds `execute_program_io(ctx, program, input, output, error)` for caller-owned
`FILE *` streams. It never closes, rewinds or clears them. The embedder supplies
valid streams, handles its own signal policy and cleans the execution context
after traps. Each execution still starts with fresh static cells; I/O side effects
remain external. No file handles, Unicode text API, formatting, dynamic input
strings, file opening or general extern functions are exposed to L.

### VM execution observation

The C embedding API also provides optional read-only execution observation:

```c
int32_t execute_program_observed(Context *ctx, const Program *program,
    FILE *input, FILE *output, FILE *error, VmObserver observer, void *data);
```

`VmObserver` has signature `void (*)(void *, VmEvent)`. The callback receives the
supplied opaque data pointer unchanged (including NULL), and an event by value.
Passing a NULL observer disables callbacks. Existing `execute_program` and
`execute_program_io` calls keep their behavior and use no observer. As with those
APIs, supply a verified, live `Program` and valid caller-owned streams.

Each `VmEvent` contains `kind`, `function`, `pc` and `arm`. Function and instruction
positions index `program->functions[function].code[pc]`, allowing callers to look
up names and serialized source line/column metadata without exposing VM registers.

- `VM_INSTRUCTION` fires immediately before an opcode executes, with
  `arm == L_NONE`. An opcode that traps still has this start event. Instructions
  rejected by the step budget and callees rejected by the depth limit have no
  execution event.
- `VM_BRANCH` reports the selected outcome of `branch` or `switch`, before the
  transfer or an unmatched-switch trap. Its PC is the selecting instruction,
  not the destination. `branch` uses arm 0 for true and 1 for false. `switch`
  uses case-vector-relative arms 0..count-1, regardless of the vector's offset,
  and arm `count` for the fallback, including empty tables and trapping fallbacks.
  Outcomes remain distinct when multiple arms share the same destination.

Calls appear as a caller instruction followed by callee instructions; returns
appear before resuming the caller. Observers can collect instruction/branch
counters as a foundation for coverage of future L-written compiler code. No trace
buffer, CLI trace mode or serialized trace format is added, and IR/bytecode stays
at **1.9**. Observer work does not consume VM steps; callers bound its host memory
and time. Callbacks must return normally and must not mutate the program,
execution context or execution streams, or reenter the same execution. Normal
I/O, fresh-static-storage, trap-cleanup and memory-ownership rules are unchanged.

### Value structs

```c
module app.records;

pub struct Pair {
    int x;
    bool ready;
};

pub Pair increment(Pair value) {
    value.x++;
    return value;
}

int main() {
    Pair original = Pair{41, true};
    Pair changed = increment(original);
    if (original.x != 41) return 1;
    return changed.x;
}
```

Structs are nominal types: distinct declarations remain different types even
when their field layouts match. Declarations may be forward-referenced and use
normal module/namespace/import lookup. Struct names are private unless `pub`;
fields are public by default. Public functions cannot expose a private struct in
their result or parameter types. Scalar aliases may be used for field types.

`Type{...}` supplies exactly one correctly typed value per field in declaration
order; trailing commas are accepted. Arguments evaluate left to right. Local
bindings require explicit initialization; `auto` may infer a struct type.
Assignment, parameter passing and returns copy every field. Mutating a callee's
parameter or a returned copy never changes its caller's original value.

`.field` reads work on bindings and temporary values. Field assignment and integer
postfix updates require a mutable local/parameter root; `const` bindings protect
all fields. Whole-value assignment also respects `const`. Struct equality and
implicit conversions between nominal types are not supported.

This slice supports 1..64 `int`/`bool`/`byte`/`string`/enum fields and at most 256 linked
struct types.
Empty structs, nested/array fields, field initializers, methods, inheritance,
aggregate statics/constants, struct arrays and aliases to structs are deferred.
Constructor inputs share the existing 2048-entry per-function argument-vector
budget with calls. `struct` is now reserved.

### Scoped nominal enums

```c
module app.tokens;

pub enum Kind {
    Identifier,
    Number = 7,
    End,
};

const Kind initial = Kind::Identifier;
static Kind current = initial;

int main() {
    current = Kind::Number;
    switch (current) {
        case Kind::Number: return 42;
        default: return 0;
    }
}
```

Enum declarations are module/namespace scoped, nonempty and private unless `pub`.
Members are scoped under their enum, with the enum's visibility; bare member
names are not injected into the surrounding scope. Ordinary imports, module
aliases and selective type imports work, including renamed types:
`import app.tokens::{Kind as K};` permits `K::Number`. Members can also be
selectively imported with the existing qualified-import syntax.

The first implicit value is zero; later implicit values increment the preceding
value with signed 32-bit overflow checking. Explicit values are checked integer
constant expressions and may reference forward module constants. Trailing commas
and duplicate values are allowed; duplicate member names are not. All initializer
expressions are checked even in unused enums. Values need not be contiguous.

Each enum declaration is a distinct nominal type, including identical layouts in
different modules. Enum values support initialized locals, `auto`, `const`, scalar
module constants/statics, struct fields, copying, parameters/returns, overloads,
same-enum `==`/`!=` and switches. Case labels must be constants of exactly the
selector's enum type. Duplicate folded labels are rejected, including aliases
with equal values. Switches retain ordinary fallthrough/default behavior; enum
membership does not imply exhaustiveness or remove the structural return check.

There are no implicit integer conversions, casts, enum arithmetic/order/update
operators, enum arrays or aliases to enums in this slice. Public signatures,
constants/statics and public struct fields cannot expose a private enum type.
The seed permits 256 linked enums with 1..1024 members each. `enum` is reserved.

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

Module constants require explicit `int`/`bool`/`byte`/`string` types (or transparent
aliases to them) or enum types, and scalar initializers.
Their initializer syntax permits literals, constant references, and the supported
unary/binary operators, byte/integer conversions, string length and string indexing.
Function calls, assignments, postfix updates and ordinary array indexing are
rejected, including in unevaluated operands. All operands are name/type checked;
evaluation honors short-circuiting and skips unevaluated operands.
Forward references work, and evaluated constant-dependency cycles report their
complete qualified-name path. Compilation also rejects overflow, division by zero,
and `INT32_MIN / -1` or `% -1`, even in unused constant declarations.

Imports, aliases, namespace lookup, private-by-default visibility and `pub` work
as for functions. Locals/parameters may shadow constant names; module constants
cannot be assigned or incremented. Constant values are inlined, without runtime
storage or initialization instructions. Local `const` declarations keep their
existing runtime-initializer behavior. Compile-time evaluation uses the existing
256-level nesting limit.

### Constant array lengths and case labels

Array lengths and non-default `case` labels accept the same checked pure
expressions as module constant initializers. Lengths require an exact `int`
result; case labels require exactly the selector's `int`, `byte` or enum type.
They may reference module/namespace constants, including forward declarations,
qualified imports, module aliases and renamed selective imports.

```c
module app.shapes;

const int width = 3;
const int answer = 6 * 7;

int main() {
    int values[width * 2 / 2];
    switch (answer) {
        case answer - 1: return 0;
        case answer: return values[width - 1] + answer;
        default: return 0;
    }
}
```

Lengths must fold to 1..65535 and obey the existing 65536-element per-function
limit. Integer case labels may use the full signed 32-bit range; labels that fold to the
same value are duplicates, even when written differently. Overflow and division
errors are compilation errors rather than runtime traps, including in unreachable
declarations and unselected cases. Integer/boolean conversions are not implicit.

Runtime locals, parameters and local `const` bindings are not compile-time
constants. They shadow outer constants normally, without fallback. Mutable static
storage, calls, assignments, postfix updates and ordinary array indexing are
forbidden in these expressions, including in unevaluated operands. String length
and string indexing are permitted. Labels use the shared switch's
lexical scope, so a preceding case's local can shadow a module constant.
Folding emits only existing slot lengths and case-table values; it adds no
runtime evaluation or additional format changes. Current IR/bytecode is **1.9**.

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

Scalar `static` declarations are module/namespace-scoped bindings with explicit
`int`/`bool`/`byte`/`string` types (or transparent aliases) or enum types, and required
compile-time initializers.
Initializers follow the constant-expression rules above: literals, constant
references, checked pure operators, byte/integer conversions, string length and
string indexing. They cannot read mutable static storage, call functions, assign,
update or index ordinary arrays, even in unevaluated operands. Unused declarations are
checked too. Initial values are stored as data; no module initialization function
or arbitrary code runs before `main`.

Each VM execution initializes its own static cells once before the entry call.
Cells are shared by all functions, recursive calls, namespaces and importing
modules in that execution. Separate executions of the same `Program` start fresh;
executing it does not mutate the IR initializer table. Runtime assignment and
integer postfix updates preserve left-to-right evaluation and checked-overflow behavior.
`pub` permits cross-module reads and writes; private cells remain module-private.
Aliases/selective imports refer to the same cell, not copies. Locals/parameters
may shadow static names. Function-local statics, static functions
and implicit mutable module variables are not supported by this seed.

### Static arrays

```c
module app.buffers;

pub const int capacity = 65535;
pub static byte source[capacity];
static int positions[256];
namespace tokens {
    pub static bool active[256];
}
```

`static Type name[length];` declares fixed, zero-initialized storage at module or
namespace scope. Element types must resolve to `int`, `bool` or `byte`; existing
scalar aliases can name element types, but arrays are not first-class alias or
value types. Lengths are compile-time `int` expressions in 1..65535, with forward
constant references and the same checked folding rules as local arrays. A linked
program permits 1048576 static array elements in total, in addition to scalar
statics. Each array counts once toward the existing 1024-static-declaration limit.

Arrays initialize once per VM execution, not per call or loop iteration. Every
function and importer refers to the same storage; repeated executions start with
fresh zeroes, even after a previous execution trapped. They obey normal visibility,
namespace, selective-import, module-alias and lexical-shadowing rules. Public
arrays permit cross-module element reads and writes.

Indexes require `int`; negative and out-of-range indexes trap. Assignment evaluates
and checks the index once, before evaluating its value. Integer element `++`/`--`
returns the old value, checks overflow and does not reevaluate the index. Boolean
and byte elements retain exact typing and canonical ranges. Static array accesses
are not constant expressions, including in lengths and unused/unevaluated operands.

Array initializers, whole-array reads/assignments, array parameters/returns,
multidimensional arrays and arrays of strings, enums or structs are unsupported.
There is no array `.length` property; retain the declared capacity as a constant.
Static arrays do not add pointers, borrowing, GC or dynamic allocation. The shared
input buffer in `examples/static_buffers.l` demonstrates source storage accessible
from separate L functions using the existing stream intrinsics.

## Pipeline and artifacts

Manifest → source-module discovery/registration → import resolution → cycle
detection/dependency ordering → namespace/visibility/name resolution/type checking
→ typed SSA register IR with explicit
local storage slots, nominal struct/enum metadata, a binary string pool and a global-data table →
verification → bytecode → VM.
The seed does not materialize separate HIR, Typed IR and MIR representations yet.
The implemented subset has no ownership model yet.

IR and bytecode are versioned independently, currently both **1.9**.
Bytecode 1.1 added a 32-bit length per slot (0 for scalars), `bounds_check` and
`clear`; 1.2 added a per-function `switch` case-entry table and the `switch`/`trap`
opcodes. Version 1.3 added a global-data table and `global.load`/`global.store`.
Version 1.4 added nominal struct metadata, 32-bit type IDs and the `struct.make`,
`field.load` and `field.store` opcodes, with full-width by-value calls/returns.
Version 1.5 added nominal enum metadata, enum-typed scalar storage and
fields, and enum equality/switches without adding opcodes. Version 1.6 added the
`byte` type, byte arrays and `byte.checked`/`byte.to_int` conversion opcodes.
Version 1.7 added `string`, a binary string-pool table, `string.length` and
`string.index`; equality compares string bytes.
Version 1.8 added four stream opcodes without changing the table/instruction layout.
Version 1.9 adds a 32-bit global length and indexed `global.load`/`global.store`
addressing modes; no type or opcode IDs change.
The loader accepts only the exact format version; recompile older
artifacts from source. The verifier checks instruction types, jump targets, unique
register definitions, dominance, slot initialization, array metadata, addressing
modes, switch targets, duplicate case values, call signatures and returns. It also
checks global counts/indices, scalar types, canonical boolean initializers and
load/store register types. Global stores require dominating source definitions;
global loads define SSA registers and need no local-slot initialization proof. Index
register definitions must also dominate their uses; element accesses require an
initialized array. Loaded bytecode is fully verified before execution.
Static arrays have bounded lengths and total elements, primitive element types
and zero initializers. Global access modes must match the scalar/array shape.
Indexed global accesses require a dominating integer index; stores also require
a dominating, exactly typed value. Globals are already initialized and do not
initialize local slots or arrays. The VM checks bounds independently at each
indexed global access, even when a preceding `bounds_check` is absent.
Struct metadata must have bounded, nonempty, uniquely named scalar fields.
Verification checks nominal type IDs, constructor vectors, field bounds/types,
source-register dominance and whole-value initialization before field stores.
Aggregate registers are immutable values, not aliases into local storage.
Enum metadata has bounded, nonempty, uniquely named members; duplicate values
are valid. Enum IDs must reference a declared type. Enum constants, global
initializers and switch-table values must belong to that type's declared value
set. Typed loads/stores, constructors, fields, calls/returns and equality preserve
nominal identity; arithmetic and integer/enum conversions remain invalid.
Byte constants, global initializers and switch values must be in 0..255.
Conversions require exact source/destination types and dominating source values.
The VM checks narrowing before producing a byte register; widening preserves its
value. Typed storage and zero-initialized byte arrays preserve the byte range.
String tables have bounded entry counts, lengths and total bytes. String constants
and global initializers must reference valid entries. Typed string loads/stores,
fields and calls preserve those references; string operations require exact
operand/result types and dominating definitions. String arrays and switches are
rejected. The loader owns a copy of each entry's bytes; duplicate-content entries
are valid and compare equal even when their indices differ. Loaded tables count
every entry and its bytes toward the limits, including duplicates.
Stream reads define an `int` SSA register. Stream writes define no register
(`dst == L_NONE`) and require a dominating `byte` or `string` source, as appropriate.
Extern declarations lower to normal callable functions with fixed intrinsic bodies;
there is no runtime symbol lookup or serialized extern metadata.
The `switch` operands are `a` = selector register, `b` = table offset, `c` = entry
count and `dst` = fallback PC. A low-level `dst == L_NONE` traps on an unmatched
value; source switches without `default` instead continue after the switch.
The `trap` opcode terminates execution with a defined VM trap.
The VM additionally checks bounds at each element access, so manipulated bytecode
cannot bypass safety by omitting a preceding `bounds_check`.
`inspect` displays the IR, including string lengths and hexadecimal contents,
not an ABI-stable text representation.

The 1.9 header is magic (4 bytes), major/minor (2 bytes each), function count,
entry function index, global count, struct count, enum count and string count
(4 bytes each). Global, struct, enum and string counts start at byte offsets
16, 20, 24 and 28; the complete header is 32 bytes. Struct entries
come first: name length/name bytes, field count, then each field's name length,
name bytes and scalar type ID. Lengths, counts and type IDs are 32-bit. Type IDs
are 0 = `void`, 1 = `int`, 2 = `bool`, 5+n = struct-table entry n, 261+n =
enum-table entry n (each nominal table permits indices 0..255), 517 = `byte` and
518 = `string`. Primitive IDs follow the reserved nominal ranges. Frontend
placeholder IDs 3/4 and undeclared IDs are invalid artifacts. Function result,
slot, register and global types also use 32-bit IDs. Enum entries follow structs:
name length/name bytes, member count, then each member's name length/name bytes
and signed 32-bit value. String entries follow enums: a 32-bit byte length and
exactly that many raw bytes, without padding or a terminator. Zero length is valid.
Global entries follow strings and precede functions: name length
(4 bytes), name bytes, element/scalar type ID (4 bytes), initial signed 32-bit value
(4 bytes), and length (4 bytes: 0 for a scalar, 1..65535 for an array). Array
initializers must be zero; elements themselves are not serialized. Integers use
little-endian encoding; negative scalar initializers
use their 32-bit bit patterns. `global.load` uses `dst` = destination register and
`a` = global index; `global.store` uses `dst` = global index and `a` = value
register. For both operations, `c == 0` selects scalar access (ignoring `b`), while
`c == 1` selects indexed array access with `b` = integer index register; other modes
are invalid. Array storage uses disjoint regions of 32-bit VM cells, including
byte arrays, with an internal offset table not exposed to L or serialized.
String initializers are pool indices; string `const` instructions use
`a` as the pool index. Constant-only programs have an empty global table.

`struct.make` uses `dst` = aggregate register, `a` = initializer-vector offset and
`b` = field count. `field.load` uses `dst` = scalar register, `a` = aggregate
register and `b` = field index. `field.store` uses `dst` = initialized struct slot,
`a` = scalar register and `b` = field index. Non-array `load`/`store` and
calls/returns copy all cells of a struct value. Each field occupies one VM cell;
enum, byte and string values also occupy one cell. This is a VM representation, not a
native ABI or exposed reference layout.

`byte.checked` (opcode 29) uses `dst` = byte register and `a` = int register;
`byte.to_int` (opcode 30) uses `dst` = int register and `a` = byte register.
Both use the existing instruction layout and ignore `b`/`c`.

`string.length` (opcode 31) uses `dst` = int register and `a` = string register,
ignoring `b`/`c`. `string.index` (opcode 32) uses `dst` = byte register,
`a` = string register and `b` = int index register, ignoring `c`. Each index
operation performs its own runtime bounds check.

`io.read_byte` (opcode 33) uses `dst` = int register, ignoring `a`/`b`/`c`.
`io.write_byte` (34) uses `a` = byte register; `io.write_string` (35) and
`io.write_error` (36) use `a` = string register. All three writes require
`dst == L_NONE` and ignore `b`/`c`. Existing type/opcode IDs are preserved.
**Migration:** recompile all older artifacts, including 1.8. Even scalar-only
artifacts require the exact 1.9 version header and the new global-entry layout.
No new keywords are introduced; `extern` and `string` remain reserved.

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
Alias tests exercise 32 generated cross-package import DAGs (seed `0x414c4941`),
checked against independently tracked primitive types. They cover visibility,
shadowing, cycles, limits, overload identity, all supported type positions and
byte-for-byte erasure against equivalent primitive-only source with matching
instruction locations.
Struct tests include 32 cross-package diamond import graphs (seed `0x53545243`)
with independently modeled by-value transformations and shared nominal identity,
128 generated copy/field/call models, aggregate trap/cleanup retries and malformed
IR/bytecode metadata/vector/type mutations. Limits include type IDs above 255.
Enum tests add 32 cross-package diamond graphs (seed `0x454e554d`), checked
against independent nominal-value/state models, and 128 generated value,
duplicate-value dispatch, field/copy/call and shared-state models. Malformed
IR/bytecode cases cover metadata, type ranges, membership, conversions,
constructors, fields, globals, switches and exact-version rejection.
Byte tests add 256 BigInt constant-expression models and 32 cross-package
shared-cell DAGs (seed `0x42595445`). The fuzz suite adds 128 independent byte
array/field/copy/call/state models plus 262 conversion programs covering every
representable value, adjacent failures and signed extremes. Verifier tests check
byte metadata ranges, exact conversion types, dominance and malformed storage,
call, field and switch operations before and after serialization. Another 512
potentially cyclic graphs exercise byte-conversion dominance without execution.
String tests add 256 host-buffer constant models (seed `0x53545243`), all 256 byte
values, every printable ASCII character, escape/error/limit cases and 32 shared-cell
import DAGs (seed `0x53545244`). The fuzz suite adds 128 independent byte-sequence,
equality, field/copy/call and state models plus 136 signed-boundary index programs.
Another 512 potentially cyclic verifier graphs check string length/index dominance
and storage initialization without execution. The 55 string IR cases run directly
and after serialization, covering pool/resource limits, references, operand types,
dominance, forbidden operations, duplicate-content equality and empty strings.
Format tests truncate every byte, corrupt metadata and verify that loaded strings
survive overwriting the input buffer.
I/O tests compare source and bytecode stdout/stderr as raw buffers, exercise all
256 input/output byte values, empty streams/strings, repeated EOF, import forms,
signature restrictions, reproducibility and broken pipes. Fault injection covers
read errors, buffered/unbuffered output failures, already-reported errors and
empty-write flush failures. Twenty I/O IR cases check source/destination types,
register ranges, definitions, dominance and control flow directly and after
serialization. Another 512 potentially cyclic I/O verifier graphs are never run.
The fuzz suite adds 128 independent stream-state models, checking input position,
exact stdout/stderr bytes, return values, short-circuit/nested-call order and
output retained before traps. Each source/deserialized program runs three times
on caller-owned streams, with trap cleanup and fresh statics between executions.
Static array tests cover all three element types, folded lengths, limits, imports,
shared diamond dependencies, shadowing, exact index/value types and forbidden
whole-array operations. The stream-buffer example handles empty, full and oversized
binary inputs before and after serialization. Twenty-nine IR cases exercise
metadata, scalar/array mode mismatches, index dominance, unguarded bounds and
storage reset. The fuzz suite adds 128 independent array/state/order models,
10 mutation/trap/cleanup lifecycle programs and 512 additional verification-only
graphs for indexed global accesses. Arbitrary mutants and cyclic graphs are
still never executed.
Another 32 static-buffer import DAGs (seed `0x42554646`) run in two import orders,
with independent BigInt heaps for integer, boolean and byte arrays. They exercise
shared diamonds, imported constant lengths, scalar element-type aliases, nested
calls, postfix updates, short-circuiting and assignment after RHS mutation.
Snapshots check array contents and visit counts; sorted metadata checks lengths,
zero initializers, adjacent private scalar guards and one entry per declaration despite
multiple import paths. A separate I/O lifecycle program mutates all three array
types before read, buffered-write or unbuffered-write failures. Its 40 compiled
and deserialized executions alternate failures and successful retries through
nested helpers, checking consumed input, retained stdout prefixes, caller-owned error flags,
execution cleanup, fresh statics and unchanged metadata/serialized bytecode.
These tests keep the language syntax and IR/bytecode format at 1.9.
Observer tests compare exact instruction and branch-event order against independent
loop/call/dispatch models, directly and after serialization. The 132 cases include
disabled callbacks, NULL data, repeated runs, shared branch destinations,
nonzero case-vector offsets, empty switches and trapping fallbacks. They check
I/O failures, unchanged program results/bytecode, cleanup, and exact event counts
at the instruction and call-depth limits. Observation is tested on explicitly
bounded programs and known resource-limit cases, never arbitrary mutants or
potentially cyclic verifier graphs.
Storage/dispatch tests reuse 423 integer-expression BigInt models in lengths and
labels, checking folded metadata, errors, duplicates, visibility and shadowing.
The fuzz suite adds 128 bounded constant-shape programs checked against separate
host-side length, dispatch and bounds models before and after serialization.
Static tests cover shared state, visibility, initialization, recursion, aliasing,
evaluation order, signed/boolean metadata, limits, traps and version rejection.
They also compare 32 stateful import DAGs (seed `0x53544154`) against a BigInt
model, checking every cell and private visit counter after each operation.
Every graph includes diamonds and cross-package dependencies, uses all import
forms, and runs in two import orders. Initializer tables must contain exactly one
cell per declaration, independent of the number of importing paths.
The fuzz suite adds 128 independent shared-state models, runs each source and
bytecode program twice, and tests global-store dominance in generated verifier
graphs. Arbitrary bytecode mutants and potentially cyclic verifier graphs are
still verified, not executed.
Seventeen additional static-lifecycle programs check arithmetic, array/string bounds
and byte conversion traps, enum-controlled dispatch and the call-depth/instruction
budgets after mutating integer, boolean, byte, string and enum cells. Source
and deserialized IR alternate trapped and successful executions using the same
execution context, with caller cleanup after traps. Every retry starts fresh,
successful executions release their memory, and neither initializer metadata nor
serialized bytecode changes. Targeted verifier cases ensure global loads/stores
cannot initialize local scalars/arrays or bypass source-register dominance.
It also runs `make fuzz`: a fixed-seed bytecode mutation corpus plus generated
array, switch and expression programs checked against independent host-side
models. Mutations include truncation, bit/word replacement, insertion, deletion,
splicing and random data.
The semantic tests compare full 32-bit results before and after serialization and
check signed index boundaries for integer/boolean/byte array reads and writes. Switch
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
The 1.9 slice measures 2596/2596 lines, 163/163 functions and 2660/2660 branches.
Its suites pass 842 integration checks, 8872 module checks, 182 frontend cases,
52 fault cases, 319 verifier cases plus format mutations, and 132 observer cases. Deterministic fuzzing
covers 31966 bytecode inputs, 3116 semantic programs, 8595 VM executions and 2560
verification-only control-flow graphs.
100% coverage does not establish correctness or full language conformance.
