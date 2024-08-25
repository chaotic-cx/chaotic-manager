{self, ...}: {
  flake = {
    nixosModules = {
      default = self.nixosModules.chaotic-manager;
      chaotic-manager = import ./service.nix;
    };
  };
}
