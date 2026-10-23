CREATE TABLE transcript_references (
 code text PRIMARY KEY CHECK(code ~ '^[A-Za-z0-9_-]{12}$'),
 owner_id uuid NOT NULL REFERENCES users(id),
 transcription_id uuid NOT NULL,
 segment_ids uuid[] NOT NULL CHECK(cardinality(segment_ids) BETWEEN 1 AND 100 AND array_position(segment_ids,NULL) IS NULL),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,transcription_id) REFERENCES transcriptions(owner_id,id) ON DELETE CASCADE
);
CREATE TRIGGER transcript_references_derive_owner BEFORE INSERT ON transcript_references FOR EACH ROW EXECUTE FUNCTION derive_owner('transcriptions','transcription_id');
CREATE TRIGGER transcript_references_owner_immutable BEFORE UPDATE ON transcript_references FOR EACH ROW EXECUTE FUNCTION immutable_owner();
CREATE INDEX transcript_references_transcription ON transcript_references(transcription_id);
