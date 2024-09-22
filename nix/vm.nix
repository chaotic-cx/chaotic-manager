{lib, ...}: {
  # Import service module
  imports = [./service.nix];

  # Only testing users
  users = {
    mutableUsers = false;
    users = {
      garuda = {
        isNormalUser = true;
        extraGroups = ["wheel"];
        password = "garuda";
      };
      root.password = "garuda";
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
