#!/usr/bin/env bash

set -e

PKGOUT="/home/builder/pkgout/"
PACKAGE="$1"
BUILDDIR="/home/builder/build/"

# shellcheck source=/dev/null
source ./interfere.sh

function setup-package-repo() {
    printf "\nSetting up package repository...\n"
    if [ -z "$PACKAGE_REPO_ID" ] || [ -z "$PACKAGE_REPO_URL" ]; then
        echo "FATAL: No package repository configured."
        exit 1
    fi
    # Migration
    if [ -d /pkgbuilds/.git ]; then find /pkgbuilds -mindepth 1 -delete; fi
    # Only executed when dealing with ephemeral /pkgbuilds
    if [ ! -d /pkgbuilds ]; then mkdir /pkgbuilds; fi
    chown root:root /pkgbuilds
    chmod 755 /pkgbuilds
    pushd /pkgbuilds
    if [ ! -d "$PACKAGE_REPO_ID/.git" ]; then
        rm -rf "$PACKAGE_REPO_ID"
        mkdir "$PACKAGE_REPO_ID"
        pushd "$PACKAGE_REPO_ID"
        chown root:root .
        chmod 755 .
        # Silence log output by setting a default main branch name
        git config --global init.defaultBranch main
        git init
        git remote add origin "$PACKAGE_REPO_URL"
    else
        pushd "$PACKAGE_REPO_ID"
        git remote set-url origin "$PACKAGE_REPO_URL"
    fi
    GIT_TERMINAL_PROMPT=0 git fetch origin main --depth=1
    git reset --hard origin/main
    popd
    popd
}

function setup-buildenv() {
    printf "\nSetting up build environment...\n"
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

    cp -rT "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}" "${BUILDDIR}"
    chown -R builder:builder "${BUILDDIR}"

    pacman -Syu --noconfirm
}

function build-pkg() {
    printf "\nBuilding package...\n"
    sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" makepkg -s --noconfirm || { echo "Failed to build package!" && exit 1; }
}

function check-pkg() {
    printf "\nChecking the package integrity with namcap...\n"
    namcap -i "$PKGOUT"/*.pkg.tar.zst
}

setup-package-repo
setup-buildenv
interference-apply
build-pkg
check-pkg
