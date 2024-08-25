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
      inputs.nixpkgs-stable.follows = "nixpkgs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    flake-parts,
    nixpkgs,
    pre-commit-hooks,
    self,
    ...
  } @ inp: let
    inputs = inp;
    perSystem = {
      pkgs,
      system,
      ...
    }: {
      # Handy devshell for working with this flake
      devShells = let
        # Import the devshell module as module rather than a flake input
        makeDevshell = import "${inp.devshell}/modules" pkgs;
        mkShell = config:
          (makeDevshell {
            configuration = {
              inherit config;
              imports = [];
            };
          })
          .shell;
      in rec {
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
                node2nix node-packages.json -o ./nix/node-packages.nix -c ./nix/default.nix -e ./nix/node-env.nix
              '';
              help = "Regenerates the node-packages.nix file";
              name = "regen-node";
            }
            {
              category = "chaotic-manager";
              command = ''
                tsc && node dist/index.js
              '';
              help = "Starts the development environment";
              name = "start";
            }
            {package = "biome";}
            {package = "commitizen";}
            {package = "docker-compose";}
            {package = "jq";}
            {package = "node2nix";}
            {package = "nodejs_22";}
            {package = "pre-commit";}
            {package = "psmisc";}
            {package = "redis";}
            {package = "yarn";}
          ];
          devshell.startup.preCommitHooks.text = ''
            ${self.checks.${system}.pre-commit-check.shellHook}

            killall -9 redis-server || true
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

      # By default, alejandra is WAY to verbose
      formatter = pkgs.writeShellScriptBin "alejandra" ''
        exec ${pkgs.alejandra}/bin/alejandra --quiet "$@"
      '';

      # Pre-commit hooks are set up automatically via nix-shell / nix develop
      checks.pre-commit-check = pre-commit-hooks.lib.${system}.run {
        hooks = {
          alejandra-quiet = {
            description = "Run Alejandra in quiet mode";
            enable = true;
            entry = ''
              ${pkgs.alejandra}/bin/alejandra --quiet
            '';
            files = "\\.nix$";
            name = "alejandra";
          };
          commitizen.enable = true;
          check-json.enable = true;
          check-yaml.enable = true;
          flake-checker.enable = true;
          prettier.enable = true;
          yamllint.enable = true;
          statix.enable = true;
        };
        src = ./.;
      };
    };
  in
    flake-parts.lib.mkFlake {inherit inputs;} {
      # Imports flake-modules
      imports = [
        ./nix/flake-module.nix
        inputs.pre-commit-hooks.flakeModule
      ];

      # The systems currently available
      systems = ["x86_64-linux" "aarch64-linux"];

      # This applies to all systems
      inherit perSystem;
    };
}
