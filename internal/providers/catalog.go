package providers

import "slices"

// Catalog snapshot verified against the official docs on 2026-10-18:
// https://soniox.com/docs/stt/models
// https://soniox.com/docs/stt/concepts/supported-languages
// https://soniox.com/docs/stt/async/limits-and-quotas
// https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages
// https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model
// https://www.assemblyai.com/docs/pre-recorded-audio/code-switching
// https://support.assemblyai.com/articles/9208125065-are-there-any-limits-on-file-size-or-file-duration-for-files-submitted-to-the-api
// MaxFileBytes=0 means no universal published per-file limit is known (Soniox
// publishes configurable total-storage quotas, not a per-model byte ceiling).
var sonioxCatalog = []Model{{
	ID: "stt-async-v5", Name: "Soniox Async v5",
	Languages:     []string{"af", "sq", "ar", "az", "eu", "be", "bn", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "el", "gu", "he", "hi", "hu", "id", "it", "ja", "kn", "kk", "ko", "lv", "lt", "mk", "ms", "ml", "mr", "no", "fa", "pl", "pt", "pa", "ro", "ru", "sr", "sk", "sl", "es", "sw", "sv", "tl", "ta", "te", "th", "tr", "uk", "ur", "vi", "cy"},
	LanguageModes: []string{"auto", "single", "multi"}, Diarization: true, Timestamps: true, MaxDurationMS: 5 * 60 * 60 * 1000,
}}

var assemblyCatalog = []Model{
	{ID: "universal-3-5-pro", Name: "AssemblyAI Universal-3.5 Pro",
		Languages:     []string{"en", "en_au", "en_uk", "en_us", "es", "fr", "de", "it", "pt", "ar", "da", "nl", "fi", "he", "hi", "ja", "zh", "no", "sv", "tr", "vi"},
		LanguageModes: []string{"auto", "single", "multi"}, Diarization: true, Timestamps: true, MaxDurationMS: 10 * 60 * 60 * 1000, MaxFileBytes: 2200000000},
	{ID: "universal-2", Name: "AssemblyAI Universal-2",
		Languages:     []string{"en", "en_au", "en_uk", "en_us", "es", "fr", "de", "it", "pt", "nl", "hi", "ja", "zh", "fi", "ko", "pl", "ru", "tr", "uk", "vi", "af", "sq", "am", "ar", "hy", "as", "az", "ba", "eu", "be", "bn", "bs", "br", "bg", "my", "ca", "hr", "cs", "da", "et", "fo", "gl", "ka", "el", "gu", "ht", "ha", "haw", "he", "hu", "is", "id", "jw", "kn", "kk", "km", "lo", "la", "lv", "ln", "lt", "lb", "mk", "mg", "ms", "ml", "mt", "mi", "mr", "mn", "ne", "no", "nn", "oc", "pa", "ps", "fa", "ro", "sa", "sr", "sn", "sd", "si", "sk", "sl", "so", "su", "sw", "sv", "de_ch", "tl", "tg", "ta", "tt", "te", "th", "bo", "tk", "ur", "uz", "cy", "yi", "yo"},
		LanguageModes: []string{"auto", "single", "multi"}, Diarization: true, Timestamps: true, MaxDurationMS: 10 * 60 * 60 * 1000, MaxFileBytes: 2200000000},
}

func cloneModels(catalog []Model) []Model {
	models := slices.Clone(catalog)
	for i := range models {
		models[i].Languages = slices.Clone(models[i].Languages)
		models[i].LanguageModes = slices.Clone(models[i].LanguageModes)
	}
	return models
}

func validateOptions(provider string, models []Model, o Options) error {
	if o.Provider != provider {
		return localError("invalid")
	}
	idx := slices.IndexFunc(models, func(m Model) bool { return m.ID == o.Model })
	if idx < 0 {
		return localError("unsupported")
	}
	m := models[idx]
	if !slices.Contains(m.LanguageModes, o.LanguageMode) || o.Diarization && !m.Diarization {
		return localError("unsupported")
	}
	switch o.LanguageMode {
	case "auto":
		if len(o.Languages) != 0 {
			return localError("invalid")
		}
	case "single":
		if len(o.Languages) != 1 {
			return localError("invalid")
		}
	case "multi":
		if len(o.Languages) < 2 {
			return localError("invalid")
		}
	}
	seen := map[string]bool{}
	for _, lang := range o.Languages {
		if seen[lang] {
			return localError("invalid")
		}
		if !slices.Contains(m.Languages, lang) {
			return localError("unsupported")
		}
		seen[lang] = true
	}
	// The legacy Universal-2 language_codes contract supports two languages,
	// one of which must be global English. U3.5 has no such restriction.
	if provider == "assemblyai" && o.Model == "universal-2" && o.LanguageMode == "multi" && (len(o.Languages) != 2 || !seen["en"]) {
		return localError("unsupported")
	}
	return nil
}
