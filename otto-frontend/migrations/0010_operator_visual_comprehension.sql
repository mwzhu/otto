ALTER TYPE evidence_label ADD VALUE IF NOT EXISTS 'preview';

ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS recording_artifact_id uuid REFERENCES artifacts(id),
  ADD COLUMN IF NOT EXISTS recording_status text,
  ADD COLUMN IF NOT EXISTS recording_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_provider text;

CREATE TABLE IF NOT EXISTS visual_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  screen_event_id uuid REFERENCES screen_events(id),
  artifact_id uuid REFERENCES artifacts(id),
  ts_ms integer NOT NULL,
  provider text NOT NULL,
  ocr_text text,
  ui_summary text,
  structured_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  degraded_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  model text NOT NULL,
  prompt_template_id text,
  prompt_template_version text,
  idempotency_key text NOT NULL,
  emits_evidence boolean NOT NULL DEFAULT true,
  evidence_id uuid REFERENCES evidence(id),
  redacted_at timestamptz,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visual_observations_evidence_link_check
    CHECK (emits_evidence = false OR evidence_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS visual_observations_capture_ts_idx
  ON visual_observations(capture_session_id, ts_ms);
CREATE INDEX IF NOT EXISTS visual_observations_screen_event_id_idx
  ON visual_observations(screen_event_id);
CREATE INDEX IF NOT EXISTS visual_observations_artifact_id_idx
  ON visual_observations(artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS visual_observations_retry_guard_idx
  ON visual_observations(org_id, screen_event_id, provider, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS visual_observations_evidence_id_idx
  ON visual_observations(evidence_id)
  WHERE evidence_id IS NOT NULL;

ALTER TABLE visual_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_observations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_visual_observations ON visual_observations;
CREATE POLICY org_isolation_visual_observations ON visual_observations
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
