// Package storage keeps immutable media chunks and their leases in PostgreSQL.
package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"voices/internal/persistence"
)

const ChunkSize = 1048576

var ErrLease = errors.New("storage lease lost")
var ErrNotReady = errors.New("media unavailable")

type Store struct{ Pool *pgxpool.Pool }
type JobFence struct {
	ID, Owner  string
	Generation int64
}
type Writer struct {
	store       *Store
	ID, Owner   string
	Generation  int64
	Job         *JobFence
	RecordingID string
	Count       int
	Size        int64
	Digest      string
	ctx         context.Context
	cancel      context.CancelFunc
	done        chan struct{}
	mu          sync.Mutex
	leaseErr    error
}

func (s *Store) NewWriter(ctx context.Context, recording string, job *JobFence) (*Writer, error) {
	w := &Writer{store: s, ID: uuid.NewString(), Owner: uuid.NewString(), Generation: 1, Job: job, RecordingID: recording, done: make(chan struct{})}
	var jobID any
	var gen any
	if job != nil {
		jobID = job.ID
		gen = job.Generation
	}
	err := persistence.Transaction(ctx, s.Pool, func(tx pgx.Tx) error {
		if err := lockOwner(ctx, tx, recording, job); err != nil {
			return err
		}
		ownerID := persistence.UserID(ctx)
		if recording != "" {
			if err := tx.QueryRow(ctx, "SELECT owner_id FROM recordings WHERE id=$1", recording).Scan(&ownerID); err != nil {
				return err
			}
		}
		if job != nil {
			if err := tx.QueryRow(ctx, "SELECT owner_id FROM jobs WHERE id=$1", job.ID).Scan(&ownerID); err != nil {
				return err
			}
		}
		if ownerID == "" {
			return errors.New("blob account owner required")
		}
		_, err := tx.Exec(ctx, "INSERT INTO blobs(id,state,writer_id,write_lease_until,job_id,job_generation,owner_id) VALUES($1,'writing',$2,clock_timestamp()+interval '60 seconds',$3,$4,$5)", w.ID, w.Owner, jobID, gen, ownerID)
		return err
	})
	if err != nil {
		return nil, err
	}
	w.ctx, w.cancel = context.WithCancel(ctx)
	go w.heartbeat()
	return w, nil
}
func lockOwner(ctx context.Context, tx pgx.Tx, recording string, job *JobFence) error {
	if recording != "" {
		var state string
		if err := tx.QueryRow(ctx, "SELECT state FROM recordings WHERE id=$1 FOR UPDATE", recording).Scan(&state); err != nil {
			return err
		}
		if state == "deleting" {
			return ErrNotReady
		}
	}
	if job != nil {
		var valid bool
		if err := tx.QueryRow(ctx, "SELECT lease_owner=$2::uuid AND lease_generation=$3 AND lease_until>clock_timestamp() AND state='running' AND NOT cancel_requested FROM jobs WHERE id=$1 FOR UPDATE", job.ID, job.Owner, job.Generation).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrLease
		}
	}
	return nil
}
func (w *Writer) heartbeat() {
	defer close(w.done)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-w.ctx.Done():
			return
		case <-ticker.C:
			err := persistence.Transaction(w.ctx, w.store.Pool, func(tx pgx.Tx) error {
				if err := lockOwner(w.ctx, tx, w.RecordingID, w.Job); err != nil {
					return err
				}
				tag, err := tx.Exec(w.ctx, "UPDATE blobs SET write_lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1 AND writer_id=$2 AND write_generation=$3 AND state='writing' AND write_lease_until>clock_timestamp()", w.ID, w.Owner, w.Generation)
				if err != nil {
					return err
				}
				if tag.RowsAffected() != 1 {
					return ErrLease
				}
				return nil
			})
			if err != nil {
				w.mu.Lock()
				w.leaseErr = err
				w.mu.Unlock()
				w.cancel()
				return
			}
		}
	}
}
func (w *Writer) Close() { w.cancel(); <-w.done }
func (w *Writer) WriteFrom(ctx context.Context, r io.Reader, mirror io.Writer, max int64) error {
	hash := sha256.New()
	buf := make([]byte, ChunkSize)
	for {
		n, err := io.ReadFull(r, buf)
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			return err
		}
		if n == 0 {
			break
		}
		if w.Size+int64(n) > max {
			return errors.New("media exceeds size limit")
		}
		w.mu.Lock()
		leaseErr := w.leaseErr
		w.mu.Unlock()
		if leaseErr != nil {
			return leaseErr
		}
		if mirror != nil {
			if _, e := mirror.Write(buf[:n]); e != nil {
				return e
			}
		}
		if e := w.append(ctx, buf[:n]); e != nil {
			return e
		}
		hash.Write(buf[:n])
		w.Count++
		w.Size += int64(n)
		if err != nil {
			break
		}
	}
	if w.Size == 0 {
		return errors.New("empty media")
	}
	w.Digest = hex.EncodeToString(hash.Sum(nil))
	return nil
}
func (w *Writer) append(ctx context.Context, data []byte) error {
	return persistence.Transaction(ctx, w.store.Pool, func(tx pgx.Tx) error {
		if err := lockOwner(ctx, tx, w.RecordingID, w.Job); err != nil {
			return err
		}
		var count int
		var size int64
		var valid bool
		if err := tx.QueryRow(ctx, "SELECT chunk_count,size_bytes,state='writing' AND writer_id=$2::uuid AND write_generation=$3 AND write_lease_until>clock_timestamp() FROM blobs WHERE id=$1 FOR UPDATE", w.ID, w.Owner, w.Generation).Scan(&count, &size, &valid); err != nil {
			return err
		}
		if !valid {
			return ErrLease
		}
		if count == w.Count+1 && size == w.Size+int64(len(data)) {
			var previous []byte
			if err := tx.QueryRow(ctx, "SELECT data FROM blob_chunks WHERE blob_id=$1 AND ordinal=$2", w.ID, w.Count).Scan(&previous); err != nil {
				return err
			}
			if !bytes.Equal(previous, data) {
				return errors.New("immutable chunk mismatch")
			}
			return nil
		}
		if count != w.Count || size != w.Size || size != int64(count)*ChunkSize {
			return errors.New("non-contiguous blob write")
		}
		if _, err := tx.Exec(ctx, "INSERT INTO blob_chunks(blob_id,ordinal,data) VALUES($1,$2,$3)", w.ID, count, data); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE blobs SET chunk_count=chunk_count+1,size_bytes=size_bytes+$2,updated_at=clock_timestamp() WHERE id=$1", w.ID, len(data))
		return err
	})
}

// Publish is called inside the same transaction that creates the business reference.
// The caller must already hold its recording/job locks in that order.
func (w *Writer) Publish(ctx context.Context, tx pgx.Tx) error {
	if err := lockOwner(ctx, tx, w.RecordingID, w.Job); err != nil {
		return err
	}
	if w.Digest == "" || w.Size == 0 {
		return errors.New("incomplete blob")
	}
	var count int
	var size int64
	var valid bool
	if err := tx.QueryRow(ctx, "SELECT chunk_count,size_bytes,state='writing' AND writer_id=$2::uuid AND write_generation=$3 AND write_lease_until>clock_timestamp() FROM blobs WHERE id=$1 FOR UPDATE", w.ID, w.Owner, w.Generation).Scan(&count, &size, &valid); err != nil {
		return err
	}
	if !valid {
		return ErrLease
	}
	if count != w.Count || size != w.Size {
		return errors.New("blob manifest mismatch")
	}
	var validChunks bool
	if err := tx.QueryRow(ctx, "SELECT count(*)=$2 AND min(ordinal)=0 AND max(ordinal)=$2-1 AND sum(octet_length(data))=$3 AND bool_and(ordinal=$2-1 OR octet_length(data)=1048576) FROM blob_chunks WHERE blob_id=$1", w.ID, count, size).Scan(&validChunks); err != nil {
		return err
	}
	if !validChunks {
		return errors.New("blob chunks mismatch")
	}
	_, err := tx.Exec(ctx, "UPDATE blobs SET state='ready',sha256=$2,writer_id=NULL,write_lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", w.ID, w.Digest)
	return err
}

type Reader struct {
	store                   *Store
	ID, BlobID, RecordingID string
	Size                    int64
	position                int64
	buf                     []byte
	bufOrdinal              int64
	ctx                     context.Context
	cancel                  context.CancelFunc
	done                    chan struct{}
	mu                      sync.Mutex
	leaseErr                error
}

func (s *Store) Open(ctx context.Context, recording, blob string) (*Reader, error) {
	r := &Reader{store: s, ID: uuid.NewString(), BlobID: blob, RecordingID: recording, bufOrdinal: -1, done: make(chan struct{})}
	err := persistence.Transaction(ctx, s.Pool, func(tx pgx.Tx) error {
		if err := lockOwner(ctx, tx, recording, nil); err != nil {
			return err
		}
		var state string
		if err := tx.QueryRow(ctx, "SELECT state,size_bytes FROM blobs WHERE id=$1 FOR UPDATE", blob).Scan(&state, &r.Size); err != nil {
			return err
		}
		if state != "ready" {
			return ErrNotReady
		}
		// A caller cannot lease a blob belonging to a different recording.
		var owned bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM media_assets WHERE recording_id=$1 AND blob_id=$2 UNION ALL SELECT 1 FROM transcriptions WHERE recording_id=$1 AND raw_response_blob_id=$2)", recording, blob).Scan(&owned); err != nil {
			return err
		}
		if !owned {
			return ErrNotReady
		}
		_, err := tx.Exec(ctx, "INSERT INTO blob_read_leases(id,blob_id,holder_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '30 seconds')", r.ID, blob, uuid.NewString())
		return err
	})
	if err != nil {
		return nil, err
	}
	r.ctx, r.cancel = context.WithCancel(ctx)
	go r.heartbeat()
	return r, nil
}
func (r *Reader) heartbeat() {
	defer close(r.done)
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-t.C:
			tag, err := r.store.Pool.Exec(r.ctx, "UPDATE blob_read_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM recordings WHERE id=$2 AND state<>'deleting')", r.ID, r.RecordingID)
			if err == nil && tag.RowsAffected() != 1 {
				err = ErrLease
			}
			if err != nil {
				r.mu.Lock()
				r.leaseErr = err
				r.mu.Unlock()
				r.cancel()
				return
			}
		}
	}
}
func (r *Reader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if r.position >= r.Size {
		return 0, io.EOF
	}
	r.mu.Lock()
	err := r.leaseErr
	r.mu.Unlock()
	if err != nil {
		return 0, err
	}
	ordinal := r.position / ChunkSize
	// Validate the lease even when the requested bytes are in the cached chunk.
	if ordinal != r.bufOrdinal {
		err = r.store.Pool.QueryRow(r.ctx, "SELECT c.data FROM blob_chunks c JOIN blobs b ON b.id=c.blob_id JOIN blob_read_leases l ON l.blob_id=b.id JOIN recordings r ON r.id=$4 WHERE c.blob_id=$1 AND c.ordinal=$2 AND l.id=$3 AND l.expires_at>clock_timestamp() AND b.state='ready' AND r.state<>'deleting'", r.BlobID, ordinal, r.ID, r.RecordingID).Scan(&r.buf)
		if err != nil {
			return 0, err
		}
		r.bufOrdinal = ordinal
	} else {
		var valid bool
		err = r.store.Pool.QueryRow(r.ctx, "SELECT EXISTS(SELECT 1 FROM blob_read_leases l JOIN recordings r ON r.id=$2 WHERE l.id=$1 AND l.expires_at>clock_timestamp() AND r.state<>'deleting')", r.ID, r.RecordingID).Scan(&valid)
		if err != nil {
			return 0, err
		}
		if !valid {
			return 0, ErrLease
		}
	}
	n := copy(p, r.buf[r.position%ChunkSize:])
	r.position += int64(n)
	return n, nil
}
func (r *Reader) Seek(offset int64, whence int) (int64, error) {
	var p int64
	switch whence {
	case io.SeekStart:
		p = offset
	case io.SeekCurrent:
		p = r.position + offset
	case io.SeekEnd:
		p = r.Size + offset
	default:
		return 0, errors.New("invalid whence")
	}
	if p < 0 {
		return 0, errors.New("negative seek")
	}
	r.position = p
	return p, nil
}
func (r *Reader) Close() error {
	r.cancel()
	<-r.done
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := r.store.Pool.Exec(ctx, "DELETE FROM blob_read_leases WHERE id=$1", r.ID)
	return err
}
