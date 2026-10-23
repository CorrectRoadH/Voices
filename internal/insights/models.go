package insights

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
	"voices/internal/outbound"
)

type Model struct {
	ID string `json:"id"`
}

// ListModels only retrieves IDs. Presence does not attest chat or JSON support.
// It deliberately ignores SDK environment configuration and never follows redirects.
func ListModels(ctx context.Context, baseURL, key string) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/models", nil)
	if err != nil {
		return nil, Error("model_list_unavailable")
	}
	req.Header.Set("Accept", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	outbound.MarkStarted(ctx)
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, Error("model_list_timeout")
		}
		return nil, Error("model_list_unavailable")
	}
	outbound.MarkStatus(ctx, resp.StatusCode)
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, Error("model_list_unauthorized")
	case resp.StatusCode == 404 || resp.StatusCode == 405:
		return nil, Error("model_list_unsupported")
	case resp.StatusCode != http.StatusOK:
		return nil, Error("model_list_unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, Error("model_list_timeout")
		}
		return nil, Error("model_list_unavailable")
	}
	if len(raw) > 1<<20 {
		return nil, Error("model_list_too_large")
	}
	var body struct {
		Data []Model `json:"data"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Data == nil || !utf8.Valid(raw) {
		return nil, Error("model_list_invalid")
	}
	if len(body.Data) > 1000 {
		return nil, Error("model_list_too_large")
	}
	models := make([]Model, 0, len(body.Data))
	seen := map[string]bool{}
	for _, model := range body.Data {
		if model.ID == "" || strings.TrimSpace(model.ID) != model.ID || utf8.RuneCountInString(model.ID) > 200 || strings.IndexFunc(model.ID, unicode.IsControl) >= 0 {
			return nil, Error("model_list_invalid")
		}
		if !seen[model.ID] {
			models = append(models, model)
			seen[model.ID] = true
		}
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}
