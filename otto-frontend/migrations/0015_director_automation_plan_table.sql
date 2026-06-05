CREATE TABLE IF NOT EXISTS director_automation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  synthesis_run_id uuid REFERENCES synthesis_runs(id),
  source_capture_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  inventory_hash text NOT NULL,
  plan_input_hash text NOT NULL,
  plan_hash text NOT NULL,
  prompt_template_id text NOT NULL,
  prompt_template_version text NOT NULL,
  model text NOT NULL,
  llm_request_hash text,
  llm_response_hash text,
  generator text NOT NULL,
  generator_version integer NOT NULL DEFAULT 1,
  plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS director_automation_plans_org_id_idx
  ON director_automation_plans(org_id);

CREATE INDEX IF NOT EXISTS director_automation_plans_workspace_created_idx
  ON director_automation_plans(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS director_automation_plans_capture_session_ids_idx
  ON director_automation_plans USING gin(source_capture_session_ids);

CREATE UNIQUE INDEX IF NOT EXISTS director_automation_plans_workspace_input_hash_idx
  ON director_automation_plans(workspace_id, plan_input_hash);

ALTER TABLE director_automation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE director_automation_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_director_automation_plans ON director_automation_plans;
CREATE POLICY org_isolation_director_automation_plans ON director_automation_plans
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
