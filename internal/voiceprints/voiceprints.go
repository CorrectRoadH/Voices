// Package voiceprints owns bounded audio selection and model-specific matching.
// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
package voiceprints

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"time"
)

const Model = "campplus-zh-v1:sherpa-2.0.1:s16le-16000-mono:f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
const Dimensions = 192

var ErrAudio = errors.New("insufficient_audio")

func ValidURL(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}

type Client struct {
	URL  string
	HTTP *http.Client
}

func NewClient(raw string) *Client {
	transport := &http.Transport{DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxIdleConnsPerHost: 1}
	return &Client{URL: raw, HTTP: &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *Client) Extract(ctx context.Context, pcm []byte) ([]float64, error) {
	if !ValidURL(c.URL) || c.URL == "" {
		return nil, errors.New("unconfigured")
	}
	if len(pcm) < 96000 || len(pcm) > 320000 || len(pcm)%2 != 0 {
		return nil, ErrAudio
	}
	u, _ := url.Parse(c.URL)
	u.Path = "/embedding"
	req, err := http.NewRequestWithContext(ctx, "POST", u.String(), bytes.NewReader(pcm))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, errors.New("inference_unavailable")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(raw) > 16384 {
		return nil, errors.New("invalid_embedding")
	}
	if response.StatusCode == 422 {
		return nil, ErrAudio
	}
	if response.StatusCode != 200 {
		return nil, errors.New("inference_unavailable")
	}
	var result struct {
		Model     string    `json:"model"`
		Embedding []float64 `json:"embedding"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Model != Model {
		return nil, errors.New("model_mismatch")
	}
	return Normalize(result.Embedding)
}

func Normalize(v []float64) ([]float64, error) {
	if len(v) != Dimensions {
		return nil, errors.New("invalid_embedding")
	}
	norm := 0.0
	for _, x := range v {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil, errors.New("invalid_embedding")
		}
		norm += x * x
	}
	if math.IsInf(norm, 0) || norm < 1e-16 {
		return nil, errors.New("invalid_embedding")
	}
	out := make([]float64, len(v))
	norm = math.Sqrt(norm)
	for i, x := range v {
		out[i] = x / norm
	}
	return out, nil
}
func Similarity(a, b []float64) float64 {
	s := 0.0
	for i := range a {
		s += a[i] * b[i]
	}
	return math.Max(-1, math.Min(1, s))
}
func Average(vectors [][]float64, checkPurity bool) ([]float64, error) {
	if len(vectors) == 0 || checkPurity && len(vectors) < 2 {
		return nil, ErrAudio
	}
	sum := make([]float64, Dimensions)
	normalized := make([][]float64, 0, len(vectors))
	for _, v := range vectors {
		n, err := Normalize(v)
		if err != nil {
			return nil, err
		}
		if checkPurity {
			for _, other := range normalized {
				if Similarity(n, other) < 0.65 {
					return nil, ErrAudio
				}
			}
		}
		normalized = append(normalized, n)
		for i, x := range n {
			sum[i] += x
		}
	}
	return Normalize(sum)
}
func Match(vector []float64, people map[string][][]float64) (string, float64) {
	best, second := -1.0, -1.0
	id := ""
	for person, samples := range people {
		center, err := Average(samples, false)
		if err != nil {
			continue
		}
		score := Similarity(vector, center)
		if score > best {
			second = best
			best = score
			id = person
		} else if score > second {
			second = score
		}
	}
	if best < 0.80 || best-second < 0.12 {
		return "", best
	}
	return id, best
}

type Segment struct {
	Label      string
	Mode       string
	Start, End *int64
}
type Clip struct{ Start, End int64 }

func Clips(segments []Segment, label string, duration int64) []Clip {
	ranges := []Clip{}
	for _, s := range segments {
		if s.Label != label || s.Mode != "inherit" || s.Start == nil || s.End == nil || *s.Start < 0 || *s.End > duration || *s.End <= *s.Start {
			continue
		}
		ranges = append(ranges, Clip{*s.Start, *s.End})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].Start < ranges[j].Start })
	merged := []Clip{}
	for _, r := range ranges {
		if len(merged) > 0 && r.Start <= merged[len(merged)-1].End {
			merged[len(merged)-1].End = max(merged[len(merged)-1].End, r.End)
		} else {
			merged = append(merged, r)
		}
	}
	out := []Clip{}
	total := int64(0)
	for _, r := range merged {
		blocked := false
		for _, s := range segments {
			if s.Start != nil && s.End != nil && (s.Label != label || s.Mode != "inherit") && *s.Start < r.End && *s.End > r.Start {
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		for start := r.Start; start+3000 <= r.End && len(out) < 6 && total < 30000; {
			// Keep at least two non-overlapping chunks from a single long utterance.
			size := min(int64(10000), r.End-start, 30000-total)
			if len(out) == 0 && size >= 6000 {
				size = min(int64(10000), (r.End-start)/2)
			}
			if size < 3000 {
				break
			}
			out = append(out, Clip{start, start + size})
			total += size
			start += size
		}
	}
	if len(out) < 2 || total < 6000 {
		return nil
	}
	return out
}
