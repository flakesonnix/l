# Language L — Stage 0

L is a language under construction. This is its C11 bootstrap compiler and
bytecode VM: enough to compile and run real programs, not a finished implementation
of L 0.1 or L-Core. There is no LLVM dependency, and no external library dependency.

Build, Nix and CI instructions: [development guide](docs/DEVELOPMENT.md).
GitHub review order and merge instructions: [review guide](docs/REVIEWING.md).

## Source syntax status

The executable replacement stack, **#30–#37, is merged**. The
[`examples/replacement/`](examples/replacement/) programs run through the C
bootstrap; they are not just parser demos. The merged compiler snapshot is
`e2ca42a3`, with [passing main CI](https://github.com/flakesonnix/l/actions/runs/44551718137).

The goal is **Nix-style syntax with imperative loops and explicit mutation**,
not C with a few Nix spellings. This branch adds typed Nix-style function
definitions and direct calls to `let/in`, conditional expressions, and name-first
constants, aliases, namespaces, enums and records. Runtime `let` and conditional values can be `int`,
`bool`, `byte`, `string`, nominal enums or record/struct values. Aggregate
expressions extend the merged snapshot above without adding a new backend or
bytecode version. C-style definitions remain bootstrap/compatibility syntax;
the earlier `=>` arrow-function form is still out.

The Nix influence stops at syntax. Evaluation is eager and left to right, types
are static, and [module resolution](spec/module-system-v0.1.1.md) needs an explicit
manifest. There is no laziness, dynamic typing or implicit module search.
IR/bytecode is still **1.9**.

There are two paths to keep straight:

- **Stage 0, written in C, compiles and runs programs.** It supports the executable
  subset below and still accepts the old bootstrap sources.
- **Stage 1, written in L, checks syntax.** Its parsers accept more of the planned
  grammar, but do not resolve names, check types or compile their input.

The source migration is unfinished. Keeping old code working while that happens
does not mean maintaining two permanent user grammars. New syntax takes priority
over adding enum/struct declarations to the legacy Stage 1 file parser.

### First executable replacement subset

Start with [`examples/replacement/answer.l`](examples/replacement/answer.l):

```sh
make
./build/l check examples/replacement/answer.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/answer.l --manifest examples/replacement/package.json -o build/answer.lbc
./build/l run build/answer.lbc                   # Exit code 42
```

An exit code of **42** is the expected result, not a failed test. Source commands
need an **explicit manifest**. Here it maps `app` to the example directory, so
`answer.l` declares `module app.answer;`. The acceptance program below is also
tested as `main.l` under a matching root. Nothing searches your working directory
for a package or standard library.

The path is source → C lexer/parser → owned AST → semantic analysis → LIR →
verified **bytecode 1.9** → VM. The new syntax uses that same compiler and runtime.
It does not connect the L-written parser arenas to the backend, add an AST file
format, or make the compiler self-hosted.

You get modules and `pub`, typed functions and calls, initialized C locals,
`const` parameters/locals, arithmetic, comparisons and explicit returns. The
name-first forms below go through the same name, type, visibility and entry-point
checks before any bytecode is written.

#### Nix-style functions and calls

Write an explicit signature, then its matching definition immediately after it:

```l
module app.main;

pub add : int -> int -> int;
add = a: b: a + b;

main : () -> int;
main = do {
    return add 20 22;
};
```

Each type before the last `->` describes one parameter; the final type is the
result. Parameter names come from the definition, in that same order. `() -> T`
is the zero-parameter signature; it is not a unit-valued parameter. Signatures
and definitions must be adjacent and have the same unqualified name. Put `pub`
on the signature. Namespaces, imported/qualified types, primitive aliases,
nominal enum/record types, overloads, forward calls and recursion use the existing
resolver and type checker. There is no new type inference.

Inside these new function bodies, `add 20 22` is **one complete direct call**.
Arguments run eagerly, left to right. Application binds tighter than arithmetic:
`add 10 10 * 2` means `(add 10 10) * 2`. Use parentheses for a nested call or
compound argument: `add (twice 10) (11 * 2)`. Parentheses need no surrounding
spaces, so `add(20)(22)` works too. Negative/unary arguments, `let` and `if`
arguments need parentheses. `answer ()` invokes a zero-parameter function.

This is Nix-like syntax, **not currying**: partial calls, stored/passed function
values, anonymous lambdas and closures are not supported. `(add 20) 22` is
rejected. Conversions keep their explicit `int(expr)` and `byte(expr)` forms.

A plain expression body returns its value. For statements and loops, write
`do { ... }` as the whole function body, ending the definition with `;`.
It supports the existing `for`, `while`, `break`, `continue`, `switch`, local
declarations, assignments and explicit returns. `do` is contextual here, not a
reserved identifier or a general block expression. Locals and parameters retain
the existing by-value/mutability rules; plain `let` bindings are still readonly,
and `var` makes a `let` binding mutable.

Inside a `do` body, local mutable bindings can also use the name-first form:

```l
main : () -> int;
main = do {
    var total = 0;
    for (var i = 0; i < 3; i++) {
        total = total + 14;
    }
    return total;
};
```

`var name[: Type] = expression;` creates a mutable local. The type is inferred
when omitted, and the initializer runs before the new binding exists, so a
shadowing initializer reads the outer value of the same name. This works as a
statement and as a `for` initializer; it is the same AST, slot, scope, typing
and copy behavior as an initialized C local. There is no new name-first readonly
statement here: keep using `let/in` or a typed local for that. `var` remains a
contextual declaration word only in Nix bodies, so old C declarations and
`let var` keep working.

[`examples/replacement/bindings.l`](examples/replacement/bindings.l) uses a
name-first local and a `for (var ...)` initializer to return 42:

```sh
./build/l check examples/replacement/bindings.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/bindings.l --manifest examples/replacement/package.json -o build/bindings.lbc
./build/l run build/bindings.lbc                # Exit code 42
```

Nix-style bodies also have a range loop:

```l
main : () -> int;
main = do {
    var total = 0;
    for i in 0..3: do {
        total = total + i;
    }
    return total + 39;
};
```

`for name in start..end: do { ... }` walks the **half-open** int range
`start <= i < end`. Both bounds must be `int` and are evaluated once, left to
right, before the loop variable is bound; each bound can be a call or another
expression. The loop variable is a fresh mutable local in the loop scope, so
shadowing, `break`, `continue`, nested loops and postfix updates behave exactly
as in `for (var i = ...; ...; ...)`. An empty or reversed range executes zero
times. There is no step expression, float/string/struct range, lazy sequence or
iterator protocol in this slice.

[`examples/replacement/ranges.l`](examples/replacement/ranges.l) sums a range and
returns 42:

```sh
./build/l check examples/replacement/ranges.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/ranges.l --manifest examples/replacement/package.json -o build/ranges.lbc
./build/l run build/ranges.lbc                  # Exit code 42
```

Nix-style bodies also have a condition loop:

```l
main : () -> int;
main = do {
    var n = 0;
    while n < 3: do {
        n++;
    }
    return n + 39;
};
```

`while condition: do { ... }` re-evaluates a `bool` condition on every pass and
runs the body while it holds. It is the same loop AST, slot scope and `break`/
`continue` behavior as `while (condition) { ... }`; the C spelling still works in
both body styles. Only the Nix spelling uses `:` and `do`.

The whole condition can be parenthesized: `while (n < 3): do { ... }`.
Nested groups, calls such as `(check n)` and scoped expressions such as
`(let current = n; in current < 3)` keep their usual meaning. In a Nix function,
the `:` after the closing parenthesis selects the Nix body spelling; without it,
`while (condition) statement` keeps the existing C behavior. Grouping does not
evaluate the condition an extra time or change `break`, `continue` or scope.

A group can also be the left operand of a longer Nix condition, for example
`while (n + 1) < 4: do { ... }` or `while (check n) && ready: do { ... }`.
These use the ordinary expression precedence and evaluate each operand normally.
Without the condition colon, `while (condition) +n++;` and its unary-minus
counterpart still mean C-style single-statement loop bodies, not extra condition
operands. Typed `let` bindings, nested literals and punctuation inside strings
do not confuse that distinction.

Both Nix loop forms require the block after `do`, even for an empty body:
write `while false: do { }`, not `while false: do ;` or `: do return 0;`.
The same rule applies to `for i in start..end: do { ... }`. Ordinary C-style
loops still allow a single statement without braces in either body style.

[`examples/replacement/condition.l`](examples/replacement/condition.l) counts a bounded
countdown and returns 42:

```sh
./build/l check examples/replacement/condition.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/condition.l --manifest examples/replacement/package.json -o build/condition.lbc
./build/l run build/condition.lbc                  # Exit code 42
```

The parser translates these forms into the existing function/call AST. An
expression body becomes an ordinary block containing a return. The analyzer,
LIR, verifier and VM are unchanged, and bytecode remains **1.9**. Existing C-style
functions keep their original body grammar and comma-separated calls. A Nix-style
body calls either kind with Nix application; a C-style body calls either kind
with `add(20, 22)`. There is no global grammar switch or arity-dependent parsing.

[`examples/replacement/functions.l`](examples/replacement/functions.l) combines
a Nix-style helper with a bounded `for` loop and returns 42:

```sh
./build/l check examples/replacement/functions.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/functions.l --manifest examples/replacement/package.json -o build/functions.lbc
./build/l run build/functions.lbc                # Exit code 42
```

The L-written Stage 1 drivers do **not** parse these new signatures, colon
parameters, application, `do` bodies, name-first local declarations, range loops
or Nix-style `while` yet. Their older C-style contracts below
are unchanged. This extension builds on the aggregate-expression slice, not on a
new backend or a self-hosted compiler.

#### Local values and conditionals

`let name[: Type] = expression; ... in body` opens a lexical scope. Leave out the
type to infer it; write `var` if the binding needs to change. Otherwise it is
immutable. Empty `let in body` is fine, but duplicate names in one `let` are not.

Initializers run **once, in written order**, even if their values go unused. Each
can read outer and earlier bindings, not itself or later bindings. That means a
shadowing initializer can read the outer value of its own name. The body sees all
the bindings; none escape the `let`.

Bindings and results can be `int`, `bool`, `byte`, `string`, nominal enums or
nominal records/structs, including primitive aliases and qualified/imported types.
Written types must match exactly. There are no implicit conversions, and no void
or whole-array results.

An aggregate binding holds a copy, not a reference into another binding. Plain
`let` bindings protect the whole value and its fields; `var` permits whole-value
assignment and field writes. Passing either kind to a function still copies the
value. Returning a value from a `let` does not expose its local storage.

`if condition then value else value` needs a bool condition and two exactly
matching value types. Two enums or aggregates with identical layouts are still
different nominal types. The condition runs once, and **only the selected branch
runs**. Both branches are parsed and type-checked, even when the condition is a literal.
Branch-local bindings stay local.

These are runtime expressions, not compile-time constants. `&&` and `||` still
short-circuit, but skipping execution never skips name or type checking.

#### Constants and aliases

`[pub] name: Type = expression;` declares a file constant. Its written type must
resolve to `int` or `bool`; aliases to those types work too. The existing constant
evaluator checks arithmetic and honors boolean short-circuiting. Forward
references work; evaluated dependency cycles do not. Skipped operands are still
checked for valid names and types.

Constants follow the usual duplicate, import and visibility rules. They fold into
LIR without allocating VM globals, and can supply array lengths, switch labels and
legacy static initializers. Calls, mutable-static reads, `let` and conditionals
are not constant initializers. Both constant spellings share the 1024-constant
budget across loaded modules, plus the existing dependency nesting limits.

`[pub] Name = alias Type;` gives a scalar type another name, not another identity.
Targets must resolve to `int`, `bool`, `byte` or `string`. Forward, chained and
imported aliases work; cycles and duplicate signatures are errors. There is no
runtime alias value or storage. Both spellings share the 1024-alias budget.

Aliases belong at module or namespace scope, not inside functions. `alias` is
contextual after `Name =`, not a new reserved keyword. The old `using` spelling
still works. A byte/string alias does not relax the int/bool-only file-constant
restriction.

#### Namespaces and enums

`Name = namespace { ... };` opens a compile-time scope. Nest it, reopen it, and
use relative or qualified lookup as usual. Keep the final `;`. Export members
with their own `pub`: `pub` on the namespace itself is rejected. A namespace is
not a runtime object or an initialization block.

The old `namespace Name { ... }` spelling reopens the same scope. Both forms share
the existing visibility, dependency, nesting and resource rules, including the
256-level limit. Module headers and imports still go before declarations at file
scope, never inside a namespace.

`[pub] Name = enum { Member; Other = expression; };` declares a nominal enum.
Every member needs `;`, and so does the closing `}`. Empty lists, duplicate names
and out-of-range explicit/implicit int32 values are errors. Different members may
share a value; duplicate folded switch cases may not.

Enum values work in the existing constant/static storage, scalar struct fields,
parameters, returns, comparisons and switches. Runtime `let` and conditionals
support them too. The old comma-separated enum form shares the same budgets and
type rules. Aliases still cannot target enums, and name-first constants remain
int/bool-only.

#### Records and field order

`[pub] Name = record { field: Type; ... };` declares a nominal value record.
Fields must resolve to int/bool/byte/string or enum types. Records and C-style
structs share the 256-type limit and 1..64 fields per type. Nested aggregate
fields, arrays/defaults, aggregate globals and aliases to records are not supported.

`Type { field = expression; ... }` supplies every field exactly once. Unknown,
duplicate, missing and mistyped fields are errors. Values run **in written field
order**, not declaration order. Labels do not create variable bindings or recursive
attribute scopes. Unused fields still run, and nested calls keep their normal
argument order.

Assignment, parameters and returns copy records by value. Changing a copy does
not change the original; `const` protects field writes. Named literals work with
C-style structs too. New record declarations require named literals; C-style
structs keep comma-separated positional expressions, including assignments.
Semicolons distinguish the named form.

`record` is contextual after `Name =`. Its spelling flags and resolved field
indexes stay inside the compiler: the result uses existing `struct.make` LIR,
nominal metadata and VM code. Record literals remain runtime-only. Records and
structs can flow through `let` and conditionals using those same value copies;
this does not add nested aggregate fields, aggregate arrays or aggregate globals.

The source compiler reserves `let`, `in`, `var` and `then`. Use parentheses when
an operator should apply outside a whole `let` or conditional expression. The
existing 256-level compiler nesting, slot and VM budgets still apply.

The standalone L-written drivers only record this syntax. They do not become
executable compilers because Stage 0 accepts it. Old `const Type name` and the
other bootstrap spellings remain available while the source migration continues.

[`examples/replacement/choose.l`](examples/replacement/choose.l) exercises a
conditional with a nested `let` and an unselected division-by-zero branch:

```sh
./build/l compile examples/replacement/choose.l --manifest examples/replacement/package.json -o build/choose.lbc
./build/l run build/choose.lbc                   # Exit code 42, no trap
```

[`examples/replacement/constants.l`](examples/replacement/constants.l) combines
forward-referenced constants with runtime `let` and conditional expressions:

```l
pub answer: int = base + 2;
base: int = 40;
ready: bool = answer == 42;
```

```sh
./build/l check examples/replacement/constants.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/constants.l --manifest examples/replacement/package.json -o build/constants.lbc
./build/l run build/constants.lbc                # Exit code 42
```

[`examples/replacement/aliases.l`](examples/replacement/aliases.l) combines
forward/chained aliases, typed constants, a readonly parameter and runtime expressions:

```sh
./build/l check examples/replacement/aliases.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/aliases.l --manifest examples/replacement/package.json -o build/aliases.lbc
./build/l run build/aliases.lbc                  # Exit code 42
```

[`examples/replacement/namespaces.l`](examples/replacement/namespaces.l) reopens
a name-first namespace containing an alias, forward constants and a function:

```sh
./build/l check examples/replacement/namespaces.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/namespaces.l --manifest examples/replacement/package.json -o build/namespaces.lbc
./build/l run build/namespaces.lbc               # Exit code 42
```

[`examples/replacement/enums.l`](examples/replacement/enums.l) uses a name-first
enum with equal-valued members, a readonly enum parameter and nominal switch dispatch:

```sh
./build/l check examples/replacement/enums.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/enums.l --manifest examples/replacement/package.json -o build/enums.lbc
./build/l run build/enums.lbc                    # Exit code 42
```

[`examples/replacement/records.l`](examples/replacement/records.l) evaluates
reversed mixed-type fields in written order, then checks by-value copy behavior:

```sh
./build/l check examples/replacement/records.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/records.l --manifest examples/replacement/package.json -o build/records.lbc
./build/l run build/records.lbc                  # Exit code 42
```

[`examples/replacement/scalars.l`](examples/replacement/scalars.l) combines string,
byte-alias and nominal-enum `let`/conditional values. Eager bindings execute once;
the unselected out-of-range byte conversion never executes:

```sh
./build/l check examples/replacement/scalars.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/scalars.l --manifest examples/replacement/package.json -o build/scalars.lbc
./build/l run build/scalars.lbc                  # Exit code 42
```

[`examples/replacement/aggregates.l`](examples/replacement/aggregates.l) returns a
record from a conditional and a `let`, then changes a copy without touching the
original. The unselected constructor would divide by zero, but never runs:

```sh
./build/l check examples/replacement/aggregates.l --manifest examples/replacement/package.json
./build/l compile examples/replacement/aggregates.l --manifest examples/replacement/package.json -o build/aggregates.lbc
./build/l run build/aggregates.lbc               # Exit code 42
```

Scalar and aggregate expressions reuse the existing typed lexical slots, branch
temporaries, registers and VM operations. Values can be passed, returned and
assigned; scalar results can also initialize record fields. Reading a temporary
aggregate's field is fine, but it is not a writable view into the original.
Array lengths, switch labels, enum members and
constant/static initializers still reject `let` and conditionals; scalar runtime
support does not turn either form into compile-time evaluation.

### Broader syntax-only replacement-parser slices

```text
module app.main;

pub int add(int a, int b) { return a + b; }
int main() {
  int value = add(20, 22);
  return let bonus = 0; in value + bonus;
}
```

Run `make stage1`, then pipe this source into
`./build/l run build/stage1-binding.lbc`. Success returns **0**, not 42: this
driver checks syntax without running input. Name-first top-level constants
(`answer: int = 42;`), C-style typed parameters/results, ordinary calls and nested
`let/in` are supported. C-style bodies accept blocks, `if`/`else`, `while`, `for`,
`switch`, `break`, `continue`, explicit `return` and initialized local declarations.
C locals are mutable by default; `const` records readonly intent. Within `let`,
plain bindings remain immutable, `var` marks mutability, and types may be omitted.
The executable subset above enforces eager/sequential semantics, not Nix laziness,
currying or recursive attribute scopes. This standalone parser does not enforce
semantic rules.
Parameters may use leading `const`, as in `const int value`, to record readonly
intent for the parameter. This does not create a new type or overload signature;
the parser does not enforce readonly writes or resolve signature identity.

Conditional expressions use the approved `if condition then value else value`
spelling, with a mandatory `else`, anywhere an expression is accepted:

```text
module app.choose;
int choose(bool ready) { return if ready then 42 else 0; }
```

They can nest in conditions, either branch, calls and `let` initializers. The
executable C frontend enforces bool conditions, exactly matching value results and
selected-branch evaluation as described above. The standalone Stage 1 driver
still does not check condition or branch types, select a branch, or execute
either branch. Parentheses delimit a
conditional when an operator should apply outside its full `else` expression.
C statement `if (condition) statement else statement` is separate and may omit
`else`. At statement start, `if` selects that C form; parenthesize a Nix conditional
used as a discarded expression statement.

Records use name-first declarations and explicitly named literals:

```text
module app.records;
pub Pair = record { x: int; ready: bool; };
int main() {
  Pair pair = Pair { x = 42; ready = true; };
  return pair.x;
}
```

The executable C frontend now enforces nominal, copied-by-value records and
written initializer order, not anonymous structural attribute sets. It checks
field names, completeness, duplicates and types before lowering through the
existing value-struct path. The standalone L-written parser still records syntax
without those checks or execution. Positional values and anonymous literals are
not replacement record syntax.

Enums use name-first declarations with `;`-terminated members; structs use a
C-style keyword-first form as a second aggregate spelling alongside records:

```text
module app.aggregates;
pub Color = enum { Off; On = 1; };
pub struct Point { int x; bool ready; };
int main() { return 0; }
```

Enum members are `Name`, optionally followed by `= expr`, each terminated by
`;`; the closing `}` requires `;`. The executable C frontend checks and evaluates
members with the existing nominal-enum analyzer; empty enums are rejected there.
The standalone L-written parser still accepts empty lists syntactically and
records expression nodes without member value, uniqueness or range checks.
Structs declare scalar fields
as `Type name;` with the type written first; field arrays, initializers and
inline aggregate declarations are not field syntax, and the closing `}` requires `;`.
Struct nodes share the aggregate budget with records and differ only in a
distinct node kind, so field order, types and duplicate names remain unchecked
semantic work.

Transparent aliases use the approved `Name = alias Type;` form:

```text
module app.types;
pub Count = alias int;
Count increment(Count value) { return value + 1; }
```

The executable C frontend now resolves these aliases with the existing scalar
analyzer as described above; they create no nominal types or runtime values.
The standalone L-written parser still only records written targets: it does not
resolve/expand them, validate target types, check visibility or detect cycles.

Namespaces use name-first bindings too:

```text
module app.math;
math = namespace {
  pub int add(int a, int b) { return a + b; }
};
int main() { return math::add(20, 22); }
```

These are compile-time scopes, not runtime records or recursive attribute sets.
The executable C frontend merges reopened scopes and checks lookup, duplicates
and visibility with its existing analyzer. The standalone L-written parser still
only records nested/reopened syntax nodes in written order; it does not perform
those semantic checks. Export members with their own `pub`; `pub` on a namespace
is rejected and visibility is not inherited.

Static storage and external functions keep their existing C-style spellings:

```text
module app.storage;
pub static int value = 42;
static byte buffer[32];
pub extern int read(const byte value);
int main() { return value; }
```

Scalar statics require `= expr`; arrays require one `[length]` and reject explicit
initializers. External declarations are functions only, require `extern` and a
trailing `;`, and have no body. Their parameters support leading `const` like
ordinary definitions. The parser only records written types, initializers,
lengths and signatures: it does not allocate or initialize storage, evaluate
lengths/values, resolve extern implementations, or check their types or visibility.

The new driver rejects the superseded arrow-function form. It is a C-like subset,
not full C: pointer/variadic signatures, prototypes without `extern` and
implicit uninitialized scalar locals are not added. Stage 0 and the legacy
Stage 1 drivers remain temporary bootstrap scaffolding while the replacement is
incomplete, not a permanent second user grammar. See the
[parser contract](bootstrap/stage1/README.md#replacement-binding-file-contract).

## Build and run the current bootstrap

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

## L-written frontend slices

[`bootstrap/stage1/`](bootstrap/stage1/README.md) is where the L-written frontend
is growing: lexer, expression/statement/header parsers, a legacy function-file
parser, a replacement binding-file parser and stdin drivers. Stage 0 compiles and
runs those tools. Their implementation sources still use bootstrap syntax.

The legacy file parser handles functions, externs, aliases, constants, static
scalars/arrays and nested/reopened namespaces, but not struct/enum declarations.
The replacement parser handles those declarations syntactically. Neither checks
types, resolves names or executes the input. There is **no L-written semantic
checker, code generator or self-hosted compiler** yet. Use the C pipeline to run
the supported replacement subset.

```sh
make stage1
./build/l run build/stage1-lexer.lbc < examples/answer.l
printf 'a = f(1, 2) + -3' | ./build/l run build/stage1-expression.lbc
printf '{ int sum=0; for(int i=0;i<3;i++) sum=sum+i; return sum; }' | ./build/l run build/stage1-statement.lbc
printf 'module app.main; import std.io; import app.types::{Pair as P,};' | ./build/l run build/stage1-header.lbc
./build/l run build/stage1-function.lbc < examples/answer.l
printf 'module app.main; pub using Count=int; namespace math{pub Count answer(){return 42;}}' | ./build/l run build/stage1-function.lbc
printf 'module app.data; pub const int answer=42; namespace buffers{static byte data[8];}' | ./build/l run build/stage1-function.lbc
printf 'module app.main; int main(){return let var x=40; in x+2;}' | ./build/l run build/stage1-binding.lbc
printf 'module app.main; int main(){return if true then 42 else 0;}' | ./build/l run build/stage1-binding.lbc
node tests/stage1.mjs ./build/l
node tests/stage1-expressions.mjs ./build/l
node tests/stage1-statements.mjs ./build/l
node tests/stage1-headers.mjs ./build/l
node tests/stage1-functions.mjs ./build/l
node tests/stage1-bindings.mjs ./build/l
```

The initial scanner has a 65535-byte input buffer and inherits the VM's execution
limits. Independent regex/BigInt models check token kinds, raw spans, byte-based
locations, decimal magnitudes, decoded strings, failures and reset/replay behavior
through both source and serialized execution. `make test`, sanitizers, Nix and
the Stage 0 coverage runner include these tests. The expression parser adds a
2048-node arena, a 48-level recursion bound, retained string bytes and independent
AST checks using shunting-yard precedence models and generated trees. The
statement parser adds a separate 1024-node arena for blocks, local declarations,
control flow and switch labels; expression/statement recursion shares one 48-level
syntax budget. Local declarations record types, names, `const`, scalar initializers
and array-length expressions without resolving or evaluating them.
The header parser records dotted module paths, import aliases and selective
imports in a separate 2048-node arena. Its streaming entry point stops at the first
body token; its standalone driver accepts header-only input, not full source files.
The function-file parser composes headers, namespaces, signatures and bodies
without resolving types or executing input. Its separate 1024-node arena records
namespace/function/parameter/alias/storage metadata; the shared expression and statement budgets
cover the whole file. Namespaces share the same 48-level syntax-depth budget as
their bodies; reopening and type aliases are recorded syntactically, not resolved.
Global initializers and static-array lengths are expression nodes, never evaluated;
the parser does not allocate or initialize the input's storage.
**100% coverage gate still measures Stage 0 C code**, not L-source coverage. These
legacy parser slices do not implement compilation. The replacement driver remains
syntax-only too, even though Stage 0 now executes the bounded subset described
above; artifacts remain at **1.9**.

## Supported subset

Here is what Stage 0 can actually compile. This includes the bootstrap syntax and
the merged replacement forms above; it is not the whole planned language. The
broader syntax accepted by Stage 1 is a separate list, not a promise of execution.

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
- Eager/sequential `let/in` with inferred/annotated scalar or nominal record/struct
  bindings and results, lexical shadowing and explicit mutable `var`.
- Bool-conditioned `if … then … else …` expressions with exactly matching scalar
  or nominal aggregate results and selected-branch execution.
- Fixed local `int`/`bool`/`byte` arrays: `int values[10];`, indexing and element
  assignment with runtime bounds checks; lengths may be compile-time expressions.
- Direct calls, forward function references, recursion and value parameters.
- Explicitly typed Nix-style definitions, complete direct application and
  imperative `do` function bodies, with `var name[: Type] = expr;` locals,
  `for (var ...)` initializers, `for name in start..end: do { ... }` ranges and
  `while condition: do { ... }` loops; legacy C-style bodies remain compatible.
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

Still missing: other primitive types, dynamic strings, file/network I/O,
nested/array-field structs, pointers/slices, ownership/borrows, generics/concepts,
dynamic values, GC, classes, effects, native/LLVM output, self-hosting and
build/package management. Those are not hidden behind a flag; they are not
implemented here yet.

## Modules and manifests

Module behavior follows [the normative module-system specification 0.1.1](spec/module-system-v0.1.1.md)
for the currently implemented declaration and type subset. This does not add
classes, aggregate globals, generic constraints or runtime overload
resolution. Public function signatures may contain public primitives and public
struct/enum types, but must not expose private nominal types. Public constants,
statics and struct fields must also expose only publicly accessible types.

Every source command needs `--manifest FILE.json`. There is no fallback search for
a manifest, module directory, standard library or dependency. Manifest version 1
has exactly these required fields:

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

The example uses the bootstrap `using Name = Type;` spelling. The preferred
replacement is `Name = alias Type;`; both declare the same transparent alias at
module or namespace scope.
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

`byte(intExpr)` evaluates its operand once and traps outside 0..255. It does not
quietly truncate or wrap. `int(byteExpr)` widens without loss. Those are the only
conversions in this slice, and each takes exactly one operand.
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

The comma-separated `Type{...}` form in this bootstrap example supplies one value
per field in declaration order; a trailing comma is fine. Structs also accept
`Type { field = value; ... }`, which checks labels and evaluates values in written
order. New record declarations require that named form. Neither spelling reorders
evaluation. Local bindings require explicit initialization; `auto` may infer a struct type.
Assignment, parameter passing and returns copy every field. Mutating a callee's
parameter or a returned copy never changes its caller's original value.

`.field` reads work on bindings and temporary values. Field assignment and integer
postfix updates require a mutable local/parameter root; `const` bindings protect
all fields. Whole-value assignment also respects `const`. Struct equality and
implicit conversions between nominal types are not supported.

`let` bindings and conditional results use the same copies. A plain `let` binding
protects field writes like `const`; a `var` binding permits mutation. A temporary
result is readable, not a reference that can be used to mutate its source.

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

This example uses the bootstrap enum spelling. The replacement form is
`Name = enum { Member; ... };`: use semicolons instead of commas. Both forms
declare the same kind of nominal enum.

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

Legacy `const Type name` constants require explicit `int`/`bool`/`byte`/`string`
types (or transparent aliases to them) or enum types, and scalar initializers.
The executable replacement spelling `[pub] name: Type = expression;` currently
supports only types resolving to `int` or `bool`, with the same evaluator/rules.
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

`make test` checks more than whether a program happens to return 42. It compares
source and serialized execution, checks IR roundtrips and reproducible output,
and makes sure invalid programs fail in the right way.

At merged compiler snapshot `e2ca42a3`, the main results are:

| Check | Result |
| --- | --- |
| Executable replacement syntax | 620 fixtures / 3458 CLI checks |
| Modules and cross-package models | 12671 checks |
| Bounded semantic models | 4396 programs / 13091 VM executions |
| Bytecode mutation corpus | 31966 inputs, parsed and verified rather than executed |
| Verifier path models | 2560 graphs, verification only |
| Stage 0 C coverage | 2722/2722 lines, 165/165 functions, 2804/2804 branches; all 11 files |

The [resulting-main run](https://github.com/flakesonnix/l/actions/runs/44551718137)
passed all four jobs. Native, local Nix, merge-gate hosted and resulting-main
coverage reports match. That is **100% Stage 0 C coverage**, not L-source coverage
and certainly not a proof that the compiler is correct.

The models are deliberately separate from the implementation: BigInt arithmetic,
byte buffers, lexical cells and explicit effect counters give us something else
to compare against. Arbitrary bytecode mutants and possibly cyclic verifier
graphs never run in the VM. Executed programs are bounded and have known results,
traps or resource-limit expectations.

<details>
<summary>What the individual model suites exercise</summary>

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
These tests preserve the existing source syntax and IR/bytecode format **1.9**.
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
The replacement suites also cover typed name-first constants, transparent aliases,
namespace reopening, nominal enums, named-field order/copies and scalar
`let`/conditional expressions. The newest scalar slice adds 384 independent
byte/string/enum cell-and-effect models, 32 package DAGs in both import/root orders,
and 16 rejection/cleanup/recompile cycles. Record tests keep their 128 six-field
models and 32 package DAGs. Neither set replaces the older tests above.
Aggregate-expression tests add 256 six-field copy/cell/effect models across both
declaration spellings, 32 package DAGs in both import/root orders and 16 more
rejection/cleanup/recompile cycles. They check snapshots before mutation and
same-nominal-type branch results without weakening the scalar or verifier tests.
Nix-function tests add 256 eager-call/branch/bounded-loop models across new and
legacy helper spellings, 32 package DAGs in both import/root orders, and 16
rejection/cleanup/recompile cycles with source/serialized trap recovery. They
also check precedence, full arity, overloads, scalar/nominal types and the shared
parameter/function budgets. Name-first local binding tests add 256 inferred,
annotated, loop and shadowing models across new/legacy spellings and 16 more
rejection/cleanup/recompile cycles. Range-loop tests add 128 half-open iteration
models (nested loops, `break`/`continue`, bound effects and empty ranges), 32
package DAGs in both import orders and 16 rejection/cleanup/recompile cycles.
Nix `while` tests add 128 bounded-condition, break/continue, nested and
early-return models, 32 package DAGs in both import orders and 16
rejection/cleanup/recompile cycles. Grouped-while regressions add 128 models of
condition effects and Nix/C body spellings, grouped variants of those same 32
package DAGs in both orders, and 16 cleanup/recompile cycles with trap recovery.
None replaces the earlier suites, and no
arbitrary bytecode mutants are executed.

</details>

`make sanitize` builds and tests with AddressSanitizer and UndefinedBehaviorSanitizer.
`make coverage` measures all stage-0 C files without source exclusions and fails
below 100% line, function **or branch coverage**. It also runs fault-injection,
verifier and bytecode-mutation tests. The report is `build/coverage/report.json`.
The same snapshot also passes 842 integration checks, 182 frontend cases, 52 fault
cases, 319 verifier cases plus format mutations, and 132 observer cases. These are
different kinds of checks, not percentages to add together. Passing them does not
make this a complete or conforming L implementation.
