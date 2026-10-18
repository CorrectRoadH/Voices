package app

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"net/http"
	"strings"
)

func normalizeAvatar(value *string) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	encoded, ok := strings.CutPrefix(*value, "data:image/png;base64,")
	if !ok || len(encoded) > 700000 {
		return nil, bad("invalid_avatar", "请选择有效的头像图片")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) > 524288 {
		return nil, bad("invalid_avatar", "头像图片过大或格式不正确")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 256 || cfg.Height > 256 {
		return nil, bad("invalid_avatar", "头像尺寸不能超过 256×256")
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, bad("invalid_avatar", "头像图片无法读取")
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, img); err != nil {
		return nil, err
	}
	if normalized.Len() > 524288 {
		return nil, bad("invalid_avatar", "头像图片过大")
	}
	return normalized.Bytes(), nil
}
func (a *App) personAvatar(w http.ResponseWriter, r *http.Request) error {
	var data []byte
	if err := a.DB.QueryRow(r.Context(), "SELECT avatar_png FROM people WHERE id=$1", r.PathValue("id")).Scan(&data); err != nil {
		return err
	}
	if len(data) == 0 {
		return notFound()
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, err := w.Write(data)
	return err
}
