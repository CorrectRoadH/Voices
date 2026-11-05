package voiceprints

import (
	"math"
	"testing"
)

func vector(x, y float64) []float64 { v := make([]float64, 192); v[0] = x; v[1] = y; return v }

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintPurityAndOpenSetMatching(t *testing.T) {
	for _, v := range [][]float64{vector(0, 1), vector(.5, math.Sqrt(.75))} {
		if _, err := Average([][]float64{vector(1, 0), v}, true); err == nil {
			t.Fatal("mixed pair passed")
		}
	}
	if _, err := Average([][]float64{vector(1, 0), vector(1, 0), vector(0, 1)}, true); err == nil {
		t.Fatal("outlier passed")
	}
	for _, v := range [][]float64{vector(0, 0), vector(math.NaN(), 0), vector(math.Inf(1), 0), {1}} {
		if _, err := Normalize(v); err == nil {
			t.Fatal("invalid vector accepted")
		}
	}
	if id, _ := Match(vector(1, 0), map[string][][]float64{"a": {vector(1, 0)}, "b": {vector(.99, .1)}}); id != "" {
		t.Fatal("ambiguous matched")
	}
	if id, _ := Match(vector(0, 1), map[string][][]float64{"a": {vector(1, 0)}}); id != "" {
		t.Fatal("stranger matched")
	}
	if id, _ := Match(vector(1, 0), map[string][][]float64{"a": {vector(1, 0)}}); id != "a" {
		t.Fatal(id)
	}
}

// @use-case docs/feature/people/use-case/recognize-speaker.md
func TestVoiceprintUniqueAudioAndExplicitOverrideBlockers(t *testing.T) {
	a, b, c, d := int64(0), int64(10000), int64(3000), int64(6000)
	original := Segment{"a", "inherit", &a, &b}
	clips := Clips([]Segment{original, original}, "a", 10000)
	ms := int64(0)
	for _, c := range clips {
		ms += c.End - c.Start
	}
	if ms != 10000 {
		t.Fatal(ms)
	}
	for _, blocker := range []Segment{{"a", "unknown", &c, &d}, {"a", "label", &c, &d}, {"b", "inherit", &c, &d}, {"", "inherit", &c, &d}} {
		if len(Clips([]Segment{original, blocker}, "a", 10000)) != 0 {
			t.Fatal("overlap sampled", blocker)
		}
	}
	short := int64(2000)
	if len(Clips([]Segment{{"a", "inherit", &a, &short}}, "a", 10000)) != 0 {
		t.Fatal("short sample accepted")
	}
}
