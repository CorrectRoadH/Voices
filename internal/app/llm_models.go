package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
	"voices/internal/outbound"

	"voices/internal/insights"
)

func (a *App) adminLLMModels(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		BaseURL  string          `json:"base_url"`
		APIKey   json.RawMessage `json:"api_key"`
		Revision int64           `json:"revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.BaseURL = strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	if !validConfigURL(in.BaseURL, false) {
		return bad("invalid_llm_base_url", "请填写规范的 LLM HTTP/HTTPS API 基础地址")
	}
	if in.Revision < 1 {
		return bad("invalid_revision", "请提供当前配置修订号")
	}
	var key string
	if len(in.APIKey) > 0 && (bytes.Equal(bytes.TrimSpace(in.APIKey), []byte("null")) || json.Unmarshal(in.APIKey, &key) != nil) {
		return bad("invalid_api_key", "API Key 必须是字符串，可显式留空")
	}
	if len(key) > 8192 || !utf8.ValidString(key) || strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return bad("invalid_api_key", "API Key 最多 8192 字节，不能包含控制字符")
	}
	var revision int64
	var raw []byte
	if err := a.DB.QueryRow(r.Context(), "SELECT revision,value_json FROM server_settings WHERE id=1").Scan(&revision, &raw); err != nil {
		return err
	}
	if revision != in.Revision {
		return conflict()
	}
	var saved ServerSettings
	if err := json.Unmarshal(raw, &saved); err != nil {
		return err
	}
	if len(in.APIKey) == 0 {
		if saved.LLMKey != "" && in.BaseURL != strings.TrimRight(strings.TrimSpace(saved.LLMBaseURL), "/") {
			return bad("saved_key_target_changed", "LLM 地址已更改，请输入新密钥或明确清除密钥后获取模型；不会向新地址发送已保存的密钥")
		}
		key = saved.LLMKey
	}
	callID, logErr := startCall(r.Context(), a.DB, callStart{Owner: currentUser(r.Context()).ID, Category: "ai", Operation: "list_models", Provider: "openai_compatible", Model: ""}, 15*time.Second)
	if logErr != nil {
		return logErr
	}
	callCtx, observation := outbound.WithObservation(r.Context())
	started := time.Now()
	models, err := insights.ListModels(callCtx, in.BaseURL, key)
	a.finishCall(r.Context(), callID, started, observation, err)
	if err != nil {
		messages := map[insights.Error]string{
			"model_list_timeout":      "获取模型超时，请稍后重试或手动填写模型 ID",
			"model_list_unauthorized": "模型服务拒绝访问，请检查 API Key 和权限",
			"model_list_unsupported":  "该服务不支持获取模型列表，请手动填写模型 ID",
			"model_list_invalid":      "模型服务返回的列表格式不兼容，请手动填写模型 ID",
			"model_list_too_large":    "模型列表超过支持范围，请手动填写模型 ID",
			"model_list_unavailable":  "无法获取模型列表，请检查服务地址或稍后重试",
		}
		if code, ok := err.(insights.Error); ok {
			if message, found := messages[code]; found {
				return &apiError{502, string(code), message}
			}
		}
		return &apiError{502, "model_list_unavailable", messages["model_list_unavailable"]}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": models})
	return nil
}
