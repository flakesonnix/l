{
  description = "Language L C11 Stage 0 bootstrap";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      lib = nixpkgs.lib;
      source = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions (
          [
            ./Makefile
            ./README.md
            ./bootstrap
            ./examples
            ./spec
            ./stdlib
            ./tests
          ]
          ++ lib.optional (builtins.pathExists ./docs) ./docs
        );
      };
      environments = lib.genAttrs systems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          compiler = pkgs.stdenv.mkDerivation {
            pname = "language-l-stage0";
            version = "0.1.0-stage0";
            src = source;
            strictDeps = true;
            nativeBuildInputs = [ pkgs.nodejs_22 ];
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              make test
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              install -Dm755 build/l "$out/bin/l"
              mkdir -p "$out/share/l"
              cp -r examples spec stdlib README.md "$out/share/l/"
              mkdir -p "$out/share/l/bootstrap"
              cp -r bootstrap/stage1 "$out/share/l/bootstrap/"
              if test -d docs; then cp -r docs "$out/share/l/"; fi
              runHook postInstall
            '';
            doInstallCheck = true;
            installCheckPhase = ''
              runHook preInstallCheck
              "$out/bin/l" check "$out/share/l/examples/answer.l" --manifest "$out/share/l/examples/package.json"
              "$out/bin/l" check "$out/share/l/examples/io_demo.l" --manifest "$out/share/l/examples/package.json"
              "$out/bin/l" compile "$out/share/l/examples/replacement/answer.l" --manifest "$out/share/l/examples/replacement/package.json" -o replacement-answer.lbc
              "$out/bin/l" check replacement-answer.lbc
              status=0
              "$out/bin/l" run replacement-answer.lbc || status=$?
              test "$status" -eq 42
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/expression_main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/statement_main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/header_main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/function_main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              "$out/bin/l" check "$out/share/l/bootstrap/stage1/binding_main.l" --manifest "$out/share/l/bootstrap/stage1/package.json"
              runHook postInstallCheck
            '';
            meta = {
              description = "Verified C11 bootstrap compiler and bytecode VM for Language L";
              mainProgram = "l";
              platforms = systems;
            };
          };
          check =
            name: command:
            pkgs.stdenv.mkDerivation {
              pname = "language-l-${name}";
              version = "0.1.0-stage0";
              src = source;
              strictDeps = true;
              nativeBuildInputs = [ pkgs.nodejs_22 ];
              # Coverage compiles at -O0; glibc fortification requires optimization.
              hardeningDisable = lib.optional (name == "coverage") "fortify";
              buildPhase = ''
                runHook preBuild
                ${command}
                runHook postBuild
              '';
              installPhase = ''
                mkdir -p "$out"
                if test -f build/coverage/report.json; then
                  cp build/coverage/report.json "$out/report.json"
                fi
                touch "$out/passed"
              '';
            };
        in
        {
          inherit pkgs compiler;
          checks = {
            test = compiler;
            coverage = check "coverage" "make coverage";
            sanitize = check "sanitize" "make sanitize";
            format = pkgs.runCommand "language-l-nix-format" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
              nixfmt --check ${./flake.nix}
              touch "$out"
            '';
            workflow =
              pkgs.runCommand "language-l-workflow-lint"
                {
                  nativeBuildInputs = [
                    pkgs.actionlint
                    pkgs.nodejs_22
                  ];
                }
                ''
                  actionlint ${./.github/workflows/ci.yml}
                  node ${./tests/workflow.mjs} ${./.github/workflows/ci.yml}
                  touch "$out"
                '';
          };
          shell = pkgs.mkShell {
            inputsFrom = [ compiler ];
            # Keep direct `make coverage` compatible with its -O0 instrumentation.
            hardeningDisable = [ "fortify" ];
            packages = [
              pkgs.gnumake
              pkgs.nodejs_22
              pkgs.git
              pkgs.gh
              pkgs.nixfmt
              pkgs.actionlint
            ];
          };
        }
      );
    in
    {
      packages = lib.mapAttrs (_: env: {
        default = env.compiler;
        l-stage0 = env.compiler;
      }) environments;
      apps = lib.mapAttrs (_: env: {
        default = {
          type = "app";
          program = "${env.compiler}/bin/l";
        };
      }) environments;
      checks = lib.mapAttrs (_: env: env.checks) environments;
      devShells = lib.mapAttrs (_: env: { default = env.shell; }) environments;
      formatter = lib.mapAttrs (_: env: env.pkgs.nixfmt) environments;
    };
}
