#!/bin/bash

set -ex

pushd builder-container
./build-test-container.sh
popd

SHARED_PATH="$(pwd)/temp/shared"
REPO_PATH="$(pwd)/temp/repo_root"
LANDING_ZONE_PATH="$(pwd)/temp/landing_zone"
GPG_PATH="$(pwd)/gpg"
DATABASE_HOST="localhost"
DATABASE_PORT=2891
DATABASE_USER="package-deployer"

chmod 600 sshkey
sshkey="$(ssh-keygen -y -t ed25519 -f ./sshkey)"

cat > ./docker-compose.yml << EOM
version: "3"
services:
    openssh-server:
        container_name: openssh-server
        hostname: openssh-server
        environment:
            - PUID=1000
            - PGID=1000
            - TZ=Etc/UTC
            - PUBLIC_KEY=${sshkey}
            - SUDO_ACCESS=false
            - PASSWORD_ACCESS=false
            - USER_NAME=package-deployer
        ports:
            - 2891:2222
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
        image: chaotic-runner
        command: builder
    chaotic-database:
        network_mode: host
        volumes:
            - ./sshkey:/app/sshkey
            - /var/run/docker.sock:/var/run/docker.sock
        environment:
            - REPO_PATH=${REPO_PATH}
            - LANDING_ZONE_PATH=${LANDING_ZONE_PATH}
            - GPG_PATH=${GPG_PATH}
            - DATABASE_HOST=${DATABASE_HOST}
            - DATABASE_PORT=${DATABASE_PORT}
            - DATABASE_USER=${DATABASE_USER}
        image: chaotic-runner
        command: database
EOM

docker build -t chaotic-runner .

docker-compose up
docker-compose down
rm docker-compose.yml