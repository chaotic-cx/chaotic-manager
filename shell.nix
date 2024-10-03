# shell.nix
{pkgs ? import <nixpkgs> {}}:
pkgs.mkShell {
  buildInputs = [
    pkgs.corepack_22
    pkgs.nodejs_22
    pkgs.redis
    pkgs.psmisc
    pkgs.docker-compose
    pkgs.jq
  ];
  # Start and stop redis
  shellHook = ''
    killall -9 redis-server || true
    # delete the redis dump file
    rm -f dump.rdb
    redis-server --daemonize yes
    redis-cli ping
    trap "redis-cli shutdown" EXIT
  '';
}
