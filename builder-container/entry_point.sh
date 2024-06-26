#!/usr/bin/env bash

set -e

case "$1" in
"build")
	shift
	exec ./build.sh "$@"
	;;
"repo-add")
	shift
	exec ./add-database.sh "$@"
	;;
"auto-repo-remove")
	shift
	exec ./auto-database-remove.sh "$@"
	;;
*)
	echo "Invalid argument. Please specify 'build' or 'repo-add'."
	exit 1
	;;
esac
