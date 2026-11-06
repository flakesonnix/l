# Reviewing the GitHub stack

The repository is [flakesonnix/l](https://github.com/flakesonnix/l). The explicitly
selected GitHub baseline is commit `e081fb3` (literal-backed strings, IR/bytecode
1.7). Earlier compiler history, including the array reference `f9284b1`, remains
unchanged and reachable from that baseline.

## Review order

Each PR targets its predecessor so its diff contains one review slice rather than
the entire compiler. Review-only merge commits carry the CI foundation forward;
they do not rewrite the original feature commits.

| Order | Review | Head branch | Initial base | Original implementation |
| --- | --- | --- | --- | --- |
| 1 | [CI #1](https://github.com/flakesonnix/l/pull/1) | `review/ci` | `main` | `42bbba8`, `b11fd3d` |
| 2 | [Byte I/O #2](https://github.com/flakesonnix/l/pull/2) | `review/byte-io` | `review/ci` | `c8b2ea4` |
| 3 | [Static buffers #3](https://github.com/flakesonnix/l/pull/3) | `review/static-buffers` | `review/byte-io` | `e6e264f` |
| 4 | [Buffer models #4](https://github.com/flakesonnix/l/pull/4) | `review/buffer-models` | `review/static-buffers` | `3183c5a` |
| 5 | [VM observer #5](https://github.com/flakesonnix/l/pull/5) | `review/vm-observer` | `review/buffer-models` | `a9fb490` |
| 6 | [Nix flake #6](https://github.com/flakesonnix/l/pull/6) | `review/nix-flake` | `review/vm-observer` | `9287094`, `80b802b` |
| 7 | This documentation | `review/docs` | `review/nix-flake` | Documentation-only follow-up |

The byte I/O and static-buffer slices change the artifact version and need
recompilation of older bytecode. The observer is an approved optional C embedding
API, not a new L intrinsic or serialized trace format. See
[DEVELOPMENT.md](DEVELOPMENT.md#artifact-compatibility) for the migration table.

## Merge procedure

1. Review and merge the CI prerequisite first.
2. For each subsequent PR, wait for its predecessor to reach `main`.
3. Change that PR's base to `main`, then inspect the resulting diff and checks.
4. Use **Create a merge commit** to preserve the original commit identities.
5. Retarget dependent PRs before deleting their previous base branches.

Do not blindly merge a stacked PR into its feature-branch base. Squash/rebase
merges require deliberate restacking and do not retain the original commit IDs on
`main`. No force-push, reset, automatic merge or branch-protection change is part
of publishing this stack.

For example, after the CI PR is merged:

```sh
gh pr edit 2 --repo flakesonnix/l --base main
gh workflow run ci.yml --repo flakesonnix/l --ref review/byte-io
gh pr checks 2 --repo flakesonnix/l
```

Repeat with each next head branch after its prerequisite is merged. The workflow
also runs on pushes to `main` and `review/**`, and on pull requests. Dispatching
requires the workflow to exist on the default branch; it is not available before
the initial CI review is merged.

## What to check

- Keep the normative module rules, exact typing and left-to-right evaluation.
- Check EOF, byte preservation and reported stream failures in the I/O slice.
- Check shared array identity across imports, bounds, limits and fresh storage
  after success or trap in the buffer slices.
- Check event order, arm identities, NULL-observer behavior and unchanged
  execution budgets in the observer slice.
- Check pinned inputs, installed manifests, Linux platform scope, sanitizer and
  100% coverage gates in the Nix/CI slices.
- Treat local command results and hosted GitHub status checks as separate evidence.

No PR has been merged automatically. The initial publication intentionally keeps
unreviewed implementation changes off the GitHub default branch.
