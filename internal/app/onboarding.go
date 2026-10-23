package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
	"voices/internal/outbound"

	"github.com/jackc/pgx/v5"
	"voices/internal/insights"
	"voices/internal/persistence"
)

// llmConfig is a secret snapshot, never an API response or audit payload.
type llmConfig struct {
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Model   string `json:"model"`
}

func (c llmConfig) configured() bool    { return c.BaseURL != "" && c.Model != "" }
func (s ServerSettings) llm() llmConfig { return llmConfig{s.LLMBaseURL, s.LLMKey, s.LLMModel} }
func readLLMConfig(ctx context.Context, q querier) (llmConfig, error) {
	var raw []byte
	if err := q.QueryRow(ctx, "SELECT value_json FROM server_settings WHERE id=1").Scan(&raw); err != nil {
		return llmConfig{}, err
	}
	var s ServerSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		return llmConfig{}, err
	}
	return s.llm(), nil
}

func (a *App) adminOnboarding(w http.ResponseWriter, r *http.Request) error {
	if r.Method == http.MethodPost {
		var in struct {
			Revision int64 `json:"revision"`
			SkipLLM  bool  `json:"skip_llm"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
			if err := lockAdmin(r.Context(), tx); err != nil {
				return err
			}
			var revision int64
			var tested bool
			var raw []byte
			if err := tx.QueryRow(r.Context(), "SELECT revision,COALESCE(llm_test_revision=revision,false),value_json FROM server_settings WHERE id=1 FOR UPDATE").Scan(&revision, &tested, &raw); err != nil {
				return err
			}
			if revision != in.Revision {
				return conflict()
			}
			var completed bool
			if err := tx.QueryRow(r.Context(), "SELECT site_setup_completed FROM instance_settings WHERE id=1 FOR UPDATE").Scan(&completed); err != nil {
				return err
			}
			if completed {
				return nil
			}
			var s ServerSettings
			if err := json.Unmarshal(raw, &s); err != nil {
				return err
			}
			if in.SkipLLM {
				if s.LLMBaseURL != "" || s.LLMModel != "" || s.LLMKey != "" {
					return bad("llm_not_empty", "暂不启用前请清空 LLM 地址、模型和密钥")
				}
			} else if !tested || !s.llm().configured() {
				return &apiError{409, "llm_test_required", "请先测试当前保存的 LLM 配置"}
			}
			if _, err := tx.Exec(r.Context(), "UPDATE instance_settings SET site_setup_completed=true WHERE id=1"); err != nil {
				return err
			}
			return audit(r.Context(), tx, persistence.UserID(r.Context()), nil, "site_setup_completed", map[string]any{"skip_llm": in.SkipLLM})
		})
		if err != nil {
			return err
		}
	}
	var completed, tested bool
	var revision int64
	if err := a.DB.QueryRow(r.Context(), "SELECT i.site_setup_completed,s.revision,COALESCE(s.llm_test_revision=s.revision,false) FROM instance_settings i CROSS JOIN server_settings s WHERE i.id=1 AND s.id=1").Scan(&completed, &revision, &tested); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"completed": completed, "revision": revision, "llm_tested": tested})
	return nil
}

func (a *App) adminLLMTest(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Revision int64 `json:"revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Revision < 1 {
		return bad("invalid_revision", "请提供当前配置修订号")
	}
	if err := a.rateLimit(r, "llm_test", currentUser(r.Context()).ID, 3); err != nil {
		return err
	}
	var config llmConfig
	err := persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := lockAdmin(r.Context(), tx); err != nil {
			return err
		}
		var raw []byte
		var revision int64
		if err := tx.QueryRow(r.Context(), "SELECT revision,value_json FROM server_settings WHERE id=1 FOR UPDATE").Scan(&revision, &raw); err != nil {
			return err
		}
		if revision != in.Revision {
			return conflict()
		}
		var s ServerSettings
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		config = s.llm()
		if !config.configured() {
			return bad("llm_not_configured", "请填写 LLM 地址和模型")
		}
		_, err := tx.Exec(r.Context(), "UPDATE server_settings SET llm_test_revision=NULL WHERE id=1")
		return err
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	callID, logErr := startCall(r.Context(), a.DB, callStart{Owner: currentUser(r.Context()).ID, Category: "ai", Operation: "test_model", Provider: "openai_compatible", Model: config.Model}, 20*time.Second)
	if logErr != nil {
		return logErr
	}
	callCtx, observation := outbound.WithObservation(ctx)
	started := time.Now()
	_, err = insights.Generate(callCtx, config.BaseURL, config.APIKey, config.Model, []insights.Segment{{ID: "sample", Text: "今天讨论了项目安排。我们决定先完成测试，再发布新版本。"}})
	a.finishCall(r.Context(), callID, started, observation, err)
	if err != nil {
		var safe insights.Error
		code := "llm_unavailable"
		if errors.As(err, &safe) {
			code = string(safe)
		}
		return &apiError{502, code, "LLM 测试失败，请检查地址、密钥、模型及 JSON 输出支持"}
	}
	err = persistence.Transaction(r.Context(), a.DB, func(tx pgx.Tx) error {
		if err := lockAdmin(r.Context(), tx); err != nil {
			return err
		}
		tag, err := tx.Exec(r.Context(), "UPDATE server_settings SET llm_test_revision=revision WHERE id=1 AND revision=$1", in.Revision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return conflict()
		}
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": in.Revision, "tested": true})
	return nil
}
