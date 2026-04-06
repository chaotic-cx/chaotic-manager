#!/usr/bin/env bash

if [ "$1" == "podman" ]; then
  podman build -t registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest .
else
  docker build -t registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest .
fi
