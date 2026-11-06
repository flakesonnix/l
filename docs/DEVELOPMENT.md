# Building and testing Stage 0

Stage 0 is the C11 compiler and verified bytecode VM described in the
[README](../README.md). It is not yet a self-hosted compiler or a complete
implementation of L 0.1. The module rules follow
[module-system specification 0.1.1](../spec/module-system-v0.1.1.md).

## Checkout and prerequisites

Run commands from the repository root. The review stack is documented in
[REVIEWING.md](REVIEWING.md); the initial GitHub `main` is intentionally the
historical 1.7 baseline until those PRs are merged. The Nix commands below require
a checkout containing `flake.nix`, such as the Nix review branch.

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

`make test` already includes deterministic fuzz/model tests; `make fuzz` is useful
when working on those tests alone. `make sanitize` rebuilds the normal binary with
sanitizer flags. Use `make clean` before returning to a normal build: Make does not
track changed compiler flags as dependencies. Coverage has its own compiler under
`build/coverage/`.

Do not run test, sanitizer, coverage or fuzz suites concurrently in the same
checkout: they share `build/` artifacts and temporary serialization paths. Separate
CI jobs and Nix derivations use isolated workspaces and may run independently.

Expected compiler errors and VM traps appear during negative tests. The command
exit status and final suite summaries determine success, not the absence of
diagnostics. Coverage fails unless **every Stage 0 C line, function and branch** is
covered; there are no production-source exclusions. The report is
`build/coverage/report.json`, and fuzz diagnostics are in `build/fuzz.log`.
Arbitrary bytecode mutants and potentially cyclic verifier graphs are verified,
never executed. Executed models have independently known results, traps or
explicit resource-limit expectations.

## Nix workflow

`flake.lock` pins nixpkgs. Linux outputs are available for `x86_64-linux` and
`aarch64-linux`. The initial validation built and tested x86_64 Linux; aarch64
outputs were evaluated but not built on that machine.

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

The development shell supplies the compiler, Make, Node.js, Git, GitHub CLI,
nixfmt and actionlint. `nix flake check` runs the package's regular tests and
installation checks, separate sanitizer and coverage builds, Nix formatting, and
workflow lint. The coverage derivation and development shell disable glibc
fortification because coverage compiles instrumented C sources at `-O0`. The
installed compiler package retains the standard Nix hardening settings.

`nix build` creates `result/bin/l` and installs the examples, standard library,
specification and README under `result/share/l/`. Documentation is included when
present in the checkout. Installed manifests retain their relative source roots:

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

The last command intentionally exits with 42: program results are reduced modulo
256. Usage errors are 64, compilation/format errors 65, VM traps 70, startup
allocation failure 71, and file errors 74. Program results can overlap those codes;
read the diagnostics too.

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

The loader accepts only the current exact version, including for programs that do
not use the new feature. The C observer API and its callback contract are described
in the [README](../README.md#vm-execution-observation); it adds no trace file format.

## Continuous integration

The workflow in [`.github/workflows/ci.yml`](https://github.com/flakesonnix/l/blob/main/.github/workflows/ci.yml) checks
regular tests, sanitizers and coverage in separate Ubuntu jobs with GCC and
Node.js 22. A separate job runs the pinned Nix checks when the branch contains a
flake. Earlier review slices explicitly report that Nix support has not arrived
yet; their native gates still run in full.

Actions are pinned to full commit IDs, repository permissions are read-only, and
checkout credentials are not persisted. Coverage reports and failure diagnostics
are retained briefly as artifacts. No publishing credentials or repository
secrets are needed.

For this initially empty repository, GitHub cannot dispatch the workflow until
the CI PR reaches the default branch. Local validation is not a hosted CI result.
After merging that prerequisite, use the Actions UI or the dispatch commands in
[REVIEWING.md](REVIEWING.md) to start checks for already-open review branches.
