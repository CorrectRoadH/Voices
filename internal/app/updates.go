package app

import "net/http"

func (a *App) adminUpdates(w http.ResponseWriter, r *http.Request) error {
	snapshot := a.Updates.Snapshot()
	if r.Method == http.MethodPost {
		snapshot = a.Updates.Check(r.Context())
	}
	writeJSON(w, http.StatusOK, snapshot)
	return nil
}
