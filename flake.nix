{
  inputs = {
    # self.submodules = true;
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.buildGoModule {
            pname = "lanshare";
            version = "0.1.0";

            src = ./.;
            vendorHash = "sha256-hTYQJTrrYO+dQL/Hl64xcaMILJUkjwD/PW0w8Lkf91E=";

            meta = {
              description = "a local file/text sharing web app over LAN";
              homepage = "https://github.com/hujun-open/lanshare";
              license = pkgs.lib.licenses.mit;
            };
          };
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/lanshare";
        };
      });
    };
}
