package app

import (
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"slices"
	"sort"
	"voices/internal/persistence"
	"voices/internal/providers"
)

type Settings struct {
	DefaultTranscription *providers.Options `json:"default_transcription"`
	AutoTranscribe       bool               `json:"auto_transcribe"`
}

func (a *App) readSettings(r *http.Request) (Settings, error) {
	s := Settings{}
	var raw []byte
	err := a.DB.QueryRow(r.Context(), "SELECT value_json FROM settings WHERE key='defaults' AND owner_id=$1", persistence.UserID(r.Context())).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return s, nil
		}
		return s, err
	}
	err = json.Unmarshal(raw, &s)
	return s, err
}
func (a *App) getSettings(w http.ResponseWriter, r *http.Request) error {
	s, err := a.readSettings(r)
	if err != nil {
		return err
	}
	writeJSON(w, 200, s)
	return nil
}
func (a *App) patchSettings(w http.ResponseWriter, r *http.Request) error {
	var s Settings
	if err := decode(r, &s); err != nil {
		return err
	}
	if s.DefaultTranscription != nil {
		if _, err := a.validateOptions(*s.DefaultTranscription, 0, 0); err != nil {
			return err
		}
	} else if s.AutoTranscribe {
		return bad("options_required", "自动转写需要默认模型与语言")
	}
	if _, err := a.DB.Exec(r.Context(), "INSERT INTO settings(key,value_json,owner_id) VALUES('defaults',$1,$2) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json", jsonBytes(s), persistence.UserID(r.Context())); err != nil {
		return err
	}
	writeJSON(w, 200, s)
	return nil
}
func (a *App) listProviders(w http.ResponseWriter, r *http.Request) error {
	items := []any{}
	ids := []string{}
	for id := range a.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := a.Providers[id]
		name := id
		if id == "soniox" {
			name = "Soniox"
		}
		if id == "assemblyai" {
			name = "AssemblyAI"
		}
		configured := (id == "soniox" && a.Config.SonioxKey != "") || (id == "assemblyai" && a.Config.AssemblyAIKey != "")
		items = append(items, map[string]any{"id": id, "name": name, "configured": configured, "models": p.Models()})
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_cursor": nil})
	return nil
}
func (a *App) validateOptions(o providers.Options, duration, size int64) (providers.Model, error) {
	p, ok := a.Providers[o.Provider]
	if !ok {
		return providers.Model{}, bad("unsupported_provider", "服务商不支持")
	}
	if (o.Provider == "soniox" && a.Config.SonioxKey == "") || (o.Provider == "assemblyai" && a.Config.AssemblyAIKey == "") {
		return providers.Model{}, bad("provider_not_configured", "请先由管理员在服务器设置中配置服务商凭据并重启应用")
	}
	for _, m := range p.Models() {
		if m.ID != o.Model {
			continue
		}
		if !slices.Contains(m.LanguageModes, o.LanguageMode) {
			return m, bad("unsupported_language_mode", "该模型不支持所选语言模式")
		}
		if o.LanguageMode == "single" && len(o.Languages) != 1 || o.LanguageMode == "multi" && len(o.Languages) < 2 || o.LanguageMode == "auto" && len(o.Languages) != 0 {
			return m, bad("invalid_languages", "所选语言数量与语言模式不符")
		}
		seen := map[string]bool{}
		for _, lang := range o.Languages {
			if seen[lang] || !slices.Contains(m.Languages, lang) {
				return m, bad("unsupported_language", "该模型不支持所选语言")
			}
			seen[lang] = true
		}
		if o.Provider == "assemblyai" && o.Model == "universal-2" && o.LanguageMode == "multi" && (len(o.Languages) != 2 || !seen["en"]) {
			return m, bad("unsupported_languages", "Universal-2 多语言须为英语 en 加一种其他语言；可改用 Universal-3.5 Pro")
		}
		if o.Diarization && !m.Diarization {
			return m, bad("unsupported_diarization", "该模型不支持自动区分说话人")
		}
		if m.MaxDurationMS > 0 && duration > m.MaxDurationMS {
			return m, &apiError{422, "duration_exceeded", "录音超出该模型时长限制，请选择其他模型"}
		}
		if m.MaxFileBytes > 0 && size > m.MaxFileBytes {
			return m, &apiError{422, "file_size_exceeded", "录音超出该模型文件限制"}
		}
		return m, nil
	}
	return providers.Model{}, bad("unsupported_model", "模型不支持")
}
