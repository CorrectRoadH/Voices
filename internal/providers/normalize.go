package providers

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

type sonioxToken struct {
	Text    string  `json:"text"`
	Start   *int64  `json:"start_ms"`
	End     *int64  `json:"end_ms"`
	Speaker *string `json:"speaker"`
}

type assemblyWord struct {
	Text    string  `json:"text"`
	Start   *int64  `json:"start"`
	End     *int64  `json:"end"`
	Speaker *string `json:"speaker"`
}

type assemblySentence struct {
	Text  string         `json:"text"`
	Start *int64         `json:"start"`
	End   *int64         `json:"end"`
	Words []assemblyWord `json:"words"`
}

func speakerEqual(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func cleanSpeaker(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

func timeRange(start, end *int64) (*int64, *int64) {
	if start == nil || end == nil || *start < 0 || *end < *start {
		return nil, nil
	}
	return start, end
}

// Only actual provider times may contribute. One missing or invalid word makes
// the aggregate untimed; do not interpolate from neighbouring words.
func wordRange(words []assemblyWord) (*int64, *int64) {
	if len(words) == 0 {
		return nil, nil
	}
	var first, last *int64
	for _, w := range words {
		start, end := timeRange(w.Start, w.End)
		if start == nil {
			return nil, nil
		}
		if first == nil {
			first = start
		}
		if *start < *first || last != nil && *end < *last {
			return nil, nil
		}
		last = end
	}
	return timeRange(first, last)
}

func normalizeAssemblySentence(s assemblySentence) []Segment {
	start, end := timeRange(s.Start, s.End)
	if len(s.Words) == 0 {
		return []Segment{{Text: s.Text, StartMS: start, EndMS: end}}
	}
	// Locate words inside the authoritative sentence text. Slicing that text
	// preserves its punctuation, whitespace and scripts without a lossy join.
	positions := make([]int, len(s.Words))
	offset := 0
	for i, w := range s.Words {
		index := strings.Index(s.Text[offset:], w.Text)
		if w.Text == "" || index < 0 {
			// Unexpected provider text/word disagreement must not drop text or
			// manufacture a speaker assignment for a sentence with mixed labels.
			sp := cleanSpeaker(s.Words[0].Speaker)
			for _, word := range s.Words {
				if !speakerEqual(sp, cleanSpeaker(word.Speaker)) {
					sp = nil
					break
				}
			}
			return []Segment{{Text: s.Text, StartMS: start, EndMS: end, Speaker: sp}}
		}
		positions[i] = offset + index
		offset = positions[i] + len(w.Text)
	}
	var segments []Segment
	first, textStart := 0, 0
	for i := 1; i <= len(s.Words); i++ {
		if i < len(s.Words) && speakerEqual(cleanSpeaker(s.Words[first].Speaker), cleanSpeaker(s.Words[i].Speaker)) {
			continue
		}
		textEnd := len(s.Text)
		if i < len(s.Words) {
			textEnd = positions[i]
		}
		a, b := wordRange(s.Words[first:i])
		if first == 0 && i == len(s.Words) && start != nil {
			a, b = start, end
		}
		text := strings.TrimSpace(s.Text[textStart:textEnd])
		if text != "" {
			segments = append(segments, Segment{Text: text, StartMS: a, EndMS: b, Speaker: cleanSpeaker(s.Words[first].Speaker)})
		}
		first, textStart = i, textEnd
	}
	return segments
}

func normalizeSoniox(tokens []sonioxToken) []Segment {
	segments := []Segment{}
	var text strings.Builder
	var words []assemblyWord
	var speaker *string
	flush := func() {
		if value := strings.TrimSpace(text.String()); value != "" {
			start, end := wordRange(words)
			segments = append(segments, Segment{Text: value, StartMS: start, EndMS: end, Speaker: speaker})
		}
		text.Reset()
		words = nil
	}
	for i, token := range tokens {
		if token.Text == "" {
			continue
		}
		sp := cleanSpeaker(token.Speaker)
		if text.Len() > 0 && !speakerEqual(speaker, sp) {
			flush()
		}
		speaker = sp
		text.WriteString(token.Text)
		words = append(words, assemblyWord{Text: token.Text, Start: token.Start, End: token.End})
		if i+1 == len(tokens) || sonioxSentenceBoundary(text.String(), tokens[i+1].Text) {
			flush()
		}
	}
	flush()
	return segments
}

// Async Soniox has no separate sentence object. Use the punctuation supplied
// by the model at token boundaries; never split a subword or a decimal token.
// Without punctuation, the provider speaker run remains one segment.
func sonioxSentenceBoundary(text, next string) bool {
	last, _ := utf8.DecodeLastRuneInString(strings.TrimRightFunc(text, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("\"'”’）)]}」』", r) }))
	if strings.ContainsRune("。！？", last) {
		return true
	}
	if strings.ContainsRune(".!?", last) {
		first, _ := utf8.DecodeRuneInString(next)
		return unicode.IsSpace(first)
	}
	return strings.ContainsAny(text, "\r\n")
}
