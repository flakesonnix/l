# Reviewing the GitHub stack

The repository is [flakesonnix/l](https://github.com/flakesonnix/l). The original
GitHub baseline was `e081fb3` (literal-backed strings, IR/bytecode 1.7), not the
current `main`. Earlier compiler history, including the array reference `f9284b1`,
remains unchanged and reachable. Current IR/bytecode is **1.9**.

## Review status

The initial stack and Stage 1 PRs through **#21 are merged**. The latest reviewed
feature merge is `6af87d9`, integrating conditional-parser head `cb3ea2f`.
GitHub COMMENT self-reviews are recorded as such; they are **not independent
approvals**. Later documentation or syntax changes need their own review.
The syntax-status documentation in [#19](https://github.com/flakesonnix/l/pull/19)
is also reviewed and merged at `a0d33e3`; its resulting main CI passed.

### Initial stack (merged)

The initial bases below explain the review order, not today's merge targets.
Original feature commits were retained in repository history; review-only merge
commits carried the CI foundation forward without rewriting those commits.

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

PRs #13–#18 received GitHub COMMENT reviews before merging in dependency order.
Each prospective merge tree and actual merge tree matched its already-tested PR
head; the original commits and review branches were preserved. Fresh `make test`
and `make coverage` reruns passed at #18's merge gate, retaining **100% Stage 0 C
line/function/branch coverage**. Its eight hosted push/PR jobs also passed.
The resulting `main` run is [CI at `20881dc`](https://github.com/flakesonnix/l/actions/runs/43041429246);
check its conclusion separately from the PR-head checks.

PR #20 also received a fresh COMMENT merge-gate review and 178-fixture model
rerun. Its prospective and actual merge trees exactly matched tested head
`9da4083`; original history and the review branch were retained. All eight PR-head
checks and the resulting [main CI at `c98fb6f`](https://github.com/flakesonnix/l/actions/runs/43280312128)
passed. Main CI was checked directly after its local watcher timed out; a watcher
timeout is not a failed hosted run.

PR #21 received a fresh COMMENT merge-gate review and 285-fixture model rerun.
The prospective and actual merge trees exactly matched tested head `cb3ea2f`,
with history and branch preserved. Its eight PR-head checks and resulting
[main CI at `6af87d9`](https://github.com/flakesonnix/l/actions/runs/43292967995)
passed, retaining the same Stage 0 C coverage gate.

The completed initial Stage 1 slices parse **legacy bootstrap syntax**. They do not resolve
modules/names, check types, evaluate initializers, allocate input storage, generate
code or self-host. Struct/enum declarations remain unsupported by the Stage 1
file parser, although Stage 0 already implements them.
The replacement binding parser is a separate, syntax-only migration slice; the
source compiler and bootstrap implementation sources still use legacy syntax.

The byte I/O and static-buffer slices change the artifact version and need
recompilation of older bytecode. The observer is an approved optional C embedding
API, not a new L intrinsic or serialized trace format. See
[DEVELOPMENT.md](DEVELOPMENT.md#artifact-compatibility) for the migration table.

## Merge procedure

1. Record the exact PR head, inspect its diff and review conversations, and post
   actual GitHub review comments. Fix blocking findings before proceeding.
2. Wait for every dependency to reach `main`, then retarget the next PR to `main`.
   Recheck the resulting diff and all checks on its exact current head.
3. Compute `git merge-tree --write-tree origin/main <head>` and compare it with
   `<head>^{tree}`. Equality means the proposed merge uses the tested source tree.
   If it differs, validate the combined tree before merging; do not assume the
   head's successful checks cover it.
4. Use **Create a merge commit**, matching the reviewed head. Do not bypass branch
   protection or treat a self-review as an independent approval.
5. Fetch the result, verify its parents/tree and retained original history, then
   check the new `main` CI run. Keep the review branches; do not delete them.

Do not blindly merge a stacked PR into its feature-branch base. Squash/rebase
merges require deliberate restacking and do not retain the original commit IDs on
`main`. No force-push, reset, unattended auto-merge or branch-protection change is
part of publishing this stack.

For a new stack, substitute the actual PR number and head branch:

```sh
gh pr edit <number> --repo flakesonnix/l --base main
gh workflow run ci.yml --repo flakesonnix/l --ref <head-branch>
gh pr checks <number> --repo flakesonnix/l
```

Repeat with each next head branch after its prerequisite is merged. The workflow
also runs on pushes to `main` and `review/**`, and on pull requests. It is already
present on the default branch, so manual dispatch is available.

## What to check

- Keep the normative module rules, exact typing and left-to-right evaluation.
- Check EOF, byte preservation and reported stream failures in the I/O slice.
- Check shared array identity across imports, bounds, limits and fresh storage
  after success or trap in the buffer slices.
- Check event order, arm identities, NULL-observer behavior and unchanged
  execution budgets in the observer slice.
- Check pinned inputs, installed manifests, Linux platform scope, sanitizer and
  100% coverage gates in the Nix/CI slices.
- Check Stage 1 arena ownership, first-error rollback, exact shared budgets,
  source/bytecode model agreement and the boundary between syntax and semantics.
- The coverage gate measures **Stage 0 C only**, not L-source coverage. Arbitrary
  bytecode mutants and cyclic verifier graphs must never be executed.
- Treat local command results and hosted GitHub status checks as separate evidence.

## Approved syntax replacement

The user approved a **typed, Nix-inspired replacement**, not a permanent parallel
grammar. Declarative bindings, `let/in`, records and expression-oriented functions
are the direction. Name-first types, `name = (arg: Type): Result => expression;`,
eager/sequential `let/in`, and immutable locals with explicit `var` are approved.
Mandatory-else `if condition then value else value` expressions are approved too,
with intended bool conditions, matching result types and selected-branch evaluation.
Records use approved `Name = record { field: Type; };` declarations and
`Name { field = value; }` literals, retaining intended nominal/by-value semantics
and written-order value evaluation. These remain syntax-only parser slices.
The first replacement parser records these forms without implementing their
semantics or completing the source migration; the remaining grammar is unfinished.
Existing executable examples and legacy parser contracts still use bootstrap syntax. Expanding that
grammar with Stage 1 enum/struct declarations is deferred behind replacement.

Review source migration separately from the completed parser slices. Preserve
static types, eager left-to-right evaluation and the normative module semantics;
do not silently add laziness, dynamic typing, implicit module discovery or change
IR/bytecode **1.9**. See [source syntax status](../README.md#source-syntax-status).
