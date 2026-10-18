package updates

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Snapshot struct {
	CurrentVersion  string         `json:"current_version"`
	LatestVersion   *string        `json:"latest_version"`
	UpdateAvailable bool           `json:"update_available"`
	Status          string         `json:"status"`
	CheckedAt       *time.Time     `json:"checked_at"`
	LastSuccessAt   *time.Time     `json:"last_success_at"`
	ReleaseURL      *string        `json:"release_url"`
	ReleasedAt      *time.Time     `json:"released_at"`
	ReleaseNotes    string         `json:"release_notes"`
	Announcements   []Announcement `json:"announcements"`
}

type Telemetry struct{ InstanceID string }

type Manager struct {
	telemetry *Telemetry
	ctx       context.Context
	cancel    context.CancelFunc
	endpoint  string
	client    *http.Client
	mu        sync.Mutex
	state     Snapshot
	flight    chan struct{}
	wg        sync.WaitGroup
	closed    bool
	now       func() time.Time
}

func New(ctx context.Context, version, endpoint string, client *http.Client) *Manager {
	return NewWithTelemetry(ctx, version, endpoint, client, nil)
}

func NewWithTelemetry(ctx context.Context, version, endpoint string, client *http.Client, telemetry *Telemetry) *Manager {
	ctx, cancel := context.WithCancel(ctx)
	// Copy caller-owned configuration; invalid identities disable all metadata.
	var snapshot *Telemetry
	if telemetry != nil {
		if id, err := uuid.Parse(telemetry.InstanceID); err == nil && id != uuid.Nil {
			snapshot = &Telemetry{InstanceID: id.String()}
		}
	}
	if client == nil {
		client = &http.Client{}
	}
	transport := *client
	transport.Timeout = 5 * time.Second
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }
	status := "unchecked"
	if endpoint == "" {
		status = "disabled"
	}
	return &Manager{telemetry: snapshot, ctx: ctx, cancel: cancel, endpoint: endpoint, client: &transport, now: time.Now, state: Snapshot{CurrentVersion: strings.TrimPrefix(version, "v"), Status: status, Announcements: []Announcement{}}}
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.state
	s.Announcements = []Announcement{}
	now := m.now()
	for _, a := range m.state.Announcements {
		if !now.Before(a.PublishedAt) && (a.ExpiresAt == nil || now.Before(*a.ExpiresAt)) {
			s.Announcements = append(s.Announcements, a)
		}
	}
	return s
}

// Check joins a process-owned request. A cancelled caller only stops waiting.
func (m *Manager) Check(ctx context.Context) Snapshot {
	m.mu.Lock()
	if m.closed || m.ctx.Err() != nil || m.endpoint == "" {
		m.mu.Unlock()
		return m.Snapshot()
	}
	done := m.flight
	if done == nil {
		if m.state.CheckedAt != nil && m.now().Sub(*m.state.CheckedAt) < time.Minute {
			m.mu.Unlock()
			return m.Snapshot()
		}
		done = make(chan struct{})
		m.flight = done
		m.wg.Add(1)
		go m.fetch(done)
	}
	m.mu.Unlock()
	select {
	case <-ctx.Done():
	case <-done:
	}
	return m.Snapshot()
}

func (m *Manager) fetch(done chan struct{}) {
	defer m.wg.Done()
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
	defer cancel()
	manifest, err := m.request(ctx)
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now().UTC()
	m.state.CheckedAt = &now
	m.state.Status = "error"
	if err == nil {
		m.state.Announcements = manifest.Announcements
		if manifest.LatestVersion != nil {
			m.state.Status = "ok"
			m.state.LastSuccessAt = &now
			m.state.LatestVersion = manifest.LatestVersion
			m.state.ReleaseURL = manifest.ReleaseURL
			m.state.ReleasedAt = manifest.ReleasedAt
			m.state.ReleaseNotes = manifest.ReleaseNotes
			m.state.UpdateAvailable = Newer(*manifest.LatestVersion, m.state.CurrentVersion)
		}
	}
	m.flight = nil
	close(done)
}

func (m *Manager) request(ctx context.Context) (Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.endpoint, nil)
	if err != nil {
		return Manifest{}, err
	}
	if m.telemetry != nil {
		q := req.URL.Query()
		q.Set("instanceId", m.telemetry.InstanceID)
		q.Set("version", m.state.CurrentVersion)
		q.Set("goVersion", runtime.Version())
		q.Set("os", runtime.GOOS)
		q.Set("arch", runtime.GOARCH)
		req.URL.RawQuery = q.Encode()
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "voices-updates")
	resp, err := m.client.Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, errors.New("update service unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		return Manifest{}, err
	}
	if len(body) > MaxResponseBytes {
		return Manifest{}, errors.New("manifest too large")
	}
	return decodeManifest(body)
}

func (m *Manager) Run() {
	defer m.Close()
	if m.endpoint == "" {
		return
	}
	m.Check(m.ctx)
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.Check(m.ctx)
		}
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	m.mu.Unlock()
	m.wg.Wait()
}
