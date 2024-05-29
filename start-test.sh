#!/bin/bash

set -ex

pushd builder-container
./build-test-container.sh
popd

SHARED_PATH="$(pwd)/temp/shared"
REPO_PATH="$(pwd)/temp/repo_root"
LANDING_ZONE_PATH="$(pwd)/temp/landing_zone"
GPG_PATH="$(pwd)/gpg"
DATABASE_HOST="127.0.0.1"
DATABASE_PORT=2891
DATABASE_USER="package-deployer"
BUILDER_HOSTNAME="chaotic-dev"

chmod 600 sshkey
sshkey="$(ssh-keygen -y -t ed25519 -f ./sshkey)"

cat > ./docker-compose.yml << EOM
version: "3"
services:
    openssh-server:
        container_name: openssh-server
        hostname: openssh-server
        network_mode: host
        environment:
            - PUID=1000
            - PGID=1000
            - TZ=Etc/UTC
            - PUBLIC_KEY=${sshkey}
            - SUDO_ACCESS=false
            - PASSWORD_ACCESS=false
            - USER_NAME=package-deployer
            - LISTEN_PORT=2891
            - DOCKER_MODS=linuxserver/mods:openssh-server-ssh-tunnel # enable AllowTcpForwarding here
        volumes:
            - ./temp/landing_zone:$(pwd)/temp/landing_zone
        image: lscr.io/linuxserver/openssh-server:latest
        entrypoint: bash -c "chown -R 1000:1000 '$(pwd)/temp/landing_zone' && exec /init"
    chaotic-runner:
        network_mode: host
        volumes:
            - ./sshkey:/app/sshkey
            - /var/run/docker.sock:/var/run/docker.sock
            - ./temp/shared:/shared
        environment:
            - SHARED_PATH=${SHARED_PATH}
            - REDIS_SSH_HOST=${DATABASE_HOST}
            - REDIS_SSH_PORT=${DATABASE_PORT}
            - REDIS_SSH_USER=${DATABASE_USER}
            - NODE_ENV=development
            - BUILDER_HOSTNAME=${BUILDER_HOSTNAME}
        image: registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager
        command: builder
    chaotic-database:
        network_mode: host
        volumes:
            - ./sshkey:/app/sshkey
            - /var/run/docker.sock:/var/run/docker.sock
            - ./temp/repo_root:/repo_root
        environment:
            - REPO_PATH=${REPO_PATH}
            - LANDING_ZONE_PATH=${LANDING_ZONE_PATH}
            - GPG_PATH=${GPG_PATH}
            - DATABASE_HOST=${DATABASE_HOST}
            - DATABASE_PORT=${DATABASE_PORT}
            - DATABASE_USER=${DATABASE_USER}
            - NODE_ENV=development
            - LOGS_URL=http://localhost:8080/logs.html
        image: registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager
        command: database --web-port 8080
EOM

#             - PACKAGE_REPOS={"garuda":{"url":"https://gitlab.com/garuda-linux/pkgbuilds"}}

docker build -t registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager .

docker-compose up || true
docker-compose down
rm docker-compose.yml
