#!/bin/sh
set -eu
export CGO_ENABLED=1
if ! command -v "${CC:-cc}" >/dev/null 2>&1; then
 if command -v nix >/dev/null 2>&1; then
  exec nix shell nixpkgs#gcc --command "$0" "$@"
 fi
 echo 'Go native inference requires a C/C++ compiler (gcc or clang).' >&2
 exit 1
fi
exec go "$@"
