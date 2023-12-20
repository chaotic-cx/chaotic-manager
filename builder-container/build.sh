#!/usr/bin/env bash

set -e

PKGOUT="/home/builder/pkgout/"
PACKAGE="$1"
BUILDDIR="/home/builder/build/"

# shellcheck source=/dev/null
source ./interfere.sh

function setup-package-repo() {
    if [ -z "$PACKAGE_REPO" ]; then PACKAGE_REPO="https://gitlab.com/garuda-linux/pkgsbuilds-aur.git"; fi
    if [ ! -d /pkgbuilds ]; then mkdir /pkgbuilds; fi
    chown root:root /pkgbuilds
    chmod 755 /pkgbuilds
    pushd /pkgbuilds
    if [ ! -d .git ]; then
        # Silence log output by setting a default main branch name
        git config --global init.defaultBranch main
        git init
        git remote add origin "$PACKAGE_REPO"
    else
        git remote set-url origin "$PACKAGE_REPO"
    fi
    GIT_TERMINAL_PROMPT=0 git fetch origin main --depth=1
    git reset --hard origin/main
    popd
}

function setup-buildenv() {
    if [[ -z $PACKAGER ]]; then PACKAGER="Garuda Builder <team@garudalinux.org>"; fi
    if [[ -z $MAKEFLAGS ]]; then MAKEFLAGS="-j$(nproc)"; fi
    if [[ -z $PACKAGE ]]; then exit 1; fi

    echo "PACKAGER=\"$PACKAGER\"" >>/etc/makepkg.conf
    echo "MAKEFLAGS=$MAKEFLAGS" >>/etc/makepkg.conf

    if [[ ! -d "$PKGOUT" ]]; then mkdir -p "$PKGOUT"; fi
    chown builder:builder "$PKGOUT"
    chmod 700 "$PKGOUT"
    pushd "$PKGOUT"
    find . -mindepth 1 -delete
    popd

    cp -rT "/pkgbuilds/${PACKAGE}" "${BUILDDIR}"
    chown -R builder:builder "${BUILDDIR}"

    pacman -Syu --noconfirm
}

function build-pkg() {
    sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" makepkg -s --noconfirm || { echo "Failed to build package!" && exit 1; }
}

setup-package-repo
setup-buildenv
interference-apply
build-pkg