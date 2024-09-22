{lib, ...}: {
  # Import service module
  imports = [./service.nix];

  # Only testing users
  users = {
    mutableUsers = false;
    users = {
      nix = {
        isNormalUser = true;
        extraGroups = ["wheel"];
        password = "nixos";
      };
      root.password = "nixos";
    };
  };

  # Gets run via QEMU
  services.qemuGuest.enable = lib.mkForce true;

  # Some locale settings
  console.keyMap = "de";
  services.xserver = {
    enable = true;
    xkb.layout = "de";
  };

  # Builder dummy stuff
  chaotic = {
    builder = {
      enable = true;
      environmentFile = "/var/lib/chaotic/environment";
      sshKey = "/var/lib/chaotic/ssh-key";
    };
    manager = {
      enable = true;
      environmentFile = "/var/lib/chaotic/environment";
      redis.passwordFile = "/var/lib/chaotic/password";
      repos = {
        packageRepos = "test";
        packageTargetRepos = "test";
      };
      sshKey = "/var/lib/chaotic/ssh-key";
    };
  };

  # Timezone
  time.timeZone = "Europe/Berlin";

  # Virtualisation settings for running "nix run .#internal.vm"
  # This makes the VM usable
  virtualisation.vmVariant = {
    virtualisation = {
      cores = 4;
      memorySize = 3072;
    };
  };

  # Nix stuff
  system.stateVersion = "24.05";
}
