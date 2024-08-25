{
  perSystem = {
    lib,
    pkgs,
    system,
    ...
  }: let
    nodejs = pkgs.nodejs_22;
    nodePackages = import ./default.nix {
      inherit pkgs system nodejs;
    };
    replPath = toString ./.;
  in {
    packages = {
      chaotic-manager = nodePackages.package.override {
        name = "chaotic-manager";
        packageName = "chaotic-manager";
        meta = {
          description = "A manager for the chaotic system";
          maintainers = with lib.maintainers; [dr460nf1r3];
        };
      };

      chaotic-manager-shell = nodePackages.shell.override {
        name = "chaotic-manager-shell";
        packageName = "chaotic-manager-shell";
        meta = {
          description = "A manager for the chaotic system";
          maintainers = with lib.maintainers; [dr460nf1r3];
        };
      };

      # Sets up repl environment with access to the flake
      repl = pkgs.writeShellScriptBin "chaotic-repl" ''
        source /etc/set-environment
        nix repl --file "${replPath}/repl.nix" "$@"
      '';
    };
  };
}
