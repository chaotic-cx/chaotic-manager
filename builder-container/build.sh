#!/usr/bin/env bash

PKGOUT="/home/builder/pkgout/"
PACKAGE="$1"
BUILDDIR="/home/builder/build/"

set -eo pipefail

function print-if-failed {
	local output=""
	local exit=0
	output="$($@ 2>&1)" || exit=1
	if [[ $exit -ne 0 ]]; then
		echo "FATAL: Failed to execute $@:"
		echo "$output"
		return 1
	fi
}

function setup-package-repo {
	set -eo pipefail
	if [ -z "$PACKAGE_REPO_ID" ] || [ -z "$PACKAGE_REPO_URL" ]; then
		echo "FATAL: No package repository configured."
		return 1
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

function setup-buildenv {
	set -eo pipefail
	if [[ -z $PACKAGER ]]; then PACKAGER="Garuda Builder <team@garudalinux.org>"; fi
	if [[ -z $MAKEFLAGS ]]; then MAKEFLAGS="-j$(nproc)"; fi
	if [[ -z $PACKAGE ]]; then return 1; fi

	echo "PACKAGER=\"$PACKAGER\"" >>/etc/makepkg.conf
	echo "MAKEFLAGS=$MAKEFLAGS" >>/etc/makepkg.conf

	if [[ -v EXTRA_PACMAN_REPOS ]]; then echo "$EXTRA_PACMAN_REPOS" >>/etc/pacman.conf; fi

	if [[ ! -d "$PKGOUT" ]]; then mkdir -p "$PKGOUT"; fi
	chown builder:builder "$PKGOUT"
	chmod 700 "$PKGOUT"
	pushd "$PKGOUT"
	find . -mindepth 1 -delete
	popd

	cp -rT "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}" "${BUILDDIR}"
	chown -R builder:builder "${BUILDDIR}"

	pacman-key --init || return 1
    print-if-failed ./interfere.sh "$BUILDDIR" "$PACKAGE" || return 1
	if [[ -v EXTRA_PACMAN_KEYRINGS ]]; then pacman -U --noconfirm ${EXTRA_PACMAN_KEYRINGS[@]} || return 1; fi
}

function build-pkg {
	set -eo pipefail
	printf "\nBuilding package...\n"
	sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" makepkg -s --noconfirm || { echo "Failed to build package!" && return 1; }
}

function check-pkg {
	printf "\nChecking the package integrity with namcap...\n"
	namcap -i "$PKGOUT"/*.pkg.tar.zst
	printf "\n"
}

echo "Setting up package repository..."
print-if-failed setup-package-repo
echo "Setting up build environment..."
# Apply interference, this also does a pacman -Syu, which is why it's under setup-buildenv
print-if-failed setup-buildenv
build-pkg
check-pkg
