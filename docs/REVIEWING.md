# Reviewing the GitHub stack

This is the review record for [flakesonnix/l](https://github.com/flakesonnix/l),
not another language specification. It tells you what reached `main`, which
commits were kept, and where to check the results.

The original GitHub baseline was `e081fb3` (literal-backed strings, bytecode 1.7).
It is not today's `main`. That history, including the array reference `f9284b1`,
is still reachable. Current IR/bytecode is **1.9**.

## Review status

The executable replacement stack through **#37 is merged**, ending at
**`e2ca42a3`**. Constants, aliases, namespaces, enums, named-field records and
scalar `let`/conditional values now run through the existing C compiler.
The L-written frontend still checks syntax; merging these features did not make
it a self-hosted compiler.

The docs refresh (#38) and aggregate-expression extension (#39) remain separate,
open reviews. The Nix-function slice builds on #39 without merging either one.
It moves the surface syntax toward Nix-style definitions/application, with
imperative loops/mutation, while retaining direct calls and the existing backend.
No merge authorization beyond the completed #32–#37 sequence is implied.

| Review | Preserved head branch | Original head | Merge / resulting-main CI |
| --- | --- | --- | --- |
| [Execution #30](https://github.com/flakesonnix/l/pull/30) | `review/replacement-execution` | `02d7dc2` | [`ac49375`](https://github.com/flakesonnix/l/actions/runs/43605162891) |
| [Conditionals #31](https://github.com/flakesonnix/l/pull/31) | `review/replacement-conditionals` | `c34893b` | [`8c847bc`](https://github.com/flakesonnix/l/actions/runs/43607890204) |
| [Constants #32](https://github.com/flakesonnix/l/pull/32) | `review/replacement-constants` | `4e747bb` | [`2c437e6`](https://github.com/flakesonnix/l/actions/runs/44479913164) |
| [Aliases #33](https://github.com/flakesonnix/l/pull/33) | `review/replacement-aliases` | `9dfd9a4` | [`79aa8aa`](https://github.com/flakesonnix/l/actions/runs/44483954259) |
| [Namespaces #34](https://github.com/flakesonnix/l/pull/34) | `review/replacement-namespaces` | `674fea3` | [`af9cd51`](https://github.com/flakesonnix/l/actions/runs/44490180822) |
| [Enums #35](https://github.com/flakesonnix/l/pull/35) | `review/replacement-enums` | `c2c14f0` | [`ec7eeb0`](https://github.com/flakesonnix/l/actions/runs/44539250861) |
| [Records #36](https://github.com/flakesonnix/l/pull/36) | `review/replacement-records` | `e98b7a0` | [`a69851c`](https://github.com/flakesonnix/l/actions/runs/44545187924) |
| [Scalar expressions #37](https://github.com/flakesonnix/l/pull/37) | `review/replacement-scalar-expressions` | `21bd204` | [`e2ca42a`](https://github.com/flakesonnix/l/actions/runs/44551718137) |

For #32–#37, each merge had fresh native test, fuzz, sanitizer, coverage and
rebuild checks, full Nix checks, and a four-job hosted merge-gate run. After each
merge, its four resulting-main jobs passed **before the next PR was retargeted**.
That is 48 passing hosted jobs across the six fresh gates and six main runs,
separate from the earlier push/PR checks.

The prospective, feature and actual merge trees matched at every step. Original
commits and all six review branches were kept; there was no force push, squash,
rebase, branch deletion or protection bypass.

Final coverage at `e2ca42a3` is **2722/2722 C lines, 165/165 functions and
2804/2804 branches**, across all **11 Stage 0 C files**, with no missing entries
or source exclusions. Downloaded main artifact `14543317010` exactly matches the
fresh native, local Nix and hosted merge-gate reports. This is not L-source
coverage, and a green percentage is not a correctness proof.

These merges were explicitly authorized despite absent independent approval.
The [author COMMENT merge-gate review](https://github.com/flakesonnix/l/pull/37#pullrequestreview-5977622963)
and [final main verification](https://github.com/flakesonnix/l/pull/37#issuecomment-7013511070)
record that distinction. Author self-reviews and separate-agent audits are useful,
but neither counts as independent GitHub approval. The authorization covered
these PRs, not whatever comes next.

### Initial stack (merged)

The bases here explain the original order. They are not instructions to merge
new work into those feature branches. Review-only merge commits carried the CI
foundation forward without rewriting the implementation commits.

| Order | Review | Head branch | Initial base | Original implementation |
| --- | --- | --- | --- | --- |
| 1 | [CI #1](https://github.com/flakesonnix/l/pull/1) | `review/ci` | `main` | `42bbba8`, `b11fd3d` |
| 2 | [Byte I/O #2](https://github.com/flakesonnix/l/pull/2) | `review/byte-io` | `review/ci` | `c8b2ea4` |
| 3 | [Static buffers #3](https://github.com/flakesonnix/l/pull/3) | `review/static-buffers` | `review/byte-io` | `e6e264f` |
| 4 | [Buffer models #4](https://github.com/flakesonnix/l/pull/4) | `review/buffer-models` | `review/static-buffers` | `3183c5a` |
| 5 | [VM observer #5](https://github.com/flakesonnix/l/pull/5) | `review/vm-observer` | `review/buffer-models` | `a9fb490` |
| 6 | [Nix flake #6](https://github.com/flakesonnix/l/pull/6) | `review/nix-flake` | `review/vm-observer` | `9287094`, `80b802b` |
| 7 | [Documentation #8](https://github.com/flakesonnix/l/pull/8) | `review/docs` | `review/nix-flake` | `a1c639f` |

### CI and L-written frontend (reviewed history)

| Review | Preserved head branch | Integrated commit |
| --- | --- | --- |
| [CI concurrency #9](https://github.com/flakesonnix/l/pull/9) | `review/ci-concurrency` | `850f008` |
| [Lexer #10](https://github.com/flakesonnix/l/pull/10) | `review/stage1-lexer` | `530f7af` |
| [Expressions #11](https://github.com/flakesonnix/l/pull/11) | `review/stage1-expressions` | `bc8f343` |
| [Statements #12](https://github.com/flakesonnix/l/pull/12) | `review/stage1-statements` | `c1d9508` |
| [Local declarations #13](https://github.com/flakesonnix/l/pull/13) | `review/stage1-local-declarations` | `be0a777` |
| [Module/import headers #14](https://github.com/flakesonnix/l/pull/14) | `review/stage1-module-headers` | `6ab20be` |
| [Function files #15](https://github.com/flakesonnix/l/pull/15) | `review/stage1-functions` | `4ce64b8` |
| [Namespaces #16](https://github.com/flakesonnix/l/pull/16) | `review/stage1-namespaces` | `562fcad` |
| [Type aliases #17](https://github.com/flakesonnix/l/pull/17) | `review/stage1-type-aliases` | `45493c6` |
| [Global storage #18](https://github.com/flakesonnix/l/pull/18) | `review/stage1-global-storage` | `20881dc` |
| [Syntax-status docs #19](https://github.com/flakesonnix/l/pull/19) | `review/docs-syntax-status` | `a0d33e3` |
| [Replacement bindings #20](https://github.com/flakesonnix/l/pull/20) | `review/stage1-nix-bindings` | `c98fb6f` |
| [Conditional expressions #21](https://github.com/flakesonnix/l/pull/21) | `review/stage1-conditionals` | `6af87d9` |
| [Named record syntax #22](https://github.com/flakesonnix/l/pull/22) | `review/stage1-records` | `b54f278` |
| [Transparent alias bindings #23](https://github.com/flakesonnix/l/pull/23) | `review/stage1-alias-bindings` | `3655330` |
| [Namespace bindings #24](https://github.com/flakesonnix/l/pull/24) | `review/stage1-namespace-bindings` | `b2f53ea` |
| [C-style functions #25](https://github.com/flakesonnix/l/pull/25) | `review/stage1-c-functions` | `730ded9` |
| [Const parameters #26](https://github.com/flakesonnix/l/pull/26) | `review/stage1-const-parameters` | `559e535` |
| [Enums and structs #27](https://github.com/flakesonnix/l/pull/27) | `review/stage1-enum-struct` | `9d22966` |
| [Static/extern declarations #28](https://github.com/flakesonnix/l/pull/28) | `review/stage1-static-extern` | `7ac48d4` |

<details>
<summary>Earlier parser merge-gate evidence</summary>

PRs #13–#18 received COMMENT reviews and merged in dependency order with original
heads and tested trees preserved. Fresh test/coverage runs and all eight PR-head
jobs passed at #18; its [resulting-main run](https://github.com/flakesonnix/l/actions/runs/43041429246)
was checked separately.

The later replacement-parser gates recorded these snapshots:

| PR | Tested head | Replacement-parser fixtures | Resulting-main CI |
| --- | --- | --- | --- |
| #20 | `9da4083` | 178 | [passed](https://github.com/flakesonnix/l/actions/runs/43280312128) |
| #21 | `cb3ea2f` | 285 | [passed](https://github.com/flakesonnix/l/actions/runs/43292967995) |
| #22 | `637e67b` | 389 | [passed](https://github.com/flakesonnix/l/actions/runs/43403721928) |
| #23 | `e3ff752` | 467 | [passed](https://github.com/flakesonnix/l/actions/runs/43407994500) |
| #24 | `45a7f60` | 572 | [passed](https://github.com/flakesonnix/l/actions/runs/43425640628) |
| #25 | `75dcab8` | 659 | [passed](https://github.com/flakesonnix/l/actions/runs/43438650628) |
| #26 | `0c123d2` | 738 | [passed](https://github.com/flakesonnix/l/actions/runs/43457333621) |
| #27 | `510beb1` | 856 | [passed](https://github.com/flakesonnix/l/actions/runs/43459608292) |
| #28 | `a0214f8` | 1043 | [passed](https://github.com/flakesonnix/l/actions/runs/43462349847) |

Each had an author COMMENT merge-gate review, passing PR-head checks and matching
prospective/actual/tested trees. #27 and #28 were retargeted only after their
dependencies merged; their [#27 retarget run](https://github.com/flakesonnix/l/actions/runs/43457488482)
and [#28 retarget run](https://github.com/flakesonnix/l/actions/runs/43459673707)
also passed. At #28, the binding suite made 366266 modeled checks, and native /
installed six-driver checks and README examples passed.

The old **2596 lines / 163 functions / 2660 branches** coverage figure belongs to
that #28 snapshot, not the current compiler. All were hit, across 11 C files,
with no missing entries. The original commits, `f9284b1`/`e081fb3` ancestry and
remote review heads were retained. No force push, branch deletion or protection
bypass was used.

One useful detail from #20: the local watcher timed out, but the hosted run
succeeded. A watcher timeout is not a failed CI run. Check the run itself.

</details>

The early L-written parsers handle bootstrap syntax. They record declarations,
bodies and metadata, not resolved programs. The replacement parser adds enums,
structs and static/extern syntax, but still does not evaluate initializers,
allocate the input's storage or generate code. The executable features above use
the C frontend instead. Keep those two claims separate.

Byte I/O and static arrays did change artifact versions, so older bytecode needs
recompilation. The observer is an optional C embedding API, not an L intrinsic or
trace file format. See the [compatibility table](DEVELOPMENT.md#artifact-compatibility).

## Merge procedure

A green PR is the start of the merge check, not the end of it.

1. Record the exact head. Read the diff and review conversations, post actual
   GitHub review comments, and fix blocking findings. Do not count an author
   self-review or agent audit as independent approval.
2. Wait for dependencies to reach `main`. Then retarget this PR to `main` and
   check the new diff and exact-head results. Merge permission must cover this
   PR; an earlier authorization is not permission to merge future work.
3. Run `git merge-tree --write-tree origin/main <head>` and compare the tree with
   `<head>^{tree}`. If they differ, test the combined tree. The branch's old green
   checks do not cover a different merge result.
4. Use **Create a merge commit**, matching the reviewed head. Do not bypass branch
   protection, squash/rebase the stack, or enable unattended auto-merge.
5. Fetch the result. Check both parents, the actual tree, retained original
   commits and the new `main` CI run. Keep the review branches. Only then move to
   the next PR.

Do not merge a stacked PR into its feature-branch base just because GitHub offers
the button. Do not force-push, reset history or change protection to make the gate
go away. If a required independent review is missing, that is a blocker.

For a new stack, substitute the actual PR number and head branch:

```sh
gh pr edit <number> --repo flakesonnix/l --base main
gh workflow run ci.yml --repo flakesonnix/l --ref <head-branch>
gh pr checks <number> --repo flakesonnix/l
```

Manual dispatch gives the retargeted slice a fresh run rather than relying on
old push/PR results. The workflow is already on the default branch and also runs
on `main`, `review/**` pushes and pull requests. Check the resulting-main run
separately; passing a feature-head run does not prove that run passed.

## What to check

- **Core behavior:** exact types, eager left-to-right evaluation and the normative
  module rules. No silent laziness, dynamic lookup or implicit module discovery.
- **I/O and buffers:** EOF, every byte value, reported stream failures, shared
  array identity, bounds and fresh storage after traps or successful runs.
- **Observers:** event order and arm identity, NULL-observer behavior and unchanged
  execution budgets. Observing a program must not change its result.
- **Nix and CI:** pinned inputs, installed manifests, actual platform coverage,
  sanitizer results and the 100% C coverage gate.
- **Stage 1:** arena ownership, first-error rollback, shared budgets and
  source/bytecode model agreement. Parsing syntax is not checking semantics.
- **Constants:** legacy/name-first folding agreement, int/bool-only name-first
  types, forward references, cycles, readonly/import rules and shared limits.
  Constants must not add VM storage or hidden runtime initialization.
- **Aliases:** primitive identity, forward/imported targets, cycles, duplicate
  signatures, erasure and contextual `alias` compatibility.
- **Namespaces:** nesting/reopening, relative and qualified lookup, member `pub`
  and shared cells. Reject namespace-level `pub` and runtime namespace values.
- **Enums:** required semicolons, nonempty nominal types, checked int32 values,
  equal-valued members, duplicate switch cases, visibility and shared budgets.
- **Records:** complete/exact field sets, scalar types, nominal identity, copies
  and readonly writes. Run initializers in written order, including unused fields
  and nested calls. Map the resulting registers; do not sort the AST. Preserve
  legacy positional assignments and require named literals for new records.
- **Value expressions:** exact scalar types and same-nominal aggregate types,
  alias transparency, lexical effects and selected branches. Aggregate bindings
  and branch temporaries must copy values, not alias cells; snapshots must survive
  later field or whole-value writes. Preserve readonly checks, whole-array/void
  rejection, explicit conversions and compile-time restrictions.
- **Nix-style functions:** adjacent matching signatures/definitions, exact
  parameter/result types, full direct-call arity and left-to-right arguments.
  Check application precedence/grouping and zero-argument `f ()`, including
  cross-spelling/imported/overloaded calls. `do` is only a contextual whole-body
  marker; preserve C-body parsing and shared function/parameter budgets. No
  first-class functions, partial application, closures or new runtime metadata.
+  Name-first local `var` declarations must remain contextual to Nix bodies,
+  require an initializer, infer or check the written type, and reuse ordinary
+  mutable slots/scopes including `for` initializers and shadowing. C declarations
+  and `let var` must keep working. Range loops must evaluate both int bounds
  once, left to right, before binding a fresh loop local; check half-open
  iteration, empty/reversed ranges, nesting, `break`/`continue`, mutation of the
  counter and C-body rejection. There is no step/iterator/lazy-sequence feature.
- **Evidence:** coverage measures Stage 0 C only. Arbitrary bytecode mutants and
  cyclic verifier graphs must never execute. Local results and hosted check runs
  are separate evidence; record the exact commit for each.

## Approved syntax replacement

The syntax is a typed hybrid: C-style functions and control flow, with selected
Nix-inspired bindings and expressions. The function form is
`pub int add(int a, int b) { return a + b; }`, not the old arrow proposal.
C locals are mutable unless `const`; `let` bindings are immutable unless `var`.
Leading parameter `const` records readonly intent without creating a new type or
overload signature. Stage 0 enforces writes and type identity; the L-written
parser only records them.

Conditionals use `if condition then value else value`, with a mandatory `else`,
bool condition and matching scalar or same-nominal aggregate results. Only the
selected branch runs.
Records use `Name = record { field: Type; };` and named literals
`Name { field = value; }`. They are nominal, copied by value, and evaluate fields
in written order. `struct Name { Type field; };` is the other approved aggregate
declaration spelling.

Enums use `Name = enum { Member; Member = expr; };`, with semicolon-terminated
members. Aliases use `Name = alias Type;` and stay transparent scalar aliases.
Namespaces use `Name = namespace { declarations };`; export each member, not the
namespace itself. Static scalars/arrays and extern functions keep their C-style
spellings, including leading `const` on extern parameters.

The C frontend implements the supported semantics. The L-written parser records
the broader grammar without resolving names, expanding aliases, merging scopes,
checking enum values, allocating storage or binding extern implementations. Old
sources and parser contracts still use bootstrap syntax while migration is in
progress. Adding enum/struct declarations to the legacy Stage 1 grammar remains
deferred behind replacement work.

Review source migration separately from parser work. Keep static types, eager
evaluation, explicit module semantics and IR/bytecode **1.9** intact. For the
current executable boundary, use the [README](../README.md#source-syntax-status).
