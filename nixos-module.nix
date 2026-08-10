{
  config,
  pkgs,
  lib,
  ...
}:
let
  lanshare = pkgs.callPackage ./daemon-derivation.nix { };
in
{
  options.services.lanshare = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable the lanshare daemon service.";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Specify the host the lanshare daemon service will listen on.";
    };
    port = lib.mkOption {
      type = lib.types.int;
      default = 8080;
      description = "Specify the port the lanshare daemon service will listen on.";
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Open the lanshare daemon service port in the firewall.";
    };
  };

  config = {
    users.users.lanshare = {
      isSystemUser = true;
      group = "lanshare";
    };
    users.groups.lanshare = { };

    systemd.services.lanshare = {
      enable = true;
      description = "LAN-sharing service.";

      serviceConfig = {
        Type = "simple";
        User = "lanshare";
        Group = "lanshare";
        ExecStart = "${lanshare}/bin/lanshare --addr ${config.services.lanshare.host} --port ${config.services.lanshare.port}";
      };

      wantedBy = [ "multi-user.target" ];
    };

    networking.firewall.allowedTCPPorts =
      if config.services.lanshare.openFirewall then [ config.services.lanshare.port ] else null;
  };
}
