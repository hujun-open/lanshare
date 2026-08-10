{ buildGoModule, lib, ... }:
buildGoModule {
  pname = "lanshare";
  version = "0.1.0";

  src = ./.;
  vendorHash = "sha256-hTYQJTrrYO+dQL/Hl64xcaMILJUkjwD/PW0w8Lkf91E=";

  meta = {
    description = "a local file/text sharing web app over LAN";
    homepage = "https://github.com/hujun-open/lanshare";
    license = lib.licenses.mit;
  };
}
