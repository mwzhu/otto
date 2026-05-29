CREATE TABLE IF NOT EXISTS director_extraction_windows (
  extraction_window_id text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  turn_index integer,
  transcript_segment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  status text NOT NULL DEFAULT 'pending',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS director_extraction_windows_org_id_idx
  ON director_extraction_windows(org_id);

CREATE INDEX IF NOT EXISTS director_extraction_windows_capture_session_id_idx
  ON director_extraction_windows(capture_session_id);

CREATE INDEX IF NOT EXISTS director_extraction_windows_capture_turn_idx
  ON director_extraction_windows(capture_session_id, turn_index);
