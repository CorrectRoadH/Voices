#!/usr/bin/env bash
set -euo pipefail
version=1.7.12
destination="${RUNNER_TEMP:?}/actionlint"
mkdir -p "$destination"
cd "$destination"
asset="actionlint_${version}_linux_amd64.tar.gz"
base="https://github.com/rhysd/actionlint/releases/download/v${version}"
curl --fail --silent --show-error --location --retry 3 --output "$asset" "$base/$asset"
curl --fail --silent --show-error --location --retry 3 --output checksums.txt "$base/actionlint_${version}_checksums.txt"
awk -v asset="$asset" '$2 == asset { print }' checksums.txt > selected-checksum.txt
test "$(wc -l < selected-checksum.txt)" = 1
sha256sum --check selected-checksum.txt
tar -xzf "$asset" actionlint
