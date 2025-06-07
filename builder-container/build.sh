#!/usr/bin/env bash
set -eo pipefail

# shellcheck source=util.shlib
source ./util.shlib

PKGOUT="/home/builder/pkgout/"
SRCDEST="/home/builder/srcdest/"
SRCDEST_CACHED="/home/builder/srcdest_cached"
TEMPOUT="/home/builder/tempOut/"

PACKAGE="$1"
BUILDDIR="/home/builder/build/"

[[ -z $BUILDER_HOSTNAME ]] && BUILDER_HOSTNAME="unknown builder (please supply BUILDER_HOSTNAME via Docker environment)"
[[ -z $BUILDER_TIMEOUT ]] && BUILDER_TIMEOUT=3600
[[ -z $CI_CODE_SKIP ]] && CI_CODE_SKIP=123

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
	popd # $PACKAGE_REPO_ID
	popd # /pkgbuilds
}

function setup-extra-keyrings {
    # shellcheck disable=SC2068
    if [[ -n "$EXTRA_PACMAN_KEYRINGS" ]]; then pacman -U --noconfirm ${EXTRA_PACMAN_KEYRINGS[@]} || return 1; fi
}

function setup-build-configs {
    # Specifically set up the keyrings BEFORE interfere, so we can install packages that are not in the main keyring
    print-if-failed setup-extra-keyrings

    # Don't silence interfere.sh to be able to print information about what exactly got interfered.
    ./interfere.sh "$BUILDDIR" "$PACKAGE"

    # If the interfere script exits with the defined exit code for intended skips,
    # we should exit the build process gracefully and return the same code to the manager instance.
    exit_code=$?
    if [[ $exit_code -eq $CI_CODE_SKIP ]]; then
        echo "Skipping build process intentionally."
        exit "$CI_CODE_SKIP"
    elif [[ $exit_code -ne 0 ]]; then
        echo "Interfere script failed with exit code $exit_code."
        exit "$exit_code"
    fi

    declare -A CONFIG
    if [ -f "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}/.CI/config" ]; then
    	UTIL_READ_VARIABLES_FROM_FILE "/pkgbuilds/${PACKAGE_REPO_ID}/${PACKAGE}/.CI/config" CONFIG
        # In case we want to cache sources for heavier packages. This should be used only if really needed.
        if [ -v "CONFIG[BUILDER_CACHE_SOURCES]" ] && [ "${CONFIG[BUILDER_CACHE_SOURCES]}" == "true" ] && [ -f "$SRCDEST_CACHED/.timestamp" ]; then
            echo "Will cache sources..."

			# Make sure we have the appropriate permissions to modify the mounted directory
			chown builder:builder "$SRCDEST_CACHED"

            SRCDEST="${SRCDEST_CACHED}"
        fi

		# In case we want to override the global timeout for a specific package. Useful for e.g. Ungoogled Chromium or kernels.
		if [[ -v "CONFIG[BUILDER_EXTRA_TIMEOUT]" ]]; then
			BUILDER_TIMEOUT=$(($"${CONFIG[BUILDER_EXTRA_TIMEOUT]}" * "$BUILDER_TIMEOUT"))
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

	if [[ -n "$PACMAN_REPO" ]]; then
		# Prepend the given repository to the pacman.conf.d/mirrorlist
		local current_mirrorlist
		current_mirrorlist=$(cat /etc/pacman.d/mirrorlist)
		echo "Server = $PACMAN_REPO" > /etc/pacman.d/mirrorlist
		echo "$current_mirrorlist" >> /etc/pacman.d/mirrorlist

		echo "Prepended custom Archlinux repository to /etc/pacman.d/mirrorlist:"
		echo "  - $PACMAN_REPO"
	fi

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
	time sudo -D "${BUILDDIR}" -u builder PKGDEST="${PKGOUT}" SRCDEST="${SRCDEST}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout -k 10 "${BUILDER_TIMEOUT}" makepkg --skippgpcheck -s --noconfirm || { local ret=$? && echo "Didn't finish building the package!" >&2 && return $ret; }
	find "${PKGOUT}" -type f -empty -delete || return 1
}

function check-pkg {
	printf "\nChecking the package integrity with namcap...\n"
	# These should not fail the build due to namcap bugs.
	# The build already succeeded. Also log to TEMPOUT for builder service to pick up.
    namcap -mi "$PKGOUT"/*.pkg.tar.zst | tee "$TEMPOUT/$PACKAGE.namcap" || true
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

if test -f /tmp/interfere.log; then
    cat /tmp/interfere.log
fi
