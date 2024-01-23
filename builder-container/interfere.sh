#!/usr/bin/env bash

set -euo pipefail

function UTIL_READ_VARIABLES_FROM_FILE() {
    local file=$1
    local -n READ_ASSOC_ARRAY=${2:-VARIABLES}
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*([a-zA-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$ ]]; then
            READ_ASSOC_ARRAY["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
        fi
    done < "$file"
}

function interference-generic() {
	set -euo pipefail -o functrace

	# * Treats VCs
	if (echo "$PACKAGE" | grep -qP '\-git$'); then
		extra_pkgs+=("git")
	fi
	if (echo "$PACKAGE" | grep -qP '\-svn$'); then
		extra_pkgs+=("subversion")
	fi
	if (echo "$PACKAGE" | grep -qP '\-bzr$'); then
		extra_pkgs+=("breezy")
	fi
	if (echo "$PACKAGE" | grep -qP '\-hg$'); then
		extra_pkgs+=("mercurial")
	fi

	# * Multilib
	if (echo "$PACKAGE" | grep -qP '^lib32-'); then
		extra_pkgs+=("multilib-devel")
	fi

	# * Special cookie for TKG kernels
	if (echo "$PACKAGE" | grep -qP '^linux.*tkg'); then
		extra_pkgs+=("git")
	fi

	# * Read options
	if (grep -qPo "^options=\([a-z! \"']*(?<!!)ccache[ '\"\)]" "${BUILDDIR}/PKGBUILD"); then
		extra_pkgs+=("ccache")
	fi

	# * CHROOT Update
	pacman -Syu --noconfirm "${extra_pkgs[@]}"

	# * Add missing newlines at end of file
	# * Get rid of troublesome options
	{
		echo -e '\n\n\n'
		echo "PKGEXT='.pkg.tar.zst'"
		echo 'unset groups'
		echo 'unset replaces'
	} >>"${BUILDDIR}/PKGBUILD"

	# * Get rid of 'native optimizations'
	if (grep -qP '\-march=native' "${BUILDDIR}/PKGBUILD"); then
		sed -i'' 's/-march=native//g' "${BUILDDIR}/PKGBUILD"
	fi

	return 0
}

function interference-pkgrel() {
  set -euo pipefail

  if [ ! -v CONFIG[CI_PACKAGE_BUMP] ]; then
    return 0
  fi

  local _PKGVER _BUMPCOUNT
  # Example format: 1:1.2.3-1/1 or 1.2.3
  # Split at slash, but if it doesnt exist, set it to 1
  _PKGVER="${CONFIG[CI_PACKAGE_BUMP]%%/*}"
  _BUMPCOUNT="${CONFIG[CI_PACKAGE_BUMP]#*/}"
  if [[ "${_BUMPCOUNT}" == "${CONFIG[CI_PACKAGE_BUMP]}" ]]; then
	_BUMPCOUNT=1
  fi

  echo "if [ \"\$(vercmp \"${_PKGVER}\" \"\${epoch:-0}:\$pkgver-\$pkgrel\")\" = \"0\" ]; then
  pkgrel=\"\$pkgrel.${_BUMPCOUNT}\"
fi" >>PKGBUILD
}

function interference-apply() {
	set -euo pipefail

	local _PREPEND _PKGBUILD

	interference-generic

	# shellcheck source=/dev/null
	if [[ -f "${BUILDDIR}/.CI/prepare" ]]; then
		source "${BUILDDIR}/prepare"
	fi

	if [[ -f "${BUILDDIR}/.CI/interfere.patch" ]]; then
		if patch -Np1 <"${BUILDDIR}/.CI/interfere.patch"; then
			echo 'Patches successfully applied.'
		else
			echo 'Ignoring patch failure...'
		fi
	fi

	if [[ -f "${BUILDDIR}/.CI/PKGBUILD.prepend" ]]; then
		# The worst one, but KISS and easier to maintain
		_PREPEND="$(cat "${BUILDDIR}/.CI/PKGBUILD.prepend")"
		_PKGBUILD="$(cat "${BUILDDIR}/PKGBUILD")"
		echo "$_PREPEND" >"${BUILDDIR}/PKGBUILD"
		echo "$_PKGBUILD" >>"${BUILDDIR}/PKGBUILD"
	fi

	if [[ -f "${BUILDDIR}/.CI/PKGBUILD.append" ]]; then
		cat "${BUILDDIR}/.CI/PKGBUILD.append" >>"${BUILDDIR}/PKGBUILD"
	fi

	interference-pkgrel

	return 0
}

BUILDDIR="$1"
PACKAGE="$2"
declare -A CONFIG
if [ -f "${BUILDDIR}/.CI/config" ]; then
	UTIL_READ_VARIABLES_FROM_FILE "${BUILDDIR}/.CI/config" CONFIG
fi
interference-apply