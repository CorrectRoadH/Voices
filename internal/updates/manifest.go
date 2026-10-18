// Package updates fetches public release information with optional installation telemetry.
package updates

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const MaxResponseBytes = 256 * 1024

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func versionParts(v string) ([3]uint64, bool) {
	var result [3]uint64
	v = strings.TrimPrefix(v, "v")
	if !stableVersion.MatchString(v) {
		return result, false
	}
	for i, part := range strings.Split(v, ".") {
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return result, false
		}
		result[i] = n
	}
	return result, true
}

func Newer(latest, current string) bool {
	a, okA := versionParts(latest)
	b, okB := versionParts(current)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func ValidEndpoint(raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && !u.ForceQuery
}

func validLink(raw *string) bool {
	if raw == nil {
		return true
	}
	u, err := url.Parse(*raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

type Announcement struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Body        string     `json:"body"`
	Severity    string     `json:"severity"`
	PublishedAt time.Time  `json:"publishedAt"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	Link        *string    `json:"link"`
}

type Manifest struct {
	SchemaVersion int            `json:"schemaVersion"`
	LatestVersion *string        `json:"latestVersion"`
	ReleaseURL    *string        `json:"releaseUrl"`
	ReleasedAt    *time.Time     `json:"releasedAt"`
	ReleaseNotes  string         `json:"releaseNotes"`
	Announcements []Announcement `json:"announcements"`
}

func decodeManifest(body []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return m, err
	}
	// Require all fields, including intentional nulls, rather than accepting zero-value omissions.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return m, err
	}
	for _, key := range []string{"schemaVersion", "latestVersion", "releaseUrl", "releasedAt", "releaseNotes", "announcements"} {
		if _, ok := fields[key]; !ok {
			return m, errors.New("incomplete manifest")
		}
	}
	if m.SchemaVersion != 1 || m.Announcements == nil || len(m.Announcements) > 20 || !validLink(m.ReleaseURL) || string(fields["releaseNotes"]) == "null" {
		return m, errors.New("invalid manifest")
	}
	if m.LatestVersion != nil {
		if _, ok := versionParts(*m.LatestVersion); !ok || strings.HasPrefix(*m.LatestVersion, "v") || m.ReleaseURL == nil || m.ReleasedAt == nil {
			return m, errors.New("invalid release")
		}
	} else if m.ReleaseURL != nil || m.ReleasedAt != nil || m.ReleaseNotes != "" {
		return m, errors.New("inconsistent release")
	}
	seen := map[string]bool{}
	var rawAnnouncements []map[string]json.RawMessage
	if err := json.Unmarshal(fields["announcements"], &rawAnnouncements); err != nil {
		return m, err
	}
	for i, a := range m.Announcements {
		for _, key := range []string{"id", "title", "body", "severity", "publishedAt", "expiresAt", "link"} {
			if _, ok := rawAnnouncements[i][key]; !ok {
				return m, errors.New("incomplete announcement")
			}
		}
		if a.ID == "" || len([]rune(a.ID)) > 100 || seen[a.ID] || a.Title == "" || len([]rune(a.Title)) > 200 || len([]rune(a.Body)) > 4000 || string(rawAnnouncements[i]["body"]) == "null" || a.PublishedAt.IsZero() || !validLink(a.Link) || (a.ExpiresAt != nil && !a.ExpiresAt.After(a.PublishedAt)) {
			return m, errors.New("invalid announcement")
		}
		if a.Severity != "info" && a.Severity != "warning" && a.Severity != "critical" {
			return m, errors.New("invalid severity")
		}
		seen[a.ID] = true
	}
	return m, nil
}
