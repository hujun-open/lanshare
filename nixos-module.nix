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
      description = "interface to bind (0.0.0.0 for all)";
    };
    guiPort = lib.mkOption {
      type = lib.types.int;
      default = 8080;
      description = "TCP port for the website and signaling WebSocket";
    };
    stunPort = lib.mkOption {
      type = lib.types.int;
      default = 3478;
      description = "UDP port for the embedded STUN responder (0 disables it)";
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Open the lanshare GUI and STUN port in the firewall, if STUN port is 0 (it is disabled), then the STUN port will not be opened in the firewall.";
    };
    certFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "serve HTTPS with a self-signed certificate, which unlocks streaming saves for very large files";
    };
    token = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "optional shared secret; clients must open the site with ?t=<token>";
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
        ExecStart =
          lib.escapeShellArgs [
            "${lanshare}/bin/lanshare"
            "--addr"
            config.services.lanshare.host
            "--port"
            "${toString config.services.lanshare.guiPort}"
            "--stun-port"
            "${toString config.services.lanshare.stunPort}"
          ]
          ++ (
            if config.services.lanshare.certFile != null then
              [
                "--tls"
                config.services.lanshare.certFile
              ]
            else
              [ ]
          )
          ++ (
            if config.services.lanshare.token != null then
              [
                "--token"
                config.services.lanshare.token
              ]
            else
              [ ]
          );
      };

      wantedBy = [ "multi-user.target" ];
    };

    networking.firewall = {
      allowedTCPPorts =
        if config.services.lanshare.openFirewall then [ config.services.lanshare.port ] else null;
      allowedUDPPorts =
        if config.services.lanshare.openFirewall && config.services.lanshare.stunPort != 0 then
          [ config.services.lanshare.stunPort ]
        else
          null;
    };
  };
}
