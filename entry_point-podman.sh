#!/usr/bin/env bash

set -e

export REDIS_PORT="${REDIS_PORT:-6379}"
export XDG_RUNTIME_DIR=/home/podman/xdg

sudo -u podman mkdir -p /home/podman/xdg/podman
sudo -u podman mkdir -p /home/podman/shared/{pkgout,srcdest_cached,sources}
sudo -u podman podman system service --time=0 unix://${XDG_RUNTIME_DIR}/podman/podman.sock &
chown podman:podman -R /home/podman

if [ -n "$REDIS_SSH_HOST" ]; then
    REDIS_SSH_PORT="${REDIS_SSH_PORT:-22}"
    REDIS_SSH_USER="${REDIS_SSH_USER:-root}"

    if [ ! -f /tmp/tunnel.pid ]; then
        # Set up ssh tunneling
        AUTOSSH_PIDFILE=/tmp/tunnel.pid AUTOSSH_GATETIME=0 AUTOSSH_PORT=0 autossh -f -N -L "6380:127.0.0.1:${REDIS_PORT}" \
            -p "$REDIS_SSH_PORT" \
            -o StrictHostKeyChecking=no \
            -o ServerAliveInterval=60 \
            -o ServerAliveCountMax=3 \
            -o ExitOnForwardFailure=yes \
            -o ConnectTimeout=10 \
            -o TCPKeepAlive=yes \
            -i /app/sshkey \
            "$REDIS_SSH_USER@$REDIS_SSH_HOST"
    fi

    export REDIS_PORT=6380

    # Wait for tunnel to be established
    echo "Waiting for tunnel to be established..."
    while ! nc -z localhost $REDIS_PORT; do
        sleep 1
    done
    echo "Tunnel established"
fi

export DOCKER_HOST="unix://home/podman/xdg/podman/podman.sock"
node /app/index.js "$@"
