# Building and testing Stage 0

Stage 0 is the C11 compiler and bytecode VM. Stage 1 is the L-written frontend
work in progress. If you want to run a program today, use Stage 0; piping that
program into the Stage 1 binding driver only checks its syntax.

`main` now includes the executable replacement stack through **#37**, merged at
`e2ca42a3`. That means C-style functions/control flow, scalar `let` and conditionals,
typed name-first constants, aliases, namespaces, enums and named-field records.
The [README](../README.md#source-syntax-status) spells out the supported subset and
what is still missing. The bootstrap sources keep their old spelling for now.
The aggregate-expression slice builds on that snapshot: records/structs can be
`let` bindings/results and conditional results using the existing by-value path.
It does not add aggregate globals, arrays or nested aggregate fields.
The Nix-function slice adds explicit signatures, colon-parameter definitions,
complete direct application and imperative `do` function bodies. C-style
functions keep their original grammar; new bodies use Nix-style calls to either
kind. Inside `do`, `var name[: Type] = expr;` and `for (var ...)` are name-first
spellings of the existing mutable local declaration. `for i in a..b: do { ... }`
is a half-open int range desugared into the same counting-loop AST, and
`while cond: do { ... }` is the Nix spelling of the existing condition loop. The semantic checker,
backend and L-written parser sources are unchanged. The goal is Nix-based
surface syntax with loops/mutation, not lazy evaluation, currying or a second
compiler.

The important bits have not changed: static types, eager left-to-right evaluation,
explicit manifests, [module rules](../spec/module-system-v0.1.1.md), and bytecode
**1.9**. This is not a self-hosted compiler or a complete L 0.1 implementation.

## Checkout and prerequisites

Run these commands from the repository root. The old 1.7 baseline is history,
not the current checkout. For the merged commits and their CI evidence, see
[REVIEWING.md](REVIEWING.md).

Native builds need a C11 compiler and GNU Make. Tests also need Node.js 22 or
newer and a POSIX shell. Coverage needs GCC and its matching gcov. The fault tests
use Linux facilities such as `/dev/full`, directory-read errors and GNU linker
wrapping. Sanitizers need compiler/runtime support for AddressSanitizer and
UndefinedBehaviorSanitizer.

## Native workflow

```sh
make
make test
make fuzz
make sanitize
make clean
make coverage
make
```

`make test` already runs the deterministic fuzz/model suite. Use `make fuzz` when
that is the part you are working on.

One easy mistake: `make sanitize` changes the normal binary's compiler flags,
and Make does not track flag changes as dependencies. Run `make clean` before
going back to a normal build. Coverage uses a separate compiler under
`build/coverage/`.

Do not run these native suites at the same time in one checkout. They share
`build/` artifacts and temporary serialization paths. Separate CI jobs and Nix
derivations have isolated workspaces, so those can run in parallel.

The negative tests are supposed to print compiler errors and VM traps. Read the
exit status and final summaries before concluding that a wall of diagnostics is
a failure.

Coverage fails unless **every Stage 0 C line, function and branch** is hit. There
are no production-source exclusions. The report is `build/coverage/report.json`;
fuzz diagnostics and generated inputs go to `build/fuzz.log`. Arbitrary bytecode
mutants and possibly cyclic verifier graphs are checked, never executed. Programs
that do run have independently known results, traps or resource-limit expectations.

The three main places to look when adding a regression test are:

| Suite | What it gives you |
| --- | --- |
| `tests/replacement.mjs` | Real CLI checks, source/bytecode agreement, exact types, scopes, diagnostics, visibility, deterministic output and rejection without clobbering an existing file. |
| `tests/modules.mjs` | Cross-package DAGs, import/root reordering, shared nominal/storage identity and independent BigInt models. |
| `tests/fuzz.c` | Full-width value/effect models, lexical cells, selected branches, copies, traps, cleanup and successful retries. |

Keep the oracle separate from the compiler. Constants use host-side arithmetic;
scalar expressions track bytes, string content IDs and enum payloads; record
models track field order and copies. In particular, validating named fields must
not sort their initializer expressions. Alias erasure, reopened namespaces and
shared imports get their own checks rather than being inferred from one example.

At compiler snapshot `e2ca42a3`, the replacement suite passes **620 fixtures / 3458
CLI checks**, modules pass **12671 checks**, and the bounded semantic suite passes
**4396 programs / 13091 VM executions**. Coverage is **2722 lines / 165 functions /
2804 branches, all 100%, across 11 Stage 0 C files**. None of those numbers is
L-source coverage or evidence of self-hosting.

Aggregate-expression models now also check six-field copies, shadowing, mutation
and snapshots before writes, across both record/struct spellings. Conditional
results must keep the same nominal type; they are not structural unions. Void and
whole arrays remain invalid values, and neither `let` nor conditionals become
compile-time expressions. Keep those rejection tests too.
Nix-function models independently track eager call arguments, selected branches,
shared counters and bounded loops. Signatures must match their adjacent
definitions, and incomplete/extra arguments, closures and function values stay
rejected. Keep cross-spelling calls, precedence, parameter/function limits and
cleanup/retry checks as well as the earlier scalar/aggregate models. Name-first
local models check inferred/annotated locals, shadowing initializers and `for`
bindings in both new and legacy body spellings; readonly statements stay out of
scope. Range models check half-open iteration, nested loops, `break`/`continue`,
single evaluation of call bounds and empty ranges. Nix `while` models check
bounded conditions, break/continue, nesting, counter effects and early returns.
Grouped-condition regressions also check `while (condition): do { ... }`,
including nested groups, calls and `let`, without losing C-style loop bodies or
changing how often the condition runs. The module suite runs the same while
DAGs with bare and grouped conditions in both import/root orders.
Loop-body regressions reject non-block bodies after `: do` for bare/grouped
`while` and range loops, including imported modules in both source-root orders.
Forty-eight rejection/cleanup/recompile cycles then verify valid nested blocks
from source and serialized bytecode; C-style single-statement loops stay valid.
Infix-condition regressions continue a leading group through ordinary expression
operators, including precedence, short-circuit effects and assignment. They add
128 bounded loop models, infix variants of the existing while DAGs in both orders,
and 16 rejection/cleanup/recompile cycles with source/serialized trap recovery.
Ambiguous `+`/`-` C bodies are checked without speculative AST allocation;
delimiter lookahead respects nested groups, record/array syntax and typed `let`.
Postfix-condition regressions continue grouped bases through existing fields,
indexes and updates before the infix tail. They add 128 bounded effect/count models,
postfix variants of the same while DAGs, 16 rejection/cleanup/recompile cycles and
source/serialized trap recovery. Tests preserve record copies, readonly/lvalue
checks, array/string bounds, final-condition updates and C block/call bodies.
Grouped-callee regressions add 128 bounded call/count/evaluation-order models,
grouped-call variants of the same while DAGs and 16 rejection/cleanup/recompile
cycles with eager-argument trap recovery. They retain full arity, static overloads
and direct named calls only. Shared delimiter lookahead avoids speculative ASTs
and preserves declarations, conversions and named calls as legacy C bodies.
Grouped-constructor regressions add 128 bounded field-order/count models,
record variants of the same while DAGs and 16 rejection/cleanup/recompile cycles
with initializer trap recovery. The imported record variant has exactly one
shared nominal type; earlier variants retain zero nominal metadata. Lookahead
stops at the first constructor/block close before checking for a condition tail,
so a C block cannot borrow the colon of a later loop or typed declaration.
Unit-call postfix regressions add 128 bounded result/index/loop models, 16
rejection/cleanup/recompile cycles and source/serialized index-trap recovery.
The same typed-function DAGs also return their tick through one shared imported
record, retaining the independent arithmetic/counter oracle in both import/root
orders. Only complete `()` calls take result postfixes directly; nonempty calls
keep their argument tails, overload selection and full-arity restrictions.
Conditional-expression statements add 128 bounded condition/selected-branch
effect models, 16 rejection/cleanup/recompile cycles and discarded-result trap
recovery. Typed-function DAGs also branch their tick expressions without changing
the independent arithmetic/counter oracle. Non-void branch types, required `else`
and `;`, and explicit returns stay required. Token-only lookahead distinguishes
the outer `then` from nested expression-owned tokens and preserves C bodies,
optional/dangling `else` and following statement boundaries without a second AST.
Indexed-call statements add 128 bounded argument/index/declaration models, 16
rejection/cleanup/recompile cycles and source/serialized bounds-trap recovery.
The parser keeps one shared expression tree for the ambiguous named-array prefix;
normal name resolution chooses a declaration or a direct call before lowering.
Both statement and `for`-initializer contexts use this path; no parser arity lookup
or new AST kind is involved. Typed-function DAGs retain their tick oracle through
an indexed argument to a void helper, with one explicit local array and no new
global storage or nominal metadata. Array extents and whole-array restrictions stay.
Hash-comment models add 128 bounded programs with independently padded whitespace
controls for token kind/data and byte-based line/column positions, including EOF.
They cover both body styles, LF/CRLF, string hashes, misleading punctuation and
comment payload bytes. Sixteen rejection/cleanup/recompile cycles and trap recovery
retain lexer safety and fresh execution state. Typed-function DAGs also run with
comments before headers, between qualified names/calls and at EOF in both orders,
without changing the independent oracle or adding storage/types. The L-written
tokenizers keep their older comment contract; coverage remains Stage 0 C only.
Signature-scope models add 128 bounded alias/namespace/record/enum/string/byte/bool
programs, 16 rejection/cleanup/recompile cycles and source/serialized trap recovery.
Separate Nix signatures resolve without the later definition's parameter names;
body shadowing and C parameter-list scope are unchanged. A private AST flag records
this distinction and is not serialized. Typed-function DAGs also route their tick
addition through a helper whose first parameter shadows an imported type qualifier,
retaining the same independent arithmetic/counter oracle, storage and nominal types.
Manifest-prefix models cover 128 invalid-prefix rejection/cleanup/valid-manifest
recompile cycles, checking decoded canonical names against independently generated
ASCII names and bounded arithmetic results from source/serialized programs. CLI
fixtures reject whitespace/comments in unused roots in both registration orders,
including JSON-escaped trivia, without replacing an existing output. Empty prefixes,
escaped identifier characters, ordinary JSON formatting and valid resolution stay.
Var-parameter boundary models add 128 malformed-C-parameter rejection/cleanup/
valid-recompile cycles. Typed/readonly C parameters, Nix `var` locals and `for`
initializers, C `let var`, declaration order and bounded results stay intact.
Source/serialized trap recovery checks fresh state across the mixed body styles.
The shared declaration helper gates name-first locals on the Nix-body mode, so
that path cannot silently extend C parameter lists or imported/extern signatures.
Inspection-output tests use 16 deterministic instruction-count models and one
listing larger than 1 MiB. Source/serialized listings must agree without executing
their division-by-zero entry points. `/dev/full` covers buffered flush failures
and already-failed writes; closed pipes must return file-error status 74, not a
signal or success. Inputs/artifacts stay unchanged, and fresh compile/inspect
commands recover. The CLI checks stdout after inspection; IR/bytecode stays 1.9.

## Nix workflow

`flake.lock` pins nixpkgs. Outputs exist for `x86_64-linux` and `aarch64-linux`.
So far, x86_64 has been built and tested locally; aarch64 has only been evaluated.
Evaluation is useful, but it is not a test run on that architecture.

```sh
nix develop
make test
exit

nix build
nix run . -- check examples/answer.l --manifest examples/package.json
nix flake check --print-build-logs
nix flake check --all-systems --no-build
nix fmt flake.nix
```

The shell supplies the compiler, Make, Node.js, Git, GitHub CLI, nixfmt and
actionlint. `nix flake check` runs regular package and installation tests, separate
sanitizer/coverage builds, Nix formatting and workflow lint. Installed tests run
all thirteen replacement examples from source and bytecode.

Coverage builds at `-O0`, so its derivation and the development shell disable
glibc fortification. The installed compiler keeps the standard Nix hardening
settings; the exception is for instrumentation, not the shipped package.

`nix build` creates `result/bin/l` and installs the examples, standard library,
specification, README, development/review guides and Stage 1 sources under
`result/share/l/`. Installed manifests retain their relative source roots:

```sh
./result/bin/l check ./result/share/l/examples/io_demo.l \
  --manifest ./result/share/l/examples/package.json
```

Nix does not create implicit module search paths. Source commands always need an
explicit manifest; compiled bytecode does not.

## CLI examples

```sh
./build/l check examples/answer.l --manifest examples/package.json
./build/l compile examples/answer.l --manifest examples/package.json -o build/answer.lbc
./build/l inspect build/answer.lbc
./build/l run build/answer.lbc
```

The last command intentionally exits with 42. Program results are reduced modulo
256. Errors use 64 for usage, 65 for compilation/format errors, 70 for VM traps,
71 for startup allocation failure and 74 for file errors. A program can return one
of those numbers too, so read stderr rather than guessing from the status alone.

For binary-safe input/output through shared static storage:

```sh
printf 'abc' | ./build/l run examples/static_buffers.l --manifest examples/package.json
```

This emits `cba` without adding a newline. Standard stream intrinsics preserve
bytes, including NUL and values above 127; they do not perform text conversion.

## Artifact compatibility

| Slice | IR/bytecode | Migration |
| --- | --- | --- |
| Literal-backed strings baseline | 1.7 | Exact-version loading; `string` is reserved. |
| Byte-oriented standard I/O | 1.8 | Recompile older artifacts; `extern` is reserved. |
| Static arrays | 1.9 | Recompile older artifacts; globals gain length metadata. |
| Models, observers, Nix and CI | 1.9 | No additional syntax or artifact-format change. |
| Syntax-only Stage 1 frontend | 1.9 | Provisional in-memory ASTs; no serialized AST format. |
| Replacement function/binding parser | 1.9 | Syntax-only migration slice; Stage 0 source compilation remains legacy. |
| First executable replacement subset | 1.9 | C frontend adds scoped `let/in` and reserves `let`, `in`, `var`; existing backend/VM reused. |
| Executable conditional expressions | 1.9 | Bool conditions, matching int/bool results and selected-branch execution; `then` becomes reserved. |
| Executable name-first constants | 1.9 | Written int/bool types (including transparent aliases), existing compile-time evaluation; no VM storage, keywords or module-format changes. |
| Executable name-first aliases | 1.9 | Existing transparent int/bool/byte/string resolution; contextual `alias`, no new reserved word, runtime type or artifact change. |
| Executable name-first namespaces | 1.9 | Existing compile-time scopes, reopening and member visibility; mandatory trailing `;`, no runtime namespace value or initialization. |
| Executable name-first enums | 1.9 | Existing nominal-enum semantics, checked int32 values and shared limits; each member requires `;`, legacy comma-separated enums retained. |
| Executable named-field records | 1.9 | Existing nominal value-struct metadata/VM; validate field names and map written-order results to declaration indexes, no new runtime representation. |
| Scalar `let`/conditional expressions | 1.9 | Extend runtime values to byte/string/nominal enums and primitive aliases; exact types, existing slots/branches/VM, no aggregate or compile-time expression expansion. |
| Aggregate `let`/conditional expressions | 1.9 | Nominal record/struct values use existing by-value slots and branch temporaries; no new runtime representation, aggregate arrays/globals or compile-time expression expansion. |
| Typed Nix-style direct functions | 1.9 | Adjacent explicit signatures/definitions, colon parameters, direct application and imperative `do` function bodies lower to existing function/call/return ASTs; no function values, closures, currying or new runtime representation. |
| Name-first local `var` bindings | 1.9 | Contextual `var name[: Type] = expr;` locals and `for` initializers in Nix bodies reuse existing mutable declaration slots/scopes; no new readonly statement or runtime behavior. |
| Half-open range loops | 1.9 | `for i in a..b: do { ... }` desugars to two evaluated int bounds plus the existing counting loop; no iterator, lazy sequence, step expression or new runtime type. |
| Nix-style condition loops | 1.9 | `while cond: do { ... }` reuses the existing condition-loop AST and scope; C `while(cond)` remains valid in both body styles. |

The version table is history, not a list of formats the loader still accepts.
Only the exact current version loads, even when a program does not use the newest
feature. Recompile old artifacts. The [C observer API](../README.md#vm-execution-observation)
does not add a trace file format.

## Continuous integration

The workflow in [`.github/workflows/ci.yml`](https://github.com/flakesonnix/l/blob/main/.github/workflows/ci.yml) checks
regular tests, sanitizers and coverage in separate Ubuntu jobs with GCC and
Node.js 22. A separate job runs the pinned Nix checks. The workflow is active on
`main`, `review/**` pushes, pull requests and manual dispatches. Push, PR and manual
runs use separate concurrency groups; only superseded runs of the same trigger
and branch/PR cancel one another.

Actions are pinned to full commit IDs, repository permissions are read-only, and
checkout credentials are not persisted. Coverage reports and failure diagnostics
are retained briefly as artifacts. No publishing credentials or repository
secrets are needed.

A local pass is not a GitHub pass. Check the hosted run's exact commit and
conclusion; an earlier green head says nothing about a later change. Check
resulting-main CI separately after merging. The [review guide](REVIEWING.md) has
the full merge procedure and evidence for the completed stack.
