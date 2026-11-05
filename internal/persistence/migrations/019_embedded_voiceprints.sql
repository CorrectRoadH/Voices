-- New native runtime profile: rebuild references before matching other tasks.
-- Claim priority is enforced by the worker, independent of migration row order.
INSERT INTO voiceprint_tasks(transcription_id,generation,state)
 SELECT t.id,gen_random_uuid(),'queued' FROM transcriptions t
 JOIN recordings r ON r.id=t.recording_id
 WHERE t.state='succeeded' AND r.state='ready'
 AND EXISTS(SELECT 1 FROM speaker_labels l WHERE l.transcription_id=t.id)
ON CONFLICT(transcription_id) DO UPDATE SET generation=gen_random_uuid(),
 state='queued',lease_until=NULL,error_code=NULL,updated_at=clock_timestamp();
