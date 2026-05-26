ALTER TABLE agent_decision_log
  ADD COLUMN IF NOT EXISTS delivery_json jsonb;
ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS turn_index integer;
ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS timing_source text;
ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS transcript_segments_capture_turn_idx
  ON transcript_segments(capture_session_id, turn_index)
  WHERE turn_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_decision_log_capture_turn_stage_idx
  ON agent_decision_log(capture_session_id, turn_index, stage_name)
  WHERE capture_session_id IS NOT NULL
    AND turn_index IS NOT NULL
    AND stage_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS interview_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  current_phase text NOT NULL DEFAULT 'orient',
  focus_candidate_process_id uuid REFERENCES candidate_processes(id),
  focus_process_id uuid REFERENCES processes(id),
  prior_intent text,
  low_info_turn_count integer NOT NULL DEFAULT 0,
  last_new_slot_turn_index integer,
  phase_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_session_id)
);
CREATE INDEX IF NOT EXISTS interview_state_org_id_idx ON interview_state(org_id);
CREATE INDEX IF NOT EXISTS interview_state_workspace_id_idx ON interview_state(workspace_id);

CREATE TABLE IF NOT EXISTS probe_firings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  probe_id text NOT NULL,
  target_slot text,
  target_candidate_process_id uuid REFERENCES candidate_processes(id),
  turn_index integer NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  style_hint text,
  resolved_status_after text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS probe_firings_org_id_idx ON probe_firings(org_id);
CREATE INDEX IF NOT EXISTS probe_firings_workspace_id_idx ON probe_firings(workspace_id);
CREATE INDEX IF NOT EXISTS probe_firings_capture_probe_idx
  ON probe_firings(capture_session_id, probe_id, fired_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS probe_firings_capture_turn_probe_idx
  ON probe_firings(capture_session_id, turn_index, probe_id);

ALTER TABLE interview_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_interview_state ON interview_state;
CREATE POLICY org_isolation_interview_state ON interview_state
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE probe_firings ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_firings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_probe_firings ON probe_firings;
CREATE POLICY org_isolation_probe_firings ON probe_firings
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
