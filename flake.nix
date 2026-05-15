{
  inputs = {
    devshell = {
      url = "github:numtide/devshell";
      flake = false;
    };
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pre-commit-hooks = {
      url = "github:cachix/pre-commit-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      flake-parts,
      nixpkgs,
      pre-commit-hooks,
      self,
      ...
    }@inp:
    let
      inputs = inp;
      perSystem =
        {
          pkgs,
          system,
          ...
        }:
        {
          devShells =
            let
              makeDevshell = import "${inp.devshell}/modules" pkgs;
              mkShell =
                config:
                (makeDevshell {
                  configuration = {
                    inherit config;
                    imports = [ ];
                  };
                }).shell;
            in
            rec {
              default = chaotic-shell;
              chaotic-shell = mkShell {
                devshell.name = "chaotic-devshell";
                commands = [
                  {
                    category = "chaotic-manager";
                    command = ''
                      tsc-watch --onSuccess 'node --env-file=.env dist/index.js database --web-port 8080'
                    '';
                    help = "Starts the manager instance with watching file changes";
                    name = "start-dev-manager";
                  }
                  {
                    category = "chaotic-manager";
                    command = ''
                      tsc-watch --onSuccess 'node --env-file=.env dist/index.js builder'
                    '';
                    help = "Starts the builder instance with watching file changes";
                    name = "start-dev-builder";
                  }
                  {
                    category = "chaotic-manager";
                    command = ''
                      tsc && node dist/index.js
                    '';
                    help = "Starts the development environment";
                    name = "start";
                  }
                  { package = "commitizen"; }
                  { package = "docker-compose"; }
                  { package = "jq"; }
                  { package = "nodejs_24"; }
                  { package = "prek"; }
                  { package = "redis"; }
                ]
                ++ (
                  if system == "x86_64-linux" || system == "aarch64-linux" then
                    [
                      { package = "psmisc"; }
                    ]
                  else
                    [ ]
                );
                devshell.startup.preCommitHooks.text = ''
                  ${self.checks.${system}.pre-commit-check.shellHook}

                  killall -9 redis-server 2> /dev/null || true
                  rm -f dump.rdb
                  redis-server --daemonize yes
                  redis-cli ping
                  trap "redis-cli shutdown" EXIT
                '';
                env = [
                  {
                    name = "NIX_PATH";
                    value = "${nixpkgs}";
                  }
                ];
              };
            };

          formatter = pkgs.nixfmt;

          checks.pre-commit-check = pre-commit-hooks.lib.${system}.run {
            package = pkgs.prek;
            hooks = {
              commitizen.enable = true;
              check-json.enable = true;
              check-yaml.enable = true;
              flake-checker.enable = true;
              nixfmt.enable = true;
              prettier.enable = true;
              yamllint.enable = true;
              statix.enable = true;
            };
            src = ./.;
          };
        };
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        ./nix/nixos-module.nix
        ./nix/package-module.nix
        inputs.pre-commit-hooks.flakeModule
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      inherit perSystem;
    };
}
