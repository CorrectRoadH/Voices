#!/bin/sh
# Build inside target-native Debian Bookworm; output is independent of Go cache.
set -eu
out=${1:?output directory required}
mkdir -p "$out/lib" "$out/licenses" "$out/testdata"
export CGO_ENABLED=1
export CGO_LDFLAGS='-lstdc++ -Wl,-rpath,$ORIGIN/lib'
go build -trimpath -ldflags="-s -w -X main.version=${VOICES_VERSION:-dev}" -o "$out/voices" ./cmd/voices
go test -c -o "$out/native-test" ./internal/voiceprints
module=$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-linux)
case $(go env GOARCH) in
 amd64) arch=x86_64-unknown-linux-gnu ;;
 arm64) arch=aarch64-unknown-linux-gnu ;;
 *) echo 'Unsupported release architecture' >&2; exit 1 ;;
esac
cp "$module/lib/$arch/libsherpa-onnx-c-api.so" "$module/lib/$arch/libonnxruntime.so" "$out/lib/"
cp internal/voiceprints/assets/*LICENSE "$out/licenses/"
cp "$module/LICENSE" "$out/licenses/SHERPA-LICENSE"
cp internal/voiceprints/testdata/speech.wav "$out/testdata/"
cp docs/release-package.txt "$out/README.txt"
