// Package outbound observes metadata of a single adapter operation, never content.
package outbound

import (
	"context"
	"sync"
)

type key struct{}
type Metadata struct {
	RequestStarted                         bool
	HTTPStatus                             *int
	InputTokens, OutputTokens, TotalTokens *int64
}
type Observation struct {
	mu   sync.Mutex
	data Metadata
}

func WithObservation(ctx context.Context) (context.Context, *Observation) {
	o := &Observation{}
	return context.WithValue(ctx, key{}, o), o
}
func (o *Observation) Snapshot() Metadata { o.mu.Lock(); defer o.mu.Unlock(); return o.data }
func change(ctx context.Context, f func(*Metadata)) {
	if o, ok := ctx.Value(key{}).(*Observation); ok {
		o.mu.Lock()
		defer o.mu.Unlock()
		f(&o.data)
	}
}
func MarkStarted(ctx context.Context) { change(ctx, func(m *Metadata) { m.RequestStarted = true }) }
func MarkStatus(ctx context.Context, status int) {
	if status >= 100 && status <= 599 {
		change(ctx, func(m *Metadata) { m.HTTPStatus = &status })
	}
}
func MarkUsage(ctx context.Context, input, output, total *int64) {
	valid := func(v *int64) *int64 {
		if v == nil || *v < 0 {
			return nil
		}
		n := *v
		return &n
	}
	change(ctx, func(m *Metadata) {
		m.InputTokens, m.OutputTokens, m.TotalTokens = valid(input), valid(output), valid(total)
	})
}
