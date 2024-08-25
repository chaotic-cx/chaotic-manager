{
  config,
  lib,
  pkgs,
  self',
  ...
}: let
  cfg = config.chaotic;
in {
  options.chaotic = with lib; {
    builder = {
      enable = mkOption {
        default = false;
        type = types.bool;
        description = mdDoc ''
          Enable the Chaotic Builder service.
        '';
      };
      package = mkOption {
        default = self'.packages.chaotic-manager;
        type = types.package;
        description = mdDoc ''
          The package to use for the Chaotic Builder service.
        '';
      };
      hostname = mkOption {
        default = "chaotic-builder";
        type = types.str;
        description = mdDoc ''
          The hostname to use for the Chaotic Builder service.
        '';
      };
    };
    manager = {
      enable = mkOption {
        default = false;
        type = types.bool;
        description = mdDoc ''
          Enable the Chaotic Manager service.
        '';
      };
      package = mkOption {
        default = self'.packages.chaotic-manager;
        type = types.package;
        description = mdDoc ''
          The package to use for the Chaotic Manager service.
        '';
      };
    };
  };

  config = {
    services.chaotic-builder = lib.mkIf cfg.builder.enable {
      enable = true;
      inherit (cfg.builder) package;
    };

    services.chaotic-manager = lib.mkIf cfg.manager.enable {
      enable = true;
      inherit (cfg.manager) package;
    };

    systemd.services.chaotic-builder = lib.mkIf cfg.builder.enable {
      description = "Chaotic Builder";
      after = ["network.target" "docker.service"];
      wantedBy = ["multi-user.target"];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.builder.package}/bin/chaotic-manager";
        Restart = "always";
        RestartSec = "5";
      };
      environment = {
        BUILDER_HOSTNAME = cfg.builder.hostname;
      };
    };

    systemd.services.chaotic-manager = lib.mkIf cfg.manager.enable {
      description = "Chaotic Manager";
      after = ["network.target" "docker.service"];
      wantedBy = ["multi-user.target"];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.manager.package}/bin/chaotic-manager";
        Restart = "always";
        RestartSec = "5";
      };
    };
  };
}
