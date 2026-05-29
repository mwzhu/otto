DO $$ BEGIN
  CREATE TYPE capture_mode AS ENUM (
    'director_voice',
    'operator_voice',
    'operator_screenshare',
    'screen_recording_upload',
    'process_document_upload',
    'mixed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS capture_mode capture_mode;

CREATE TABLE IF NOT EXISTS screen_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  ts_ms integer NOT NULL,
  event_type text NOT NULL,
  app_name text,
  window_title text,
  url text,
  ocr_text text,
  ui_state_label text,
  screenshot_artifact_id uuid REFERENCES artifacts(id),
  signal_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS screen_events_capture_ts_idx
  ON screen_events(capture_session_id, ts_ms);
CREATE INDEX IF NOT EXISTS screen_events_org_id_idx ON screen_events(org_id);
CREATE INDEX IF NOT EXISTS screen_events_workspace_id_idx ON screen_events(workspace_id);
CREATE INDEX IF NOT EXISTS screen_events_screenshot_artifact_id_idx
  ON screen_events(screenshot_artifact_id);

CREATE TABLE IF NOT EXISTS provisional_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  process_id uuid REFERENCES processes(id),
  ts_start_ms integer NOT NULL,
  ts_end_ms integer,
  ordinal_hint integer,
  action_verb text,
  action_object text,
  system_id_set uuid[] NOT NULL DEFAULT '{}',
  candidate_role_id uuid REFERENCES roles(id),
  source text NOT NULL CHECK (source IN ('live_segmenter', 'operator_tool', 'video_segmenter')),
  source_event_id text,
  idempotency_key text,
  superseded_by_node_id uuid REFERENCES process_nodes(id),
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provisional_steps_capture_ts_idx
  ON provisional_steps(capture_session_id, ts_start_ms);
CREATE INDEX IF NOT EXISTS provisional_steps_process_id_idx ON provisional_steps(process_id);
CREATE INDEX IF NOT EXISTS provisional_steps_org_id_idx ON provisional_steps(org_id);
CREATE INDEX IF NOT EXISTS provisional_steps_workspace_id_idx ON provisional_steps(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS provisional_steps_capture_idempotency_idx
  ON provisional_steps(capture_session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE slot_states
  ADD COLUMN IF NOT EXISTS provisional_step_id uuid REFERENCES provisional_steps(id);

DROP INDEX IF EXISTS slot_states_capture_global_slot_idx;
CREATE UNIQUE INDEX IF NOT EXISTS slot_states_capture_global_slot_idx
  ON slot_states(capture_session_id, slot_path)
  WHERE candidate_process_id IS NULL
    AND provisional_step_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS slot_states_capture_provisional_step_slot_idx
  ON slot_states(capture_session_id, provisional_step_id, slot_path)
  WHERE provisional_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS slot_states_provisional_step_id_idx
  ON slot_states(provisional_step_id)
  WHERE provisional_step_id IS NOT NULL;

ALTER TABLE screen_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisional_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE screen_events FORCE ROW LEVEL SECURITY;
ALTER TABLE provisional_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_screen_events ON screen_events;
CREATE POLICY org_isolation_screen_events ON screen_events
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DROP POLICY IF EXISTS org_isolation_provisional_steps ON provisional_steps;
CREATE POLICY org_isolation_provisional_steps ON provisional_steps
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
