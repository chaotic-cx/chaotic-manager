{
  config,
  lib,
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
      timeout = mkOption {
        default = 3600;
        type = types.int;
        description = mdDoc ''
          The build timeout to use for the Chaotic Builder service in seconds.
        '';
      };
      enironmentFile = mkOption {
        default = null;
        type = types.path;
        description = mdDoc ''
          The environment file to use for the Chaotic Builder service.
          Here, relevant secrets such as the Redis password must be provided.
        '';
      };
      sharedPath = mkOption {
        default = "/var/lib/chaotic/builder";
        type = types.str;
        description = mdDoc ''
          The shared path to use for the Chaotic Builder service.
        '';
      };
      redis = {
        host = mkOption {
          default = "redis";
          type = types.str;
          description = mdDoc ''
            The hostname of the Redis server.
          '';
        };
        port = mkOption {
          default = "6379";
          type = types.str;
          description = mdDoc ''
            The port of the Redis server.
          '';
        };
        user = mkOption {
          default = "chaotic";
          type = types.str;
          description = mdDoc ''
            The user to use for the Redis server.
          '';
        };
      };
      sshKey = mkOption {
        default = null;
        type = types.path;
        description = mdDoc ''
          The SSH key path to use for the Chaotic Builder service.
        '';
      };
      ciCodeSkip = mkOption {
        default = 123;
        type = types.int;
        description = mdDoc ''
          The CI exit code signaling an intended build skip.
        '';
      };
      user = mkOption {
        default = "root";
        type = types.str;
        description = mdDoc ''
          The user to use for the Chaotic Builder service.
        '';
      };
      group = mkOption {
        default = "root";
        type = types.str;
        description = mdDoc ''
          The group to use for the Chaotic Builder service.
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
      environmentFile = mkOption {
        default = null;
        type = types.path;
        description = mdDoc ''
          The environment file to use for the Chaotic Manager service.
          Here, relevant secrets such as the Redis password must be provided.
        '';
      };
      redis = {
        host = mkOption {
          default = "127.0.0.1";
          type = types.str;
          description = mdDoc ''
            The hostname of the Redis server.
          '';
        };
        port = mkOption {
          default = 6379;
          type = types.str;
          description = mdDoc ''
            The port of the Redis server.
          '';
        };
        user = mkOption {
          default = "chaotic";
          type = types.str;
          description = mdDoc ''
            The user to use for the Redis server.
          '';
        };
        enableServer = mkOption {
          default = true;
          type = types.bool;
          description = mdDoc ''
            Whether to set up the Redis server for the Chaotic Manager service.
          '';
        };
        passwordFile = mkOption {
          default = null;
          type = types.str;
          description = mdDoc ''
            The password file to use for the Redis server.
          '';
        };
      };
      sharedPath = mkOption {
        default = "/var/lib/chaotic/manager/shared";
        type = types.str;
        description = mdDoc ''
          The shared path to use for the Chaotic Manager service.
        '';
      };
      repoPath = mkOption {
        default = "/var/lib/chaotic/manager/repos";
        type = types.str;
        description = mdDoc ''
          The repository path to use for the Chaotic Manager service.
        '';
      };
      landingZonePath = mkOption {
        default = "/var/lib/chaotic/manager/landing-zone";
        type = types.str;
        description = mdDoc ''
          The landing zone path to use for the Chaotic Manager service.
        '';
      };
      gpgPath = mkOption {
        default = "/var/lib/chaotic/manager/gpg";
        type = types.str;
        description = mdDoc ''
          The GPG path to use for the Chaotic Manager service.
        '';
      };
      logsUrl = mkOption {
        default = "http://localhost:8080/logs";
        type = types.str;
        description = mdDoc ''
          The logs URL to use for the Chaotic Manager service.
        '';
      };
      sshKey = mkOption {
        default = null;
        type = types.path;
        description = mdDoc ''
          The SSH key path to use for the Chaotic Manager service.
        '';
      };
      ciCodeSkip = mkOption {
        default = 123;
        type = types.int;
        description = mdDoc ''
          The CI exit code signaling an intended build skip.
        '';
      };
      repos = {
        packageRepos = mkOption {
          default = null;
          type = types.str;
          description = mdDoc ''
            Package repos to use for the Chaotic Manager service in JSON format.
          '';
        };
        packageTargetRepos = mkOption {
          default = null;
          type = types.str;
          description = mdDoc ''
            The package target repository path to use for the Chaotic Manager service in JSON format.
          '';
        };
      };
      ssh = {
        group = mkOption {
          default = "chaotic-op";
          type = types.str;
          description = mdDoc ''
            The SSH group to use for the Chaotic Manager service.
          '';
        };
        allowedPubkeys = mkOption {
          default = [];
          type = types.listOf types.str;
          description = mdDoc ''
            The SSH keys allowed to deploy packages to the landing zone.
          '';
        };
      };
      web.port = mkOption {
        default = 8080;
        type = types.int;
        description = mdDoc ''
          The web port to use for the Chaotic Manager service.
        '';
      };
      user = mkOption {
        default = "root";
        type = types.str;
        description = mdDoc ''
          The user to use for the Chaotic Manager service.
        '';
      };
      group = mkOption {
        default = "root";
        type = types.str;
        description = mdDoc ''
          The group to use for the Chaotic Manager service.
        '';
      };
    };
  };

  config = {
    # Docker is needed, as builds are being executed in it. Database operations as well.
    virtualisation.docker = lib.mkIf (cfg.builder.enable || cfg.manager.enable) {
      autoPrune.enable = true;
      enable = true;
    };

    # Builder service
    systemd.services.chaotic-builder = lib.mkIf cfg.builder.enable {
      enable = true;
      description = "Chaotic Builder";
      after = ["network.target" "docker.service"];
      wantedBy = ["multi-user.target"];
      restartTriggers = [cfg.builder.environmentFile];
      preStart = "test -d /var/lib/chaotic/builder || mkdir -p /var/lib/chaotic/builder";
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.builder.package}/bin/chaotic-manager builder";
        Restart = "always";
        RestartSec = "5";
        EnvironmentFile = cfg.builder.environmentFile;
        User = cfg.builder.user;
        Group = cfg.builder.group;
      };
      environment = {
        BUILDER_HOSTNAME = cfg.builder.hostname;
        BUILDER_TIMEOUT = cfg.builder.timeout;
        CI_CODE_SKIP = cfg.builder.ciCodeSkip;
        NODE_ENV = "production";
        REDIS_SSH_HOST = cfg.builder.redis.host;
        REDIS_SSH_PORT = cfg.builder.redis.port;
        REDIS_SSH_USER = cfg.builder.redis.user;
        SHARED_PATH = cfg.builder.sharedPath;
      };
    };

    # Redis is used to distribute build jobs
    services.redis = lib.mkIf cfg.manager.redis.enableServer {
      vmOverCommit = true;
      servers."chaotic" = {
        bind = cfg.manager.redis.host;
        enable = true;
        inherit (cfg.manager.redis) port;
        requirePassFile = cfg.database.redis.passwordFile;
      };
    };

    # Lock down chaotic-op group to SCP in landing zone
    services.openssh.extraConfig = lib.mkIf cfg.manager.enable ''
      Match Group ${cfg.manager.ssh.group}
        AllowTCPForwarding yes
        AllowAgentForwarding no
        X11Forwarding no
        PermitTunnel no
        ForceCommand internal-sftp
        PermitOpen 127.0.0.1:${cfg.manager.redis.port}
    '';

    # Package deploying user
    users.users.package-deployer = lib.mkIf cfg.manager.enable {
      isNormalUser = true;
      extraGroups = [cfg.manager.ssh.group];
      openssh.authorizedKeys.keys = cfg.manager.ssh.allowedPubkeys;
    };
    users.groups.${cfg.manager.sshGroup} = {};

    # Chaotic Manager service
    systemd.services.chaotic-manager = lib.mkIf cfg.manager.enable {
      enable = true;
      description = "Chaotic Manager";
      after = ["network.target" "docker.service"];
      wantedBy = ["multi-user.target"];
      restartTriggers = [cfg.manager.environmentFile];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.manager.package}/bin/chaotic-manager database --web-port ${cfg.database.web.port}";
        Restart = "always";
        RestartSec = "5";
        EnvironmentFile = cfg.manager.environmentFile;
        User = cfg.manager.user;
        Group = cfg.manager.group;
      };
      environment = {
        BUILDER_HOSTNAME = cfg.database.hostname;
        CI_CODE_SKIP = cfg.database.ciCodeSkip;
        DATABASE_HOST = cfg.database.redis.host;
        DATABASE_PORT = cfg.database.redis.port;
        DATABASE_USER = cfg.database.redis.user;
        GPG_PATH = cfg.database.gpgPath;
        LANDING_ZONE_PATH = cfg.database.landingZonePath;
        LOGS_URL = cfg.database.logsUrl;
        NODE_ENV = "production";
        PACKAGE_REPOS = cfg.database.repos.packageRepos;
        PACKAGE_TARGET_REPOS = cfg.database.repos.packageTargetRepos;
        REPO_PATH = cfg.database.repoPath;
        SHARED_PATH = cfg.database.sharedPath;
      };
    };
  };
}
