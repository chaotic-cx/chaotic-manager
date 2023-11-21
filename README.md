# Chaotic Managger

[![pipeline status](https://gitlab.com/garuda-linux/tools/chaotic-manager/badges/main/pipeline.svg)](https://gitlab.com/garuda-linux/tools/chaotic-manager/-/commits/main)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)

## Found any issue?

- If any issues with this application occur, please open a new issue to let us know about it - you can click [here](https://gitlab.com/garuda-linux/tools/chaotic-manager/-/issues/new) to start the process.

## How to contribute?

We highly appreciate contributions of any sort! 😊 To do so, please follow these steps:

- [Create a fork of this repository](https://gitlab.com/garuda-linux/tools/chaotic-manager/-/forks/new).
- Clone your fork locally ([short git tutorial](https://rogerdudler.github.io/git-guide/)).
- Add the desired changes to the source code
- Commit using a [conventional commit message](https://www.conventionalcommits.org/en/v1.0.0/#summary) and push any changes back to your fork. This is crucial as it allows our CI to generate changelogs easily.
  - The [commitizen](https://github.com/commitizen-tools/commitizen) application helps with creating a fitting commit message.
  - You can install it via [pip](https://pip.pypa.io/) as there is currently no package in Arch repos: `pip install --user -U Commitizen`.
  - Then proceed by running `cz commit` in the cloned folder.
- [Create a new merge request at our main repository](https://gitlab.com/garuda-linux/tools/chaotic-manager/-/merge_requests/new).
- Check if any of the pipeline runs fail and apply eventual suggestions.

We will then review the changes and eventually merge them.

## Making use of it

This repository currently provides two Docker images:

- `registry.gitlab.com/garuda-linux/tools/chaotic-manager/manager` - manages the builder container
- `registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder` - builds PKGBUILD sources

## Automated builds

The `builder` container is getting updated once per day via pipeline schedules.
