#!/usr/bin/env sh
set -eu
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to an isolated PostgreSQL test database}"
export CGO_ENABLED=0
go test ./... -count=1
go vet ./...
pnpm --dir web test --run
pnpm --dir web build

pnpm --dir update-worker check
pnpm --dir update-worker test
python3 scripts/check_release_test.py
