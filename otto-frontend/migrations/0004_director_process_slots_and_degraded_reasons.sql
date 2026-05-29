ALTER TABLE agent_decision_log
  ADD COLUMN IF NOT EXISTS degraded_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE slot_states
  ADD COLUMN IF NOT EXISTS candidate_process_id uuid REFERENCES candidate_processes(id);

DROP INDEX IF EXISTS slot_states_capture_slot_idx;
ALTER TABLE slot_states
  DROP CONSTRAINT IF EXISTS slot_states_capture_session_id_slot_path_key;

CREATE UNIQUE INDEX IF NOT EXISTS slot_states_capture_global_slot_idx
  ON slot_states(capture_session_id, slot_path)
  WHERE candidate_process_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS slot_states_capture_candidate_slot_idx
  ON slot_states(capture_session_id, candidate_process_id, slot_path)
  WHERE candidate_process_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS slot_states_candidate_process_id_idx
  ON slot_states(candidate_process_id)
  WHERE candidate_process_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS slot_states_capture_slot_idx
  ON slot_states(capture_session_id, slot_path);
