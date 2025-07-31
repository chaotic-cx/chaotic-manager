#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=util.shlib
source ./util.shlib

# Return interferes
APPLIED_INTERFERES=()

function interference-generic() {
	set -euo pipefail -o functrace

	# * Treats VCs
	if (echo "$PACKAGE" | grep -qP '\-git$'); then
		extra_pkgs+=("git")
		echo ":: Interfere applied: Added git."
		APPLIED_INTERFERES+=("Added git build environment")
	fi
	if (echo "$PACKAGE" | grep -qP '\-svn$'); then
		extra_pkgs+=("subversion")
		echo ":: Interfere applied: Added subversion."
		APPLIED_INTERFERES+=("Added subversion build environment")
	fi
	if (echo "$PACKAGE" | grep -qP '\-bzr$'); then
		extra_pkgs+=("breezy")
		echo "Interfere applied: Added breezy."
		APPLIED_INTERFERES+=("Added breezy build environment")
	fi
	if (echo "$PACKAGE" | grep -qP '\-hg$'); then
		extra_pkgs+=("mercurial")
		echo ":: Interfere applied: Added mercurial."
		APPLIED_INTERFERES+=("Added mercurial build environment")
	fi

	# * Multilib
	if (echo "$PACKAGE" | grep -qP '^lib32-'); then
		extra_pkgs+=("multilib-devel")
		echo ":: Interfere applied: Added multilib-devel."
		APPLIED_INTERFERES+=("Added multilib-devel build environment")
	fi

	# * Read options
	if (grep -qPo "^options=\([a-z! \"']*(?<!!)ccache[ '\"\)]" "${BUILDDIR}/PKGBUILD"); then
		extra_pkgs+=("ccache")
		echo ":: Interfere applied: Added ccache."
		APPLIED_INTERFERES+=("Added ccache build environment")
	fi

	# * CHROOT Update
	pacman -Syu --noconfirm "${extra_pkgs[@]}"

	# * Add missing newlines at end of file
	# * Get rid of troublesome options
	{
		echo -e '\n\n\n'
		unset PKGEXT
	} >>"${BUILDDIR}/PKGBUILD"

	# * Get rid of 'native optimizations'
	if (grep -qP '\-march=native' "${BUILDDIR}/PKGBUILD"); then
		sed -i'' 's/-march=native//g' "${BUILDDIR}/PKGBUILD"
		echo ":: Interfere applied: Removed -march=native."
		APPLIED_INTERFERES+=("Removed -march=native from PKGBUILD")
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
fi" >>"${BUILDDIR}/PKGBUILD"
  echo ":: Interfere applied: pkgrel will be bumped by .${_BUMPCOUNT} if the detected version is ${_PKGVER}"
  APPLIED_INTERFERES+=("pkgrel will be bumped by .${_BUMPCOUNT} if the detected version is ${_PKGVER}")
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
		echo ':: Interfere applied: prepare script executed.'
		APPLIED_INTERFERES+=("Executed prepare script")
	fi

	if [[ -f "${BUILDDIR}/.CI/interfere.patch" ]]; then
		if patch -Np1 <"${BUILDDIR}/.CI/interfere.patch"; then
			echo ':: Interfere applied: custom patch.'
			APPLIED_INTERFERES+=("Custom patch applied")
		else
			echo ':: Ignoring patch failure...'
			APPLIED_INTERFERES+=("Patch failed to apply")
		fi
	fi

	if [[ -f "${BUILDDIR}/.CI/PKGBUILD.prepend" ]]; then
		# The worst one, but KISS and easier to maintain
		_PREPEND="$(cat "${BUILDDIR}/.CI/PKGBUILD.prepend")"
		_PKGBUILD="$(cat "${BUILDDIR}/PKGBUILD")"
		echo "$_PREPEND" >"${BUILDDIR}/PKGBUILD"
		echo "$_PKGBUILD" >>"${BUILDDIR}/PKGBUILD"
		echo ":: Interfere applied: PKGBUILD prepended."
		APPLIED_INTERFERES+=("PKGBUILD prepended")
	fi

	if [[ -f "${BUILDDIR}/.CI/PKGBUILD.append" ]]; then
		cat "${BUILDDIR}/.CI/PKGBUILD.append" >>"${BUILDDIR}/PKGBUILD"
		echo ":: Interfere applied: PKGBUILD appended."
		APPLIED_INTERFERES+=("PKGBUILD appended")
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

# Print applied interferes at the end of the log again, to make
# it easier to find them for our maintainers.
if [ ${#APPLIED_INTERFERES[@]} -eq 0 ]; then
    printf ":: Maintainer info: no interferes applied.\n\n" >/tmp/interfere.log
else
    printf ":: Maintainer info: applied the interferes below.\n" >/tmp/interfere.log
    printf ':: * %s\n' "${APPLIED_INTERFERES[@]}" >>/tmp/interfere.log
fi
