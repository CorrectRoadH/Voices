package persistence

import "context"

type userIDKey struct{}

// WithUserID carries an authenticated account, never a client-supplied owner.
func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, userIDKey{}, id)
}
func UserID(ctx context.Context) string {
	id, _ := ctx.Value(userIDKey{}).(string)
	return id
}
