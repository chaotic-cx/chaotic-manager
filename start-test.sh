#!/bin/bash

set -x

pushd container-test
./build-test-container.sh
popd

read -r -d '' JSON_CONFIG << EOM
{
    "paths": {
        "shared": "$(pwd)/temp/shared",
        "repo_root": "$(pwd)/temp/repo_root",
        "landing_zone": "$(pwd)/temp/landing_zone",
        "gpg": "$(pwd)/gpg"
    },
    "database": {
        "host": "localhost",
        "port": 2891
    }
}
EOM

# Use JQ to minify the JSON
JSON_CONFIG_MINI="$(jq -c . <<< "$JSON_CONFIG")"

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
            - NODE_CONFIG=${JSON_CONFIG_MINI}
        image: chaotic-runner
        command: builder
    chaotic-database:
        network_mode: host
        volumes:
            - ./sshkey:/app/sshkey
            - /var/run/docker.sock:/var/run/docker.sock
        environment:
            - NODE_CONFIG=${JSON_CONFIG_MINI}
        image: chaotic-runner
        command: database
EOM

docker build -t chaotic-runner .

docker-compose up
docker-compose down
rm docker-compose.yml