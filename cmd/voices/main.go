package main

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"
	"voices/internal/app"
	"voices/internal/persistence"
)

func main() {
	if len(os.Args) > 1 && ((os.Args[1] == "reset-password" && len(os.Args) != 3) || (os.Args[1] == "resolve-job" && len(os.Args) != 5)) {
		slog.Error("usage: voices reset-password <email> OR voices resolve-job <job-id> <operation-id> <remote-id>; input is read from stdin")
		os.Exit(2)
	}

	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 3 * time.Second}
		config, err := app.LoadConfig()
		if err != nil {
			os.Exit(1)
		}
		_, port, err := net.SplitHostPort(config.ListenAddr)
		if err != nil {
			os.Exit(1)
		}
		resp, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz")
		if err != nil {
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}

	if len(os.Args) == 2 && os.Args[1] == "hash-password" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() || strings.TrimSpace(scanner.Text()) == "" {
			slog.Error("provide password on stdin")
			os.Exit(1)
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(scanner.Text()), bcrypt.DefaultCost)
		if err != nil {
			slog.Error("password hashing failed")
			os.Exit(1)
		}
		fmt.Println(string(hash))
		return
	}
	cfg, err := app.LoadConfig()
	if err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := persistence.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database initialization failed; check connectivity and migrations")
		os.Exit(1)
	}
	defer db.Close()
	application, err := app.NewServer(ctx, cfg, db)
	if err != nil {
		slog.Error("server configuration initialization failed; check saved configuration or first-start environment")
		os.Exit(1)
	}
	if len(os.Args) == 3 && os.Args[1] == "reset-password" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			slog.Error("provide password on stdin")
			os.Exit(1)
		}
		if err := application.ResetPassword(ctx, os.Args[2], scanner.Text()); err != nil {
			slog.Error("password reset failed; check account and password requirements")
			os.Exit(1)
		}
		fmt.Println("Password updated; existing sessions revoked.")
		return
	}

	if len(os.Args) == 5 && os.Args[1] == "resolve-job" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() {
			slog.Error("provide reconciliation note on stdin")
			os.Exit(1)
		}
		if err := application.ReconcileJob(ctx, os.Args[2], os.Args[3], os.Args[4], scanner.Text()); err != nil {
			slog.Error("reconciliation failed; verify task, operation and resource ownership")
			os.Exit(1)
		}
		fmt.Println("Reconciliation recorded.")
		return
	}
	if err := application.Restore(ctx); err != nil {
		slog.Error("restore quarantine failed")
		os.Exit(1)
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); application.Run(ctx) }()
	server := &http.Server{Addr: cfg.ListenAddr, Handler: application.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()
	slog.Info("Voices listening", "address", cfg.ListenAddr, "restore_mode", cfg.RestoreMode)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP server failed", "error", err)
		stop()
	}
	stop()
	<-workerDone
}
