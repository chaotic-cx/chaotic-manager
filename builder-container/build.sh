#!/usr/bin/env bash
set -eo pipefail

source ./util.shlib

PKGOUT="/home/builder/pkgout/"
SRCDEST="/home/builder/srcdest/"
SRCDEST_CACHED="/home/builder/srcdest_cached/"

PACKAGE="$1"
BUILDDIR="/home/builder/build/"
[[ -z $BUILDER_HOSTNAME ]] && BUILDER_HOSTNAME="unknown builder (please supply BUILDER_HOSTNAME via Docker environment)"
[[ -z $BUILDER_TIMEOUT ]] && BUILDER_TIMEOUT=3600

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
		if [ ! -d /pkgbuilds ]; then
			echo "FATAL: No package repository configured."
			return 1
		fi
		PACKAGE_REPO_ID="."
		return 0
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

function setup-extra-keyrings {
    # shellcheck disable=SC2068
    if [[ -n "$EXTRA_PACMAN_KEYRINGS" ]]; then pacman -U --noconfirm ${EXTRA_PACMAN_KEYRINGS[@]} || return 1; fi
}

function setup-build-configs {
    # Don't silence interfere.sh to be able to print information about what exactly got interfered.
    ./interfere.sh "$BUILDDIR" "$PACKAGE" || return 1
    print-if-failed setup-extra-keyrings

    declare -A CONFIG
    if [ -f "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}/.CI/config" ]; then
    	UTIL_READ_VARIABLES_FROM_FILE "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}/.CI/config" CONFIG
        # In case we want to cache sources for heavier packages. This should be used only if really needed.
        if [ -v "CONFIG[BUILDER_CACHE_SOURCES]" ] && [ "${CONFIG[BUILDER_CACHE_SOURCES]}" == "true" ] && [ -d "$SRCDEST_CACHED" ]; then
            echo "Will cache sources..."

			# Make sure we have the appropriate permissions to modify the mounted directory
			chown builder:builder "$SRCDEST_CACHED"

            SRCDEST="${SRCDEST_CACHED}"
            if [[ ! -f "$SRCDEST/.timestamp" ]]; then
                touch "$SRCDEST/.timestamp"
            fi
        fi
    fi
}

function setup-buildenv {
	set -eo pipefail
	if [[ -z $PACKAGER ]]; then PACKAGER="Garuda Builder <team@garudalinux.org>"; fi
	if [[ -z $MAKEFLAGS ]]; then MAKEFLAGS="-j$(nproc)"; fi
	if [[ -z $PACKAGE ]]; then return 1; fi

	echo "PACKAGER=\"$PACKAGER\"" >>/etc/makepkg.conf
	echo "MAKEFLAGS=$MAKEFLAGS" >>/etc/makepkg.conf

	if [[ -n "$EXTRA_PACMAN_REPOS" ]]; then echo "$EXTRA_PACMAN_REPOS" >>/etc/pacman.conf; fi

	if [[ ! -d "$PKGOUT" ]]; then mkdir -p "$PKGOUT"; fi
	chown builder:builder "$PKGOUT"
	chmod 700 "$PKGOUT"

	cp -rT "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}" "${BUILDDIR}"
	chown -R builder:builder "${BUILDDIR}"

	pacman-key --init || return 1
}

function build-pkg {
	set -eo pipefail
	printf "Building package...\n"

	# Timeout ensures that the build process doesn't hang indefinitely, sending the kill signal if it still hangs 10 seconds after sending the term signal
	sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" SRCDEST="${SRCDEST}" timeout -k 10 "${BUILDER_TIMEOUT}" makepkg --skippgpcheck -s --noconfirm || { local ret=$? && echo "Failed to build package!" >&2 && return $ret; }
	find "${PKGOUT}" -type f -empty -delete || return 1
}

function check-pkg {
	printf "\nChecking the package integrity with namcap...\n"
	namcap -i "$PKGOUT"/*.pkg.tar.zst
	printf "\n"
}

printf "\nExecuting build on host %s.\n" "$BUILDER_HOSTNAME"
echo "Setting up package repository..."
print-if-failed setup-package-repo
echo "Setting up build environment..."
# Apply interference, this also does a pacman -Syu, which is why it's under setup-buildenv
print-if-failed setup-buildenv
setup-build-configs
build-pkg
check-pkg
