#!/usr/bin/env bash

set -e

PKGOUT="/home/builder/pkgout/"
PACKAGE="$1"
BUILDDIR="/home/builder/build/"

function setup-package-repo() {
    if [ ! -d /pkgbuilds ]; then mkdir /pkgbuilds; fi
    chown root:root /pkgbuilds
    chmod 700 /pkgbuilds
    pushd /pkgbuilds
    if [ ! -d .git ]; then
        git init
        git remote add origin https://gitlab.com/garuda-linux/pkgsbuilds-aur.git
    fi
    git fetch origin main --depth=1
    git reset --hard origin/main
    popd
}

function setup-buildenv() {
    if [[ -z $PACKAGER ]]; then PACKAGER="Garuda Builder <team@garudalinux.org>"; fi
    if [[ -z $MAKEFLAGS ]]; then MAKEFLAGS="-j$(nproc)"; fi
    if [[ -z $PACKAGE ]]; then exit 1; fi

    echo "PACKAGER=\"$PACKAGER\"" >>/etc/makepkg.conf
    echo "MAKEFLAGS=$MAKEFLAGS" >>/etc/makepkg.conf

    chown builder:builder "$PKGOUT"
    chmod 700 "$PKGOUT"
    pushd "$PKGOUT"
    find . -mindepth 1 -delete
    popd

    cp -rT "/pkgbuilds/${PACKAGE}" "${BUILDDIR}"
    chown -R builder:builder "${BUILDDIR}"
}

function build-pkg() {
    sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" makepkg -s --noconfirm || { echo "Failed to build package!" && exit 1; }
}

setup-package-repo
setup-buildenv
build-pkg