#!/usr/bin/env bash

set -euo pipefail

# $1: database name
# $2: space separated list of intended packages

declare -A PACKAGES

# shellcheck disable=SC2120
function check-env() {
	if [ "$#" -gt 3 ]; then
		# Use arguments in case no environment variables were supplied
		# add-repo.sh [ARCH] [WEB_ROOT] [REPO_NAME] [PACKAGES1] [PACKAGES2] [...]
		ARCH="$1"
		REPO_NAME="$3"
		WEB_ROOT="$2"
		REPO_DIR="$WEB_ROOT/$REPO_NAME/$ARCH"

		# Add all arguments after the first 3 to the PACKAGES array
		for ((i = 4; i <= $#; i++)); do
			PACKAGES["${!i}"]=1
		done
	else
		echo "Invalid amount of arguments supplied, aborting execution!"
		exit 1
	fi

	return 0
}

if [[ $# -lt 2 ]]; then
	echo "Usage: $0 <database> <packages>"
	exit 1
fi

check-env "$@"

TEMP="$(mktemp -d)"

if [[ ! -f "$REPO_DIR/$REPO_NAME.db" ]]; then
	echo "Database $REPO_NAME.db not found in $REPO_DIR"
	exit 1
fi

if ! DBFILE="$(realpath "$REPO_DIR/$REPO_NAME.db")" || [ -z "$DBFILE" ] || [[ ! -f "$DBFILE" ]]; then
	echo "Database $REPO_NAME.db not found in $REPO_DIR"
	exit 1
fi

tar -xf "$DBFILE" -C "$TEMP"

declare -A PKGBASES
declare -A BUILDDATES
declare -A PKGFILES
declare -A PKGBASE_BUILDDATES

declare -a TO_REMOVE=()

while read -r pkgfile pkgname pkgbase builddate; do
	# shellcheck disable=SC2128
	if [[ ! -v PACKAGES["$pkgbase"] ]]; then
		TO_REMOVE+=("$pkgname")
		rm -f "${REPO_DIR}/${pkgfile}" "${REPO_DIR}/${pkgfile}.sig"
		continue
	fi

	PKGBASES["$pkgname"]="${pkgbase}"
	BUILDDATES["$pkgname"]="${builddate}"
	PKGFILES["$pkgname"]="${pkgfile}"

	if [[ -v PKGBASE_BUILDDATES["$pkgbase"] ]]; then
		if [[ "${PKGBASE_BUILDDATES["$pkgbase"]}" -lt "$builddate" ]]; then
			PKGBASE_BUILDDATES["$pkgbase"]="$builddate"
		fi
	else
		PKGBASE_BUILDDATES["$pkgbase"]="$builddate"
	fi
done < <(find "$TEMP" -maxdepth 2 -name 'desc' -exec awk -f ./parse-database.awk {} +)

for pkg in "${!PKGBASES[@]}"; do
	pkgbase="${PKGBASES["$pkg"]}"
	builddate="${BUILDDATES["$pkg"]}"
	pkgfile="${PKGFILES["$pkg"]}"
	pkgbase_builddate="${PKGBASE_BUILDDATES["$pkgbase"]}"

	if [[ "$builddate" -ne "$pkgbase_builddate" ]]; then
		TO_REMOVE+=("$pkg")
		rm -f "${REPO_DIR}/${pkgfile}" "${REPO_DIR}/${pkgfile}.sig"
	fi
done

if [[ "${#TO_REMOVE[@]}" -eq 0 ]]; then
	echo "No packages to remove"
	exit 0
fi

echo "Removing ${#TO_REMOVE[@]} packages from database"

repo-remove "$DBFILE" "${TO_REMOVE[@]}"
