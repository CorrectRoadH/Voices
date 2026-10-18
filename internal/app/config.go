package app

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"voices/internal/updates"
)

type Config struct {
	UpdateURL string

	// AllowedOrigins lists explicit additional browser origins; request Host is never trusted.
	AllowedOrigins                                          []string
	DatabaseURL, ListenAddr, PublicBaseURL, WebDir, TempDir string
	SonioxKey, AssemblyAIKey                                string
	LLMBaseURL, LLMModel, LLMKey                            string
	seedEnv                                                 map[string]string
	RestoreMode                                             bool
	MaxUploadBytes                                          int64
	TranscriptionConcurrency, PrepareConcurrency            int
	HTTPTimeout                                             time.Duration
}

func LoadConfig() (Config, error) {
	values, err := godotenv.Read(".env")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, errors.New("cannot parse .env")
	}
	if values == nil {
		values = map[string]string{}
	}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	get := func(key, fallback string) string {
		if value := values[key]; value != "" {
			return value
		}
		return fallback
	}
	c := Config{seedEnv: values, ListenAddr: get("LISTEN_ADDR", "127.0.0.1:8080"), WebDir: get("WEB_DIR", "web/dist"), TempDir: values["TEMP_DIR"], RestoreMode: values["RESTORE_MODE"] == "true", MaxUploadBytes: 2 << 30, TranscriptionConcurrency: 2, PrepareConcurrency: 1, HTTPTimeout: 2 * time.Minute}
	c.DatabaseURL, err = configSecret(values, "DATABASE_URL")
	c.UpdateURL = values["UPDATE_URL"]
	if !updates.ValidEndpoint(c.UpdateURL) {
		return c, errors.New("UPDATE_URL must be an HTTPS URL without credentials, query or fragment")
	}
	if err != nil {
		return c, err
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	// Business configuration is imported only if the database has no saved row.
	for name, dest := range map[string]*int{"TRANSCRIPTION_CONCURRENCY": &c.TranscriptionConcurrency, "PREPARE_CONCURRENCY": &c.PrepareConcurrency} {
		if v := values[name]; v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 32 {
				return c, errors.New("invalid " + name)
			}
			*dest = n
		}
	}
	if v := values["MAX_UPLOAD_BYTES"]; v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil || n < 1 || n > 2<<30 {
			return c, errors.New("MAX_UPLOAD_BYTES must be between 1 and 2147483648")
		}
		c.MaxUploadBytes = n
	}
	return c, nil
}
func configSecret(values map[string]string, key string) (string, error) {
	value := values[key]
	if file := values[key+"_FILE"]; file != "" {
		if value != "" {
			return "", errors.New("configure either " + key + " or " + key + "_FILE")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return "", errors.New("cannot read " + key + "_FILE")
		}
		value = strings.TrimSpace(string(data))
	}
	return value, nil
}
