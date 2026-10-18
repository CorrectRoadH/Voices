package app

import (
	"bytes"
	"encoding/base64"
	"github.com/google/uuid"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// @use-case docs/feature/people/use-case/link-person.md
func TestPersonAvatarLifecycleAndIsolation(t *testing.T) {
	f := setup(t)
	other := anotherAccount(t, f, "avatar-other")
	img := image.NewRGBA(image.Rect(0, 0, 20, 20))
	img.Set(5, 5, color.RGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	_, p := f.json(t, "POST", "/api/v1/people", map[string]any{"display_name": "Avatar", "avatar_data": data}, 201, uuid.NewString())
	path := "/api/v1/people/" + p["id"].(string)
	if p["has_avatar"] != true {
		t.Fatal("missing avatar flag")
	}
	response, raw := f.request(t, "GET", path+"/avatar", nil, "", 200, "")
	if response.Header.Get("Content-Type") != "image/png" {
		t.Fatal("incorrect image type")
	}
	if _, err := png.Decode(bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	other.request(t, "GET", path+"/avatar", nil, "", 404, "")
	f.json(t, "PATCH", path, map[string]any{"revision": 1, "avatar_data": "data:image/svg+xml;base64,PHN2Zz4="}, 400, "")
	f.json(t, "PATCH", path, map[string]any{"revision": 2, "avatar_data": nil}, 409, "")
	f.request(t, "GET", path+"/avatar", nil, "", 200, "")
	_, cleared := f.json(t, "PATCH", path, map[string]any{"revision": 1, "avatar_data": nil}, 200, "")
	if cleared["has_avatar"] != false || cleared["avatar_revision"] != float64(2) {
		t.Fatal("avatar clear failed", cleared)
	}
	f.request(t, "GET", path+"/avatar", nil, "", 404, "")
}
