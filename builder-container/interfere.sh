#!/usr/bin/env bash
set -euo pipefail

source ./util.shlib

function interference-generic() {
	set -euo pipefail -o functrace

	# * Treats VCs
	if (echo "$PACKAGE" | grep -qP '\-git$'); then
		extra_pkgs+=("git")
		echo "Interfere applied: Added git."
	fi
	if (echo "$PACKAGE" | grep -qP '\-svn$'); then
		extra_pkgs+=("subversion")
		echo "Interfere applied: Added subversion."
	fi
	if (echo "$PACKAGE" | grep -qP '\-bzr$'); then
		extra_pkgs+=("breezy")
		echo "Interfere applied: Added breezy."
	fi
	if (echo "$PACKAGE" | grep -qP '\-hg$'); then
		extra_pkgs+=("mercurial")
		echo "Interfere applied: Added mercurial."
	fi

	# * Multilib
	if (echo "$PACKAGE" | grep -qP '^lib32-'); then
		extra_pkgs+=("multilib-devel")
		echo "Interfere applied: Added multilib-devel."
	fi

	# * Read options
	if (grep -qPo "^options=\([a-z! \"']*(?<!!)ccache[ '\"\)]" "${BUILDDIR}/PKGBUILD"); then
		extra_pkgs+=("ccache")
		echo "Interfere applied: Added ccache."
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
		echo "Interfere applied: Removed -march=native."
	fi

	return 0
}

function interference-pkgrel() {
  set -euo pipefail

  if [[ ! -v CONFIG[CI_PACKAGE_BUMP] ]]; then
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
  echo "Interfere applied: pkgrel increased by .${_BUMPCOUNT}."
}

function interference-apply() {
	set -euo pipefail

	local _PREPEND _PKGBUILD

	interference-generic

	# shellcheck source=/dev/null
	if [[ -f "${BUILDDIR}/.CI/prepare" ]]; then
	    # We need to move the prepare file to the build directory to keep existing ones working
	    # Those are usually relative to the build directory and not .CI and/or entry_point.sh
	    cp "${BUILDDIR}/.CI/prepare" "${BUILDDIR}/prepare"
	    pushd "${BUILDDIR}" >/dev/null
		source "${BUILDDIR}/prepare"
		popd >/dev/null
		echo 'Interfere applied: prepare script executed.'
	fi

	if [[ -f "${BUILDDIR}/.CI/interfere.patch" ]]; then
		if patch -Np1 <"${BUILDDIR}/.CI/interfere.patch"; then
			echo 'interfere: Patch applied.'
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
		echo "Interfere applied: PKGBUILD prepended."
	fi

	if [[ -f "${BUILDDIR}/.CI/PKGBUILD.append" ]]; then
		cat "${BUILDDIR}/.CI/PKGBUILD.append" >>"${BUILDDIR}/PKGBUILD"
		echo "Interfere applied: PKGBUILD appended."
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
