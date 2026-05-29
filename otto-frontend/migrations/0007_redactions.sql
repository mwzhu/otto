CREATE TABLE IF NOT EXISTS redactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  requested_by_user_id uuid REFERENCES users(id),
  reason text,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  failure_reason text,
  affected_artifact_ids uuid[] NOT NULL DEFAULT '{}',
  affected_trace_ids uuid[] NOT NULL DEFAULT '{}',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redactions_org_id_idx ON redactions(org_id);
CREATE INDEX IF NOT EXISTS redactions_workspace_id_idx ON redactions(workspace_id);
CREATE INDEX IF NOT EXISTS redactions_capture_session_id_idx ON redactions(capture_session_id);
CREATE INDEX IF NOT EXISTS redactions_capture_status_idx
  ON redactions(capture_session_id, status);

ALTER TABLE redactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE redactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_redactions ON redactions;
CREATE POLICY org_isolation_redactions ON redactions
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
