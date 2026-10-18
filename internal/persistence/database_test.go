package persistence

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// @use-case docs/feature/accounts/use-case/isolate-data.md
func TestAccountMigrationPreservesNonemptyLegacyDatabase(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL required")
	}
	for _, populated := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty", true: "business_data"}[populated], func(t *testing.T) {
			ctx := context.Background()
			admin, err := pgxpool.New(ctx, dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer admin.Close()
			schema := "migration_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
				t.Fatal(err)
			}
			defer admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
			config, err := pgxpool.ParseConfig(dsn)
			if err != nil {
				t.Fatal(err)
			}
			config.ConnConfig.RuntimeParams["search_path"] = schema
			db, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			initial, err := migrations.ReadFile("migrations/001_initial.sql")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(ctx, string(initial)); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(ctx, "CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations(name) VALUES('001_initial.sql')"); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(ctx, "INSERT INTO sessions(id_hash,csrf_hash,expires_at) VALUES('legacy','legacy',now()+interval '1 day')"); err != nil {
				t.Fatal(err)
			}
			if populated {
				if _, err := db.Exec(ctx, "INSERT INTO people(id,display_name) VALUES($1,'Preserved')", uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			}
			err = Migrate(ctx, db)
			if populated {
				if err == nil || !strings.Contains(err.Error(), "explicit ownership migration") {
					t.Fatalf("expected migration refusal, got %v", err)
				}
				var count int
				db.QueryRow(ctx, "SELECT count(*) FROM people").Scan(&count)
				if count != 1 {
					t.Fatal("legacy data changed")
				}
				var exists bool
				db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='users')", schema).Scan(&exists)
				if exists {
					t.Fatal("partial migration committed")
				}
				db.QueryRow(ctx, "SELECT count(*) FROM sessions").Scan(&count)
				if count != 1 {
					t.Fatal("legacy session changed on failure")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if err := Migrate(ctx, db); err != nil {
					t.Fatal("migration not idempotent", err)
				}
				var count int
				db.QueryRow(ctx, "SELECT count(*) FROM sessions").Scan(&count)
				if count != 0 {
					t.Fatal("legacy shared sessions retained")
				}
			}
		})
	}
}
