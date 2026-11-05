// Package voiceprints owns bounded audio selection and model-specific matching.
// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
package voiceprints

import (
	"errors"
	"math"
	"sort"
)

const Model = "campplus-zh-v2:sherpa-1.13.8:s16le-16000-mono:f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
const Dimensions = 192

var ErrAudio = errors.New("insufficient_audio")

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
	candidates := []Clip{}
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
		// Six candidates from any single range are sufficient for a six-clip
		// result. Keep candidate generation bounded even for very long audio.
		for start, count := r.Start, 0; start+3000 <= r.End && count < 6; count++ {
			size := min(int64(10000), r.End-start)
			candidates = append(candidates, Clip{start, start + size})
			start += size
		}
	}
	// Early short/noisy phrases must not consume the whole sampling budget
	// before a clear sustained utterance later in the recording is considered.
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.End-a.Start != b.End-b.Start {
			return a.End-a.Start > b.End-b.Start
		}
		return a.Start < b.Start
	})
	out := []Clip{}
	total := int64(0)
	for _, c := range candidates {
		size := min(c.End-c.Start, 30000-total)
		if size < 3000 || len(out) == 6 {
			break
		}
		out = append(out, Clip{c.Start, c.Start + size})
		total += size
	}
	if len(out) == 1 && total >= 6000 {
		c := out[0]
		middle := (c.Start + c.End) / 2
		out = []Clip{{c.Start, middle}, {middle, c.End}}
	}
	if len(out) < 2 || total < 6000 {
		return nil
	}
	return out
}
