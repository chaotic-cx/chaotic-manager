#!/usr/bin/env bash
set -e

if [ -z "$1" ]; then
    echo "Usage 1: bash start-dev.sh docker"
    echo " -> Uses docker-compose to start the development environment using Docker containers in a configuration that matches production."
    echo "Usage 2: bash start-dev.sh native"
    echo " -> Uses tsc-watch to start the development environment natively. This responds to code changes instantly."
    echo " -> However, it still uses Docker to set up the landing_zone."
    exit 1
fi

chmod 600 sshkey
sshkey="$(ssh-keygen -y -t ed25519 -f ./sshkey)"

cat > ./docker-compose.yml << EOM
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
        stop_grace_period: 1ms
EOM

if [ "$1" == "docker" ]; then
    BUILDER_HOSTNAME="chaotic-dev"
    DATABASE_HOST="127.0.0.1"
    DATABASE_PORT=2891
    DATABASE_USER="package-deployer"
    GPG_PATH="$(pwd)/gpg"
    LANDING_ZONE_PATH="$(pwd)/temp/landing_zone"
    REPO_PATH="$(pwd)/temp/repo_root"
    SHARED_PATH="$(pwd)/temp/shared"

    pushd builder-container
    ./build-test-container.sh
    popd

    cat >> ./docker-compose.yml << EOM
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
            - BUILDER_CLASS=1
        image: registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager
        command: builder
        depends_on:
            - openssh-server
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
        depends_on:
            - openssh-server
EOM

    docker build -t registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager .
fi

docker compose up &
sleep 10

if [ "$1" == "native" ]; then
    echo "BUILDER_HOSTNAME=chaotic-test-builder
DATABASE_HOST=127.0.0.1
DATABASE_PORT=2891
DATABASE_USER=package-deployer
GPG_PATH='$(pwd)/gpg'
LANDING_ZONE_PATH='$(pwd)/temp/landing_zone'
LOGS_URL=https://localhost:8080/logs/logs.html
NODE_ENV=development
REPO_PATH='$(pwd)/temp/repo_root'
SHARED_PATH='$(pwd)/temp/shared'" >.env

    yarn start:dev &
    yarn start:dev-builder &
fi

( trap exit SIGINT ; read -r -d '' _ </dev/tty )
docker compose down
rm docker-compose.yml
