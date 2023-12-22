#!/usr/bin/env bash

function special-interference-needed() {
	# Determines whether an interference got applied or not
	# if it did, it will add the chaotic-interfere optdepends
	# so every maintainer about knows what's going on
	local _INTERFERE
	_INTERFERE=0

	for interfere in PKGBUILD.append PKGBUILD.prepend interfere.patch prepare; do
		if [[ -e "${BUILDDIR}/${interfere}" ]]; then
			echo "Interfering via ${interfere}.."
			((_INTERFERE++))
		fi
	done

	# In case we need to bump pkgrel
	if [[ -e "${BUILDDIR}/.CI_CONFIG" ]]; then
		# shellcheck source=/dev/null
		source "${BUILDDIR}/.CI_CONFIG"
		[[ -n "$CI_PKGREL" ]] && ((_INTERFERE++))
	fi

	if [[ "${_INTERFERE}" -gt 0 ]]; then
		echo 'optdepends+=("chaotic-interfere")' >>"${BUILDDIR}"/PKGBUILD
	else
		return 0
	fi
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

function interference-apply() {
	set -euo pipefail

	local _PREPEND _PKGBUILD

	interference-generic

	special-interference-needed

	# shellcheck source=/dev/null
	[[ -f "${BUILDDIR}/prepare" ]] &&
		source "${BUILDDIR}/prepare"

	if [[ -f "${BUILDDIR}/interfere.patch" ]]; then
		if patch -Np1 <"${BUILDDIR}/interfere.patch"; then
			echo 'Patches successfully applied.'
		else
			echo 'Ignoring patch failure...'
		fi
	fi

	if [[ -f "${BUILDDIR}/PKGBUILD.prepend" ]]; then
		# The worst one, but KISS and easier to maintain
		_PREPEND="$(cat "${BUILDDIR}/PKGBUILD.prepend")"
		_PKGBUILD="$(cat "${BUILDDIR}/PKGBUILD")"
		echo "$_PREPEND" >"${BUILDDIR}/PKGBUILD"
		echo "$_PKGBUILD" >>"${BUILDDIR}/PKGBUILD"
	fi

	[[ -f "${BUILDDIR}/PKGBUILD.append" ]] &&
		cat "${BUILDDIR}/PKGBUILD.append" >>"${BUILDDIR}/PKGBUILD"

	if [[ -f "${BUILDDIR}/.CI_CONFIG" ]]; then
		# shellcheck source=/dev/null
		source "${BUILDDIR}/.CI_CONFIG"
		if [[ -n "$CI_PKGREL" ]]; then
			# shellcheck source=/dev/null
			source PKGBUILD
			# shellcheck disable=SC2154 # sourced from PKGBUILD
			_NEW_PKGREL="$(printf "%s.%s" "$pkgrel" "$CI_PKGREL")"
			sed -i "s/pkgrel=.*/pkgrel=${CI_PKGREL}/" "${BUILDDIR}/PKGBUILD"
		fi
	fi

	return 0
}
