CREATE TABLE IF NOT EXISTS workflow_semantic_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid REFERENCES process_versions(id),
  synthesis_run_id uuid REFERENCES synthesis_runs(id),
  capture_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  evidence_pack_hash text NOT NULL,
  semantic_model_hash text NOT NULL,
  prompt_template_id text NOT NULL,
  prompt_template_version text NOT NULL,
  model text NOT NULL,
  llm_request_hash text,
  llm_response_hash text,
  source_process_version_id uuid REFERENCES process_versions(id),
  cache_status text NOT NULL,
  raw_model_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_model_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  grounding_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verifier_confidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_semantic_models_org_process_pack_hash_idx
  ON workflow_semantic_models(org_id, workspace_id, process_id, evidence_pack_hash);
CREATE INDEX IF NOT EXISTS workflow_semantic_models_process_id_idx
  ON workflow_semantic_models(process_id);
CREATE INDEX IF NOT EXISTS workflow_semantic_models_synthesis_run_id_idx
  ON workflow_semantic_models(synthesis_run_id);

ALTER TABLE workflow_semantic_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_semantic_models FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_workflow_semantic_models ON workflow_semantic_models;
CREATE POLICY org_isolation_workflow_semantic_models ON workflow_semantic_models
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
