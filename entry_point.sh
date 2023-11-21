#!/usr/bin/env sh

run_cmd() {
    case "$1" in
    "builder")
        shift
        node /app/index.js builder
        ;;
    "database")
        shift
        node /app/index.js database
        ;;
    *)
        echo "Invalid argument. Please specify 'builder' or 'database'."
        exit 1
        ;;
    esac
}

install_tailscale() {
    # https://tailscale.com/kb/1112/userspace-networking/
    apk add --no-cache tailscale

    tailscaled --tun=userspace-networking \
        --socks5-server=localhost:1055 &
    tailscale up --authkey="$TAILSCALE_AUTHKEY" \
        --advertise-tags="tag:chaotic-node" \
        --accept-dns=false ||
        echo "Failed to connect to Tailscale!" &&
        exit 1
}

if [ -z "$TAILSCALE_ENABLE" ]; then
    run_cmd "$@"
elif [ "$TAILSCALE_ENABLE" = "true" ] && [ -n "$TAILSCALE_AUTHKEY" ]; then
    install_tailscale
    ALL_PROXY=socks5://localhost:1055/ run_cmd "$@"
else
    echo "We can't operate Tailscale without valid authkey!"
fi
