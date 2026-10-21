#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?请设置指向隔离 PostgreSQL 的 TEST_DATABASE_URL}"
export CGO_ENABLED=0
export VOICES_BROWSER_TEST=1
export E2E_TELEMETRY_DISABLED=1
pnpm --dir web build
go test ./internal/app -run '^(TestAdministrationInsightsBrowser|TestBrowserFullStack|TestAccountsBrowserFullStack|TestInterfaceLanguageBrowser|TestLLMModelsBrowser|TestServerSettingsBrowser|TestUpdatesBrowser|TestOnboardingBrowser)$' -count=1 -v -timeout=15m
