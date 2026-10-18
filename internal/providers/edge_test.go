package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// @use-case docs/feature/transcription/use-case/transcribe.md

func TestPollMapsStatesAndSanitizesFailure(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for status, want := range map[string]string{"queued": "pending", "processing": "running", "completed": "completed", "error": "failed"} {
			t.Run(provider+"/"+status, func(t *testing.T) {
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
					json.NewEncoder(w).Encode(map[string]any{"status": status, "error": testKey, "error_message": testKey, "error_type": testKey})
				})
				state, err := a.Poll(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
				if err != nil || state.State != want {
					t.Fatalf("state=%+v err=%v", state, err)
				}
				if status == "error" && state.ErrorCode != "transcription_failed" {
					t.Fatalf("unsafe error code: %q", state.ErrorCode)
				}
			})
		}
	}
}

func TestReadAndCleanupFailures(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"poll", "fetch", "delete"} {
			for _, tc := range []struct {
				status int
				code   string
			}{{401, "auth"}, {404, "not_found"}, {429, "rate_limited"}, {409, "transient"}, {500, "transient"}} {
				t.Run(provider+"/"+operation+"/"+tc.code, func(t *testing.T) {
					a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Retry-After", time.Now().Add(45*time.Second).UTC().Format(http.TimeFormat))
						w.WriteHeader(tc.status)
						io.WriteString(w, "private body "+testKey)
					})
					resource := Resource{ID: "job-123", Kind: "transcription"}
					var err error
					switch operation {
					case "poll":
						_, err = a.Poll(context.Background(), resource)
					case "fetch":
						_, err = a.FetchResult(context.Background(), resource)
					case "delete":
						err = a.DeleteResource(context.Background(), resource)
					}
					pe := assertProviderError(t, err, tc.code, false)
					if tc.status == 429 && (pe.RetryAfterSeconds < 43 || pe.RetryAfterSeconds > 45) {
						t.Fatalf("date Retry-After = %d", pe.RetryAfterSeconds)
					}
				})
			}
		}
	}
}

func TestCanceledReadAndCleanup(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, operation := range []string{"poll", "fetch", "delete"} {
			t.Run(provider+"/"+operation, func(t *testing.T) {
				var calls atomic.Int32
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				resource := Resource{ID: "job-123", Kind: "transcription"}
				var err error
				switch operation {
				case "poll":
					_, err = a.Poll(ctx, resource)
				case "fetch":
					_, err = a.FetchResult(ctx, resource)
				case "delete":
					err = a.DeleteResource(ctx, resource)
				}
				assertProviderError(t, err, "transient", false)
				if calls.Load() != 0 {
					t.Fatal("canceled operation reached server")
				}
			})
		}
	}
}

func TestResultNormalizationAtHTTPBoundary(t *testing.T) {
	cases := []struct {
		name, provider, body string
		want                 []Segment
	}{
		{"plain-text-fallback", "soniox", `{"text":"Keep punctuation, please! 下一句。"}`, []Segment{{Text: "Keep punctuation, please! 下一句。"}}},
		{"untimed-and-unknown", "soniox", `{"tokens":[{"text":"No"},{"text":" time!"}]}`, []Segment{{Text: "No time!"}}},
		{"one-time-missing", "soniox", `{"tokens":[{"text":"First","start_ms":0,"end_ms":10},{"text":" second.","start_ms":10}]}`, []Segment{{Text: "First second."}}},
		{"invalid-time", "soniox", `{"tokens":[{"text":"Invalid.","start_ms":100,"end_ms":1,"speaker":"A"}]}`, []Segment{{Text: "Invalid.", Speaker: ptr("A")}}},
		{"speaker-change-without-punctuation", "soniox", `{"tokens":[{"text":"First","speaker":"A"},{"text":" second","speaker":"B"},{"text":" unknown"}]}`, []Segment{{Text: "First", Speaker: ptr("A")}, {Text: "second", Speaker: ptr("B")}, {Text: "unknown"}}},
		{"quoted-boundary-and-decimal", "soniox", `{"tokens":[{"text":"He said \"hi"},{"text":"."},{"text":"\""},{"text":" Pi is 3"},{"text":"."},{"text":"14"},{"text":"."}]}`, []Segment{{Text: `He said "hi."`}, {Text: "Pi is 3.14."}}},
		{"cjk-boundaries", "soniox", `{"tokens":[{"text":"你好。"},{"text":"再見！"},{"text":"好吗？"}]}`, []Segment{{Text: "你好。"}, {Text: "再見！"}, {Text: "好吗？"}}},
		{"provider-text-only-sentence", "assemblyai", `{"sentences":[{"text":"Kept, exactly!","start":0,"end":20}]}`, []Segment{{Text: "Kept, exactly!", StartMS: ptr[int64](0), EndMS: ptr[int64](20)}}},
		{"word-missing-time-at-speaker-change", "assemblyai", `{"sentences":[{"text":"Hi, there!","words":[{"text":"Hi,","start":0,"end":10,"speaker":"A"},{"text":"there!","start":10,"speaker":"B"}]}]}`, []Segment{{Text: "Hi,", StartMS: ptr[int64](0), EndMS: ptr[int64](10), Speaker: ptr("A")}, {Text: "there!", Speaker: ptr("B")}}},
		{"authoritative-punctuation", "assemblyai", `{"sentences":[{"text":"「你好」，世界！","words":[{"text":"你好","speaker":"A"},{"text":"世界","speaker":"B"}]}]}`, []Segment{{Text: "「你好」，", Speaker: ptr("A")}, {Text: "世界！", Speaker: ptr("B")}}},
		{"mismatched-words-preserve-text", "assemblyai", `{"sentences":[{"text":"Authoritative, text!","words":[{"text":"different","speaker":"A"},{"text":"words","speaker":"B"}]}]}`, []Segment{{Text: "Authoritative, text!"}}},
		{"no-identity-inference", "assemblyai", `{"sentences":[{"text":"Known unknown.","words":[{"text":"Known","speaker":"A"},{"text":"unknown."}]}]}`, []Segment{{Text: "Known", Speaker: ptr("A")}, {Text: "unknown."}}},
		{"silent-audio", "assemblyai", `{"sentences":[]}`, []Segment{}},
		{"silent-audio", "soniox", `{"text":"","tokens":[]}`, []Segment{}},
	}
	for _, tc := range cases {
		t.Run(tc.provider+"/"+tc.name, func(t *testing.T) {
			a := withServer(t, tc.provider, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, tc.body) })
			result, err := a.FetchResult(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(result.Segments, tc.want) || string(result.Raw) != tc.body {
				t.Fatalf("segments=%#v want=%#v", result.Segments, tc.want)
			}
			for _, segment := range result.Segments {
				if (segment.StartMS == nil) != (segment.EndMS == nil) {
					t.Fatal("unpaired timestamps")
				}
			}
		})
	}
}

func TestMalformedResultsAndUnknownStates(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		for _, body := range []string{`{}`, `null`, `{"status":"future-unknown-state"}`, `{"status":123}`, `not json`} {
			t.Run(provider+"/"+body, func(t *testing.T) {
				a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
				_, err := a.Poll(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
				assertProviderError(t, err, "transient", false)
				_, err = a.FetchResult(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
				assertProviderError(t, err, "transient", false)
			})
		}
	}
}

func TestSubmitLanguageModesAndPinnedModels(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		models := NewSoniox(testKey).Models()
		if provider == "assemblyai" {
			models = NewAssemblyAI(testKey).Models()
		}
		for _, model := range models {
			for _, mode := range []string{"auto", "single", "multi"} {
				t.Run(provider+"/"+model.ID+"/"+mode, func(t *testing.T) {
					a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Error(err)
						}
						if provider == "soniox" {
							if body["model"] != model.ID {
								t.Error("model changed")
							}
							_, hints := body["language_hints"]
							_, strict := body["language_hints_strict"]
							if hints != (mode != "auto") || strict != (mode != "auto") {
								t.Error("language mode changed")
							}
						} else {
							if !reflect.DeepEqual(body["speech_models"], []any{model.ID}) {
								t.Error("fallback/model changed")
							}
							for _, field := range []string{"language_detection", "language_code", "language_codes"} {
								_, present := body[field]
								want := field == map[string]string{"auto": "language_detection", "single": "language_code", "multi": "language_codes"}[mode]
								if present != want {
									t.Errorf("unexpected language field %s", field)
								}
							}
						}
						io.WriteString(w, `{"id":"job-123"}`)
					})
					o := Options{Provider: provider, Model: model.ID, LanguageMode: mode}
					if mode == "single" {
						o.Languages = []string{"en"}
					}
					if mode == "multi" {
						o.Languages = []string{"en", "es"}
					}
					if _, err := a.Submit(context.Background(), fileFor(provider), o); err != nil {
						t.Fatal(err)
					}
				})
			}
		}
	}
}

func TestInvalidCapabilitiesNeverSendRequest(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		t.Run(provider, func(t *testing.T) {
			var calls atomic.Int32
			a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
			base := autoOptions(a)
			for _, tc := range []struct {
				edit func(*Options)
				code string
			}{
				{func(o *Options) { o.Model = "old-model" }, "unsupported"},
				{func(o *Options) { o.Provider = "wrong" }, "invalid"},
				{func(o *Options) { o.LanguageMode = "other" }, "unsupported"},
				{func(o *Options) { o.Languages = []string{"en"} }, "invalid"},
				{func(o *Options) { o.LanguageMode = "single" }, "invalid"},
				{func(o *Options) { o.LanguageMode = "multi"; o.Languages = []string{"en"} }, "invalid"},
				{func(o *Options) { o.LanguageMode = "multi"; o.Languages = []string{"en", "en"} }, "invalid"},
				{func(o *Options) { o.LanguageMode = "single"; o.Languages = []string{"not-supported"} }, "unsupported"},
			} {
				o := base
				tc.edit(&o)
				_, err := a.Submit(context.Background(), fileFor(provider), o)
				assertProviderError(t, err, tc.code, true)
			}
			if provider == "assemblyai" {
				for _, languages := range [][]string{{"zh", "ja"}, {"en", "es", "de"}} {
					o := Options{Provider: provider, Model: "universal-2", LanguageMode: "multi", Languages: languages}
					_, err := a.Submit(context.Background(), fileFor(provider), o)
					assertProviderError(t, err, "unsupported", true)
				}
			}
			for _, resource := range []Resource{{ID: "../evil", Kind: "transcription"}, {ID: "job-123", Kind: "file"}, {ID: "https://evil.example", Kind: "transcription"}} {
				_, err := a.Poll(context.Background(), resource)
				assertProviderError(t, err, "invalid", true)
				_, err = a.FetchResult(context.Background(), resource)
				assertProviderError(t, err, "invalid", true)
			}
			_, err := a.Upload(context.Background(), nil, "file.wav", 5)
			assertProviderError(t, err, "invalid", true)
			_, err = a.Upload(context.Background(), strings.NewReader("audio"), "file.wav", 0)
			assertProviderError(t, err, "invalid", true)
			_, err = a.Upload(context.Background(), strings.NewReader("audio"), "file.wav", -1)
			assertProviderError(t, err, "invalid", true)
			if provider == "soniox" {
				_, err = a.Upload(context.Background(), strings.NewReader("audio"), "evil\r\nheader", 5)
				assertProviderError(t, err, "invalid", true)
			}
			if provider == "assemblyai" {
				_, err = a.Upload(context.Background(), strings.NewReader("audio"), "file.wav", 2200000001)
				assertProviderError(t, err, "invalid", true)
			}
			if calls.Load() != 0 {
				t.Fatalf("preflight made %d requests", calls.Load())
			}
		})
	}
}

func TestCatalogIsolation(t *testing.T) {
	for _, a := range []Adapter{NewSoniox(testKey), NewAssemblyAI(testKey)} {
		before := a.Models()
		modified := a.Models()
		modified[0].ID = "mutated"
		modified[0].Languages[0] = "mutated"
		modified[0].LanguageModes[0] = "mutated"
		if !reflect.DeepEqual(before, a.Models()) {
			t.Fatal("caller mutated shared capability catalog")
		}
		for _, m := range before {
			if len(m.Languages) < 18 || !m.Diarization || !m.Timestamps || m.MaxDurationMS <= 0 {
				t.Fatalf("incomplete capabilities: %+v", m)
			}
			seen := map[string]bool{}
			for _, lang := range m.Languages {
				if seen[lang] {
					t.Errorf("duplicate language %s", lang)
				}
				seen[lang] = true
			}
		}
	}
}

func TestMissingKeyAndTruncatedUpload(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		t.Run(provider, func(t *testing.T) {
			a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				if provider == "soniox" {
					io.WriteString(w, `{"id":"file-123"}`)
				} else {
					io.WriteString(w, `{"upload_url":"https://cdn.assemblyai.com/upload/file-123"}`)
				}
			})
			_, err := a.Upload(context.Background(), strings.NewReader("short"), "file.wav", 5000)
			assertProviderError(t, err, "uncertain", false)
			if provider == "soniox" {
				a.(*soniox).apiKey = ""
			} else {
				a.(*assemblyAI).apiKey = ""
			}
			_, err = a.Submit(context.Background(), fileFor(provider), autoOptions(a))
			assertProviderError(t, err, "auth", true)
		})
	}
}

// Both incomplete response bodies and server acceptance followed by a dropped
// connection lack definitive rejection evidence, even if HTTP headers arrived.
func TestTruncatedResponseIsNeverDefinitive(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		t.Run(provider, func(t *testing.T) {
			a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Length", "5000")
				io.WriteString(w, `{"id":"job-123"}`)
			})
			_, err := a.Submit(context.Background(), fileFor(provider), autoOptions(a))
			assertProviderError(t, err, "uncertain", false)
			_, err = a.Poll(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
			assertProviderError(t, err, "transient", false)
		})
	}
}

func TestAcceptedDeletionDoesNotClaimCleanupCompleted(t *testing.T) {
	for _, provider := range []string{"soniox", "assemblyai"} {
		t.Run(provider, func(t *testing.T) {
			a := withServer(t, provider, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusAccepted)
			})
			err := a.DeleteResource(context.Background(), Resource{ID: "job-123", Kind: "transcription"})
			assertProviderError(t, err, "transient", false)
		})
	}
}
