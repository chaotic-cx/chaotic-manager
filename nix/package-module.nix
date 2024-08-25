{
  perSystem = {
    lib,
    pkgs,
    ...
  }: let
    name = "chaotic-manager";
    nodejs = pkgs.nodejs_22;
    nodeModules = pkgs.fetchYarnDeps {
      yarnLock = src + "/yarn.lock";
      hash = "sha256-EYe8zpy3HfVQS1Jp/t9vloAsjfQZzaJKhST1bSipO3w=";
    };
    replPath = toString ./.;
    src = ../.;
    version = "1.0.0";
  in {
    packages = rec {
      chaotic-manager = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "${finalAttrs.name}";

        inherit name src nodeModules version;

        buildInputs = [nodejs];
        nativeBuildInputs = [
          nodejs
          pkgs.fixup-yarn-lock
          pkgs.makeWrapper
          (pkgs.yarn.override {
            inherit nodejs;
          })
        ];

        postPatch = ''
          export HOME=$(mktemp -d)
          yarn config --offline set yarn-offline-mirror ${finalAttrs.nodeModules}
          fixup-yarn-lock yarn.lock
          yarn install --offline --frozen-lockfile --ignore-scripts --no-progress --non-interactive
          patchShebangs node_modules/
        '';

        buildPhase = ''
          runHook preBuild
          yarn --offline build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib
          mv {dist/*,node_modules} $out/lib
          makeWrapper ${nodejs}/bin/node $out/bin/chaotic-manager \
                --add-flags $out/lib/index.js
          runHook postInstall
        '';

        doDist = false;

        meta = {
          description = "Chaotic-AUR build system for managing AUR and custom packages";
          homepage = "https://gitlab.com/garuda-linux/tools/chaotic-manager";
          maintainers = with lib.maintainers; [dr460nf1r3];
          inherit (nodejs.meta) platforms;
          mainProgram = "chaotic-manager";
        };
      });

      node-modules = pkgs.stdenv.mkDerivation (finalAttrs: {
        name = "node-modules-${name}";
        pname = finalAttrs.name;

        inherit version src nodeModules;

        nativeBuildInputs = [
          nodejs
          pkgs.fixup-yarn-lock
          (pkgs.yarn.override {
            inherit nodejs;
          })
        ];

        postPatch = ''
          export HOME=$(mktemp -d)
          yarn config --offline set yarn-offline-mirror ${finalAttrs.nodeModules}
          fixup-yarn-lock yarn.lock
          yarn install --offline --frozen-lockfile --ignore-scripts --no-progress --non-interactive
          patchShebangs node_modules/
        '';

        installPhase = ''
          runHook preInstall
          mv node_modules $out
          runHook postInstall
        '';

        doDist = false;

        meta = {
          description = "Node modules for ${name} development";
          homepage = "https://gitlab.com/garuda-linux/tools/chaotic-manager";
          maintainers = with lib.maintainers; [dr460nf1r3];
          inherit (nodejs.meta) platforms;
        };
      });

      # Sets up repl environment with access to the flake
      repl = pkgs.writeShellScriptBin "chaotic-repl" ''
        source /etc/set-environment
        nix repl --file "${replPath}/repl.nix" "$@"
      '';
    };
  };
}
