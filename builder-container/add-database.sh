#!/usr/bin/env bash
set -e

# shellcheck disable=SC2120
function check-env() {
  if [ "$#" -eq 0 ]; then
    # Set reasonable defaults for our environment variables in case no
    # arguments were supplied
    ARCH=${ARCH:-"x86_64"}
    PACKAGES=${PACKAGES:-}
    REPO_NAME=${REPO_NAME:-"garuda"}
    WEB_ROOT=${WEB_ROOT:-"/srv/http/repo"}
    REPO_DIR=${REPO_DIR:-"$WEB_ROOT/$REPO_NAME/$ARCH"}
  elif [ "$#" -gt 3 ]; then
    # Use arguments in case no environment variables were supplied
    # add-repo.sh [ARCH] [LANDING_ZONE] [WEB_ROOT] [REPO_NAME] [PACKAGES1] [PACKAGES2] [...]
    ARCH="$1"
    LANDING_ZONE="$2"
    REPO_NAME="$4"
    WEB_ROOT="$3"
    REPO_DIR="$WEB_ROOT/$REPO_NAME/$ARCH"

    # Add all arguments after the first 4 to the PACKAGES array
    for ((i = 5; i <= $#; i++)); do
      PACKAGES+=("${!i}")
    done
  else
    echo "Invalid amount of arguments supplied, aborting execution!"
  fi

  return 0
}

function clean-duplicates() {
  set -euo pipefail

  if [[ ! -d "${REPO_DIR}" ]]; then
    echo 'Deploying directory not found!'
    return 0
  fi

  pushd "${REPO_DIR}" >/dev/null

  local _DUPLICATED _TO_MV _U_SURE

  _DUPLICATED=$(
    # shellcheck disable=SC2010
    ls |
      grep -Po "^(.*)(?=(?:(?:-[^-]*){3}\.pkg\.tar(?>\.xz|\.zst)?)\.sig$)" |
      uniq -d
  )

  if [[ -z "${_DUPLICATED}" ]]; then
    if [[ "${1:-}" != '-q' ]]; then
      echo '[!] No duplicate packages were found!'
    fi
  else
    _TO_MV=$(
      echo "${_DUPLICATED[@]}" |
        awk '{print "find -name \""$1"*\" -printf \"%T@ %p\\n\" | sort -n | grep -Po \"\\.\\/"$1"(((-[^-]*){3}\\.pkg\\.tar(?>\\.xz|\\.zst)?))\\.sig$\" | head -n -1;"}' |
        bash |
        awk '{sub(/\.sig$/,"");print $1"\n"$1".sig"}'
    )

    echo "[!] Moving duplicates:"
    echo "${_TO_MV[*]}"

    echo "[!] Total: $(echo -n "${_TO_MV[*]}" | wc -l)"
    if [[ "${1:-}" == '-q' ]]; then
      _U_SURE='Y'
    else
      read -r -p "[?] Are you sure? [y/N] " _U_SURE
    fi

    case "${_U_SURE}" in
    [yY])
      [ -d ../archive ] || mkdir ../archive
      # shellcheck disable=SC2086
      echo "${_TO_MV[@]}" | xargs mv -v -f -t ../archive/
      # Make sure we don't instantly delete them from archive if the package is too old
      echo "${_TO_MV[@]}" | xargs touch --no-create
      ;;
    esac
  fi

  popd >/dev/null # REPO_DIR

  return 0
}

function clean-archive() {
  set -euo pipefail

  # Let's save time!
  (clean-duplicates -q) || true

  if [[ ! -d "${REPO_DIR}/../archive" ]]; then
    echo 'Non-existing archive directory!'
    return 0
  fi

  pushd "${REPO_DIR}/../archive" >/dev/null

  find . -type f -mtime +7 -name '*' -execdir rm -- '{}' \; || true

  popd >/dev/null
  return 0
}

function clean-sigs() {
  set -euo pipefail

  local _TO_MV=()

  pushd "${REPO_DIR}" >/dev/null

  readarray -d '' _TO_MV < <(find . -name "*.pkg.tar.zst" -mmin +59 -exec sh -c '[[ ! -f "${1}.sig" ]]' -- "{}" \; -print0)
  readarray -d '' -O "${#_TO_MV[@]}" _TO_MV < <(find . -name "*.pkg.tar.zst.sig" -mmin +59 -exec sh -c '[[ ! -f "${1%.*}" ]]' -- "{}" \; -print0)

  if [[ -z "${_TO_MV:-}" ]]; then
    if [[ "${1:-}" != '-q' ]]; then
      echo '[!] Nothing to do...'
    fi
    exit 0
  fi

  echo '[!] Missing sig or package:'
  printf '%s\n' "${_TO_MV[@]}"

  echo "[!] Total: ${#_TO_MV[@]}"
  if [[ "${1:-}" == '-q' ]]; then
    _U_SURE='Y'
  else
    read -r -p "[?] Are you sure? [y/N] " _U_SURE
  fi

  case "${_U_SURE}" in
  [yY])
    # shellcheck disable=SC2086
    echo "${_TO_MV[@]}" | xargs mv -v -f -t ../archive/
    # Make sure we don't instantly delete them from archive if the package is too old
    echo "${_TO_MV[@]}" | xargs touch --no-create
    ;;
  esac

  popd >/dev/null

  return 0
}

function clean-landing-zone() {
    set -euo pipefail

    local _TO_DELETE=()

    pushd "${LANDING_ZONE}" >/dev/null

    readarray -d '' _TO_DELETE < <(find . -type f -mmin +15 -print0)

    if [[ -z "${_TO_DELETE:-}" ]]; then
        if [[ "${1:-}" != '-q' ]]; then
          echo '[!] No files to delete...'
        fi
        exit 0
    fi

    echo '[!] Deleting files from landing zone:'
    printf '%s\n' "${_TO_DELETE[@]}"

    echo "[!] Total: ${#_TO_DELETE[@]}"
    if [[ "${1:-}" == '-q' ]]; then
      _U_SURE='Y'
    else
      read -r -p "[?] Are you sure? [y/N] " _U_SURE
    fi

    case "${_U_SURE}" in
    [yY])
        # shellcheck disable=SC2086
        echo "${_TO_DELETE[@]}" | xargs rm -v
        ;;
    esac

    popd >/dev/null

    return 0
}

function sign() {
  # Sign our package using gpg
  if [[ ! -f "$LANDING_ZONE/$1" ]]; then
    echo "Package not found: $1"
    return 1
  else
    gpg --detach-sign \
      --use-agent \
      --no-armor \
      --yes \
      "$LANDING_ZONE/$1"
  fi

  return 0
}

function add-repo() {
  # Put files from our temporary upload directory into the repo directory
  mv "$LANDING_ZONE/$1" "$REPO_DIR" || { echo "Failed to move package: $1"; exit 1 ; }
  mv "$LANDING_ZONE/$1.sig" "$REPO_DIR" || { echo "Failed to move signature: $1.sig"; exit 1 ; }

  # Add the package to the repo database
  repo-add "$REPO_DIR/$REPO_NAME.db.tar.zst" "$REPO_DIR/$1" || { echo "Failed to add package to database: $1"; exit 1 ; }

  return 0
}

function db-pkglist() {
  set -euo pipefail

  pushd "${REPO_DIR}" >/dev/null
  if (tar -tv --zstd \
    -f "${REPO_NAME}.db.tar.zst" |
    awk '/^d/{print $6}' >../pkgs.txt); then

    if [[ -e ../pkgs.files.txt ]]; then
      mv ../pkgs.files.txt ../pkgs.files.old.txt
    fi

    ls -- *.pkg.* >../pkgs.files.txt

    #if [[ -e ../pkgs.files.old.txt ]]; then
    #  diff ../pkgs.files.old.txt ../pkgs.files.txt |
    #    grep '^[\<\>]' |
    #    deploy-notify "$@"
    #fi

    echo "Database's package list dumped"
  else
    echo "Failed to dump package list"
  fi
  popd >/dev/null # REPO_DIR

  return 0
}

function deploy-notify() {
  # Notify our deployment service that we've deployed a new package
  # telegram-send --pre markdown "$@" - replace echo once we enter production
  echo "$@"

  return 0
}

function post-deploy() {
  set -euo pipefail

  (clean-archive -q) || true
  (clean-sigs -q) || true
  (clean-landing-zone -q) || true

  # kill gpg-agent
  gpgconf --kill gpg-agent

  return 0
}

check-env "$@"
# delete gpg lock, we are guaranteed to be the only user of this container at any given time
rm -f /root/.gnupg/public-keys.d/pubring.db.lock
mkdir -p "$REPO_DIR"
for pkg in "${PACKAGES[@]}"; do
  sign "$pkg"
  add-repo "$pkg"
done
db-pkglist
post-deploy
