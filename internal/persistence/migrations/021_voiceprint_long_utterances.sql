-- Rebuild references using longer speech, then re-match recordings that may
-- previously have completed without any usable reference. Identity is preserved.
INSERT INTO voiceprint_tasks(transcription_id,generation,state)
 SELECT t.id,gen_random_uuid(),'queued' FROM transcriptions t
 JOIN recordings r ON r.id=t.recording_id
 WHERE t.state='succeeded' AND r.state='ready'
 AND EXISTS(SELECT 1 FROM speaker_labels l WHERE l.transcription_id=t.id)
ON CONFLICT(transcription_id) DO UPDATE SET generation=gen_random_uuid(),
 state='queued',lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()
WHERE voiceprint_tasks.state NOT IN ('queued','running');
