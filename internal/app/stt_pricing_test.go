package app

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"voices/internal/persistence"
)

// Historical price fixtures seed persisted data directly; production exposes no write API.
type sttPriceInput struct {
	Provider    string `json:"provider"`
	Model       string `json:"model"`
	Currency    string `json:"currency"`
	Basis       string `json:"basis"`
	Hourly      string `json:"hourly_rate_microusd"`
	Diarization string `json:"diarization_hourly_rate_microusd"`
	Source      string `json:"source"`
	VerifiedOn  string `json:"verified_on"`
}

func priceInput() sttPriceInput {
	return sttPriceInput{Provider: "soniox", Model: "stt-async-v5", Currency: "USD", Basis: "duration_estimate", Hourly: "100000", Diarization: "20000", Source: "https://soniox.com/pricing", VerifiedOn: "2026-11-09"}
}
func savePrice(t *testing.T, f *fixture, in sttPriceInput) string {
	t.Helper()
	id := uuid.NewString()
	_, err := f.db.Exec(context.Background(), `INSERT INTO stt_price_versions(id,provider,model,currency,basis,hourly_rate_microusd,diarization_hourly_rate_microusd,source,verified_on,created_by) VALUES($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8,$9::date,$10)`, id, in.Provider, in.Model, in.Currency, in.Basis, in.Hourly, in.Diarization, in.Source, in.VerifiedOn, userID(t, f))
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func sttItems(t *testing.T, f *fixture, q string) []any {
	t.Helper()
	_, v := f.json(t, "GET", "/api/v1/admin/stt/calls"+q, nil, 200, "")
	return v["items"].([]any)
}
func sttTotals(t *testing.T, f *fixture, q string) map[string]any {
	t.Helper()
	_, v := f.json(t, "GET", "/api/v1/admin/stt/summary"+q, nil, 200, "")
	return v["totals"].(map[string]any)
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingValidation(t *testing.T) {
	for _, q := range []string{"provider=soniox%20assemblyai", "state=failed%20cancelled", "limit=101", "cursor=abc", "from=bad", "from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z", "owner_id=bad", "model=x&model=y", "expand=recording", "history=true"} {
		if _, err := parseSTTQuery(httptest.NewRequest("GET", "/api?"+q, nil), false); err == nil {
			t.Fatal(q)
		}
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingSubmitSnapshotRetranscribeAndDeletion(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	ctx := context.Background()
	p := priceInput()
	firstPrice := savePrice(t, f, p)
	out := f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	rid := out["recording"].(map[string]any)["id"].(string)
	f.run(t, "prepare")
	j, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	// Crash-window fixture: a persisted prepared intent must be reused, even after a price update.
	op := uuid.NewString()
	if _, err = f.db.Exec(ctx, `INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state) VALUES($1,$2,$3,'submit',$4,'prepared')`, op, j.ID, *j.TranscriptionID, j.Generation); err != nil {
		t.Fatal(err)
	}
	row := sttItems(t, f, "")[0].(map[string]any)
	if row["price_version_id"] != firstPrice || row["estimated_cost_microusd"] != "667" || row["rate_microusd_per_hour"] != "120000" {
		t.Fatal(row)
	}
	p.Hourly = "200000"
	savePrice(t, f, p)
	f.a.execute(ctx, j)
	rows := sttItems(t, f, "")
	if len(rows) != 1 || rows[0].(map[string]any)["result_state"] != "succeeded" || remote.submits.Load() != 1 {
		t.Fatal(rows, remote.submits.Load())
	}
	before := sttTotals(t, f, "")
	if before["completed_estimated_cost_microusd"] != "667" || before["completed_duration_ms"] != "20000" {
		t.Fatal(before)
	}
	// A distinct explicit transcription version makes a new intent at the new price.
	f.json(t, "POST", "/api/v1/recordings/"+rid+"/transcriptions", options(), 202, uuid.NewString())
	f.run(t, "transcribe")
	rows = sttItems(t, f, "")
	if len(rows) != 2 || remote.submits.Load() != 2 || rows[0].(map[string]any)["estimated_cost_microusd"] != "1223" {
		t.Fatal(rows)
	}
	before = sttTotals(t, f, "")
	f.json(t, "DELETE", "/api/v1/recordings/"+rid, nil, 202, "")
	if got := sttTotals(t, f, ""); got["completed_estimated_cost_microusd"] != before["completed_estimated_cost_microusd"] {
		t.Fatal("soft delete rewrote result", got)
	}
	for i := 0; i < 8; i++ {
		if err := f.a.maintenance(ctx); err != nil {
			t.Fatal(err)
		}
	}
	rows = sttItems(t, f, "")
	for _, raw := range rows {
		v := raw.(map[string]any)
		if v["operation_id"] != nil || v["job_id"] != nil || v["transcription_id"] != nil || v["owner_id"] != userID(t, f) || v["result_state"] != "succeeded" {
			t.Fatal(v)
		}
	}
	if got := sttTotals(t, f, ""); got["completed_estimated_cost_microusd"] != before["completed_estimated_cost_microusd"] {
		t.Fatal("GC rewrote summary", got)
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingReadOnlyPricesAndPagination(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	other := anotherAccount(t, f, "stt_other")
	p := priceInput()
	key := uuid.NewString()
	for _, path := range []string{"calls", "summary", "prices"} {
		other.json(t, "GET", "/api/v1/admin/stt/"+path, nil, 403, "")
	}
	other.json(t, "POST", "/api/v1/admin/stt/prices", p, 403, key)
	_, denied := f.json(t, "POST", "/api/v1/admin/stt/prices", p, 403, key)
	if denied["error"].(map[string]any)["code"] != "manual_pricing_disabled" {
		t.Fatal(denied)
	}
	first := savePrice(t, f, p)
	p.Hourly = "100001"
	f.json(t, "POST", "/api/v1/admin/stt/prices", p, 403, key)
	savePrice(t, f, p)
	_, latest := f.json(t, "GET", "/api/v1/admin/stt/prices", nil, 200, "")
	if len(latest["items"].([]any)) != 1 {
		t.Fatal(latest)
	}
	_, history := f.json(t, "GET", "/api/v1/admin/stt/prices?history=true&limit=1", nil, 200, "")
	if history["next_cursor"] == nil {
		t.Fatal(history)
	}
	_, second := f.json(t, "GET", "/api/v1/admin/stt/prices?history=true&limit=1&cursor="+url.QueryEscape(history["next_cursor"].(string)), nil, 200, "")
	if second["items"].([]any)[0].(map[string]any)["id"] != first {
		t.Fatal(second)
	}
	if _, err := f.db.Exec(ctx, `UPDATE stt_price_versions SET source='overwritten'`); err == nil {
		t.Fatal("mutable price")
	}
	f.a.Config.RestoreMode = true
	f.json(t, "POST", "/api/v1/admin/stt/prices", p, 409, uuid.NewString())
	f.a.Config.RestoreMode = false
	if _, err := f.db.Exec(ctx, `UPDATE users SET role='admin' WHERE id=$1`, userID(t, other)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, `UPDATE users SET role='user' WHERE id=$1`, userID(t, f)); err != nil {
		t.Fatal(err)
	}
	f.json(t, "GET", "/api/v1/admin/stt/calls", nil, 403, "")
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingRestoreAndUnknown(t *testing.T) {
	remote := fakeRemote(t)
	f := setup(t)
	ctx := context.Background()
	savePrice(t, f, priceInput())
	f.upload(t, wav(20), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	var jid string
	if err := f.db.QueryRow(ctx, `SELECT id FROM jobs WHERE kind='transcribe'`).Scan(&jid); err != nil {
		t.Fatal(err)
	}
	f.a.Config.RestoreMode = true
	for i := 0; i < 2; i++ {
		if err := f.a.Restore(ctx); err != nil {
			t.Fatal(err)
		}
	}
	f.a.Config.RestoreMode = false
	rows := sttItems(t, f, "")
	if len(rows) != 1 || rows[0].(map[string]any)["origin"] != "restore_observation" || rows[0].(map[string]any)["estimated_cost_microusd"] != nil {
		t.Fatal(rows)
	}
	totals := sttTotals(t, f, "")
	if totals["submitted_count"] != "0" || totals["restored_count"] != "1" || totals["uncertain_count"] != "1" || totals["unpriced_count"] != "1" {
		t.Fatal(totals)
	}
	ops, err := f.db.Query(ctx, `SELECT id,kind FROM provider_operations WHERE job_id=$1 ORDER BY kind`, jid)
	if err != nil {
		t.Fatal(err)
	}
	type operation struct{ id, kind string }
	var operations []operation
	for ops.Next() {
		var o operation
		if err := ops.Scan(&o.id, &o.kind); err != nil {
			t.Fatal(err)
		}
		operations = append(operations, o)
	}
	ops.Close()
	for _, o := range operations {
		if err := f.a.ReconcileJob(ctx, jid, o.id, "restored-"+o.kind, "已核实"); err != nil {
			t.Fatal(err)
		}
	}
	f.run(t, "transcribe")
	if remote.submits.Load() != 0 || remote.uploads.Load() != 0 {
		t.Fatal("restore repeated remote submit")
	}
	totals = sttTotals(t, f, "")
	if totals["completed_duration_ms"] != "20000" || totals["unpriced_count"] != "1" || totals["uncertain_count"] != "0" {
		t.Fatal(totals)
	}
	// A real unknown submit is retained and excluded from completed/ongoing estimates.
	remote.uncertain.Store(true)
	f.upload(t, wav(21), map[string]any{"auto_transcribe": true, "transcription_options": options()}, uuid.NewString(), 201)
	f.run(t, "prepare")
	unknownJob, err := f.a.claim(ctx, "transcribe")
	if err != nil {
		t.Fatal(err)
	}
	f.a.execute(ctx, unknownJob)
	totals = sttTotals(t, f, "")
	if totals["uncertain_count"] != "1" || totals["pending_estimated_cost_microusd"] != "0" {
		t.Fatal(totals)
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingIntegerConstraintsAndFilters(t *testing.T) {
	f, rid, tid, _ := insightFixture(t)
	ctx := context.Background()
	p := priceInput()
	p.Hourly = "900000000003599999"
	p.Diarization = "0"
	savePrice(t, f, p)
	if _, err := f.db.Exec(ctx, `UPDATE transcriptions SET model='stt-async-v5' WHERE id=$1`, tid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, `UPDATE recordings SET duration_ms=35999999 WHERE id=$1`, rid); err != nil {
		t.Fatal(err)
	}
	// Controlled pre-existing job state, then enter the real operation persistence boundary.
	jid := uuid.NewString()
	if _, err := f.db.Exec(ctx, `INSERT INTO jobs(id,kind,recording_id,transcription_id,dedupe_key,stage,state) VALUES($1,'transcribe',$2,$3,$4,'submitting','running')`, jid, rid, tid, "stt-test:"+jid); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := f.db.Exec(ctx, `INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state) VALUES($1,$2,$3,'submit',0,'prepared')`, uuid.NewString(), jid, tid); err != nil {
			t.Fatal(err)
		}
	}
	rows := sttItems(t, f, "")
	for _, raw := range rows {
		if raw.(map[string]any)["estimated_cost_microusd"] != "8999999750035999990" {
			t.Fatal(raw)
		}
	}
	if _, err := f.db.Exec(ctx, `UPDATE provider_operations SET state='known',remote_id='verified' WHERE job_id=$1`, jid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, `UPDATE jobs SET state='succeeded' WHERE id=$1`, jid); err != nil {
		t.Fatal(err)
	}
	totals := sttTotals(t, f, "")
	expected := new(big.Int)
	expected.SetString("8999999750035999990", 10)
	expected.Mul(expected, big.NewInt(2))
	if totals["completed_estimated_cost_microusd"] != expected.String() {
		t.Fatal(totals)
	}
	_, page := f.json(t, "GET", "/api/v1/admin/stt/calls?limit=1", nil, 200, "")
	cursor := page["next_cursor"].(string)
	_, page2 := f.json(t, "GET", "/api/v1/admin/stt/calls?limit=1&cursor="+url.QueryEscape(cursor), nil, 200, "")
	if page["items"].([]any)[0].(map[string]any)["id"] == page2["items"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("duplicate page")
	}
	if got := sttTotals(t, f, "?limit=1&cursor="+url.QueryEscape(cursor)); got["completed_estimated_cost_microusd"] != expected.String() {
		t.Fatal("pagination affected summary", got)
	}
	if len(sttItems(t, f, "?provider=assemblyai")) != 0 || sttTotals(t, f, "?provider=assemblyai")["submitted_count"] != "0" {
		t.Fatal("filter mismatch")
	}
	raw, _ := json.Marshal(rows)
	for _, secret := range []string{"source_text", "recording_title", "original_name", "options_json", "remote_id", "resolution_note"} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("leak", secret)
		}
	}
	if _, err := f.db.Exec(ctx, `UPDATE stt_calls SET duration_ms=1`); err == nil {
		t.Fatal("mutable snapshot")
	}
	// DB owner constraints reject attribution to another account.
	other := anotherAccount(t, f, "stt_fk")
	if _, err := f.db.Exec(ctx, `UPDATE stt_calls SET owner_id=$1`, userID(t, other)); err == nil {
		t.Fatal("mutable owner")
	}
	// Explicit rejection is sticky even if the same job later succeeds.
	if _, err := f.db.Exec(ctx, `UPDATE provider_operations SET state='confirmed_absent' WHERE id=(SELECT id FROM provider_operations WHERE job_id=$1 LIMIT 1)`, jid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, `UPDATE jobs SET state='succeeded' WHERE id=$1`, jid); err != nil {
		t.Fatal(err)
	}
	if sttTotals(t, f, "")["completed_estimated_cost_microusd"] != "8999999750035999990" {
		t.Fatal("absent counted completed")
	}
	// Over-limit individual estimate aborts operation creation atomically.
	if _, err := f.db.Exec(ctx, `UPDATE recordings SET duration_ms=9223372036854775807 WHERE id=$1`, rid); err != nil {
		t.Fatal(err)
	}
	err := persistence.Transaction(ctx, f.db, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state) VALUES($1,$2,$3,'submit',0,'prepared')`, uuid.NewString(), jid, tid)
		return err
	})
	if err == nil {
		t.Fatal("overflow accepted")
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingConcurrentVersionVisibilityAndMissingPrice(t *testing.T) {
	f, rid, tid, _ := insightFixture(t)
	ctx := context.Background()
	if _, err := f.db.Exec(ctx, `UPDATE transcriptions SET model='stt-async-v5' WHERE id=$1`, tid); err != nil {
		t.Fatal(err)
	}
	jid := uuid.NewString()
	if _, err := f.db.Exec(ctx, `INSERT INTO jobs(id,kind,recording_id,transcription_id,dedupe_key,stage,state) VALUES($1,'transcribe',$2,$3,$4,'submitting','running')`, jid, rid, tid, "visibility:"+jid); err != nil {
		t.Fatal(err)
	}
	tx, err := f.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	// Price INSERT is deliberately uncommitted while another connection creates an intent.
	if _, err := tx.Exec(ctx, `INSERT INTO stt_price_versions(id,provider,model,currency,basis,hourly_rate_microusd,diarization_hourly_rate_microusd,source,verified_on,created_by) VALUES($1,'soniox','stt-async-v5','USD','duration_estimate',1,0,'contract','2026-11-09',$2)`, uuid.NewString(), userID(t, f)); err != nil {
		t.Fatal(err)
	}
	first := uuid.NewString()
	insert := `INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state,created_at) VALUES($1,$2,$3,'submit',0,'prepared','2026-11-09T00:00:00Z')`
	if _, err := f.db.Exec(ctx, insert, first, jid, tid); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(ctx, insert, uuid.NewString(), jid, tid); err != nil {
		t.Fatal(err)
	}
	rows := sttItems(t, f, "")
	var priced, unpriced int
	for _, raw := range rows {
		v := raw.(map[string]any)
		if v["operation_id"] == first {
			if v["estimated_cost_microusd"] != nil {
				t.Fatal("uncommitted/future price applied", v)
			}
			unpriced++
		} else {
			if v["estimated_cost_microusd"] != "1" {
				t.Fatal("tiny amount lost", v)
			}
			priced++
		}
	}
	if priced != 1 || unpriced != 1 {
		t.Fatal(rows)
	}
	if _, err := f.db.Exec(ctx, insert, first, jid, tid); err == nil {
		t.Fatal("duplicate operation allowed")
	}
	// Same timestamp keyset pagination must still visit both IDs exactly once.
	_, page := f.json(t, "GET", "/api/v1/admin/stt/calls?limit=1", nil, 200, "")
	_, page2 := f.json(t, "GET", "/api/v1/admin/stt/calls?limit=1&cursor="+url.QueryEscape(page["next_cursor"].(string)), nil, 200, "")
	if page["items"].([]any)[0].(map[string]any)["id"] == page2["items"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("same-time duplicate")
	}
	// Attribution must match every surviving business reference.
	other := anotherAccount(t, f, "stt_other_owner")
	_, err = f.db.Exec(ctx, `INSERT INTO stt_calls(id,owner_id,job_id,transcription_id,provider,model,duration_ms,diarization,origin,submission_state,result_state) VALUES($1,$2,$3,$4,'soniox','stt-async-v5',1,false,'historical','known','pending')`, uuid.NewString(), userID(t, other), jid, tid)
	if err == nil {
		t.Fatal("cross-owner reference accepted")
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingHistoricalMigration(t *testing.T) {
	f, rid, tid, _ := insightFixture(t)
	ctx := context.Background()
	jid := uuid.NewString()
	if _, err := f.db.Exec(ctx, `INSERT INTO jobs(id,kind,recording_id,transcription_id,dedupe_key,stage,state) VALUES($1,'transcribe',$2,$3,$4,'submitting','running')`, jid, rid, tid, "historical:"+jid); err != nil {
		t.Fatal(err)
	}
	// Restore the pre-023 schema in this isolated fixture, retaining an in-flight submit.
	for _, sql := range []string{`DROP TRIGGER stt_operation_snapshot ON provider_operations`, `DROP TRIGGER stt_job_result ON jobs`, `DROP TABLE stt_calls`, `DROP TABLE stt_price_versions`, `DROP FUNCTION stt_operation_snapshot()`, `DROP FUNCTION stt_job_result()`, `DROP FUNCTION stt_price_immutable()`, `DROP FUNCTION stt_snapshot_immutable()`, `DROP FUNCTION stt_result(text,text,boolean)`, `DELETE FROM schema_migrations WHERE name='023_stt_pricing.sql'`} {
		if _, err := f.db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	op := uuid.NewString()
	if _, err := f.db.Exec(ctx, `INSERT INTO provider_operations(id,job_id,transcription_id,kind,lease_generation,state) VALUES($1,$2,$3,'submit',0,'prepared')`, op, jid, tid); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Migrate(ctx, f.db); err != nil {
		t.Fatal(err)
	}
	rows := sttItems(t, f, "")
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	row := rows[0].(map[string]any)
	if row["origin"] != "historical" || row["price_version_id"] != nil || row["submission_state"] != "prepared" || row["operation_id"] != op {
		t.Fatal(row)
	}
	if _, err := f.db.Exec(ctx, `UPDATE provider_operations SET state='sent' WHERE id=$1`, op); err != nil {
		t.Fatal(err)
	}
	if got := sttTotals(t, f, ""); got["unpriced_count"] != "1" || got["uncertain_count"] != "1" {
		t.Fatal(got)
	}
}

// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
func TestSTTPricingRejectsConcurrentWritesAndLegacyReplay(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	input := priceInput()
	body := jsonBytes(input)
	key := uuid.NewString()
	type result struct {
		status int
		id     string
		err    error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			req, err := http.NewRequest("POST", f.server.URL+"/api/v1/admin/stt/prices", bytes.NewReader(body))
			if err != nil {
				results <- result{err: err}
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", f.csrf)
			req.Header.Set("Idempotency-Key", key)
			response, err := f.client.Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer response.Body.Close()
			var v struct {
				ID string `json:"id"`
			}
			err = json.NewDecoder(response.Body).Decode(&v)
			results <- result{response.StatusCode, v.ID, err}
		}()
	}
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.status != 403 || second.status != 403 || first.id != "" || second.id != "" {
		t.Fatal(first, second)
	}
	var versions, audits int
	if err := f.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM stt_price_versions),(SELECT count(*) FROM admin_audit_events WHERE action='stt_price_created')`).Scan(&versions, &audits); err != nil || versions != 0 || audits != 0 {
		t.Fatal(versions, audits, err)
	}
	oldPrice := savePrice(t, f, input)
	if _, err := f.db.Exec(ctx, `INSERT INTO idempotency_keys(scope,key,request_hash,resource_id,owner_id) VALUES('stt-price',$1,$2,$3,$4)`, key, digest(body), oldPrice, userID(t, f)); err != nil {
		t.Fatal(err)
	}
	for _, body := range []any{input, map[string]any{"hourly_rate_microusd": "invalid"}, nil} {
		f.json(t, "POST", "/api/v1/admin/stt/prices", body, 403, key)
		f.json(t, "POST", "/api/v1/admin/stt/prices", body, 403, "")
	}
	var keys int
	if err := f.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM stt_price_versions),(SELECT count(*) FROM admin_audit_events WHERE action='stt_price_created'),(SELECT count(*) FROM idempotency_keys WHERE scope='stt-price')`).Scan(&versions, &audits, &keys); err != nil || versions != 1 || audits != 0 || keys != 1 {
		t.Fatal(versions, audits, keys, err)
	}
	req, err := http.NewRequest("POST", f.server.URL+"/api/v1/admin/stt/prices", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", uuid.NewString())
	response, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("missing CSRF", response.StatusCode)
	}
	response, err = http.Get(f.server.URL + "/api/v1/admin/stt/prices")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("anonymous", response.StatusCode)
	}
}
