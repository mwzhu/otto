CREATE TABLE IF NOT EXISTS automation_opportunity_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  synthesis_run_id uuid REFERENCES synthesis_runs(id),
  evidence_pack_hash text NOT NULL,
  opportunity_set_hash text NOT NULL,
  prompt_template_id text NOT NULL,
  prompt_template_version text NOT NULL,
  model text NOT NULL,
  llm_request_hash text,
  llm_response_hash text,
  generator text NOT NULL,
  generator_version integer NOT NULL DEFAULT 1,
  opportunities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_opportunity_sets_org_id_idx
  ON automation_opportunity_sets(org_id);
CREATE INDEX IF NOT EXISTS automation_opportunity_sets_version_idx
  ON automation_opportunity_sets(version_id);
CREATE UNIQUE INDEX IF NOT EXISTS automation_opportunity_sets_version_pack_idx
  ON automation_opportunity_sets(version_id, evidence_pack_hash);

CREATE TABLE IF NOT EXISTS opportunity_assumption_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  opportunity_set_key text NOT NULL,
  opportunity_id text NOT NULL,
  assumptions_json jsonb NOT NULL,
  edited_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS opportunity_override_set_opp_idx
  ON opportunity_assumption_overrides(version_id, opportunity_set_key, opportunity_id);

CREATE TABLE IF NOT EXISTS workspace_roi_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  loaded_hourly_cost numeric(10, 2) NOT NULL,
  cost_per_error numeric(10, 2) NOT NULL,
  delay_cost numeric(10, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  edited_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_roi_prices_workspace_idx
  ON workspace_roi_prices(workspace_id);

INSERT INTO workspace_roi_prices (
  org_id,
  workspace_id,
  loaded_hourly_cost,
  cost_per_error,
  delay_cost,
  currency
)
SELECT
  org_id,
  id,
  65,
  90,
  35,
  'USD'
FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE automation_opportunity_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_opportunity_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE opportunity_assumption_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_assumption_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_roi_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_roi_prices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_automation_opportunity_sets ON automation_opportunity_sets;
CREATE POLICY org_isolation_automation_opportunity_sets ON automation_opportunity_sets
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DROP POLICY IF EXISTS org_isolation_opportunity_assumption_overrides ON opportunity_assumption_overrides;
CREATE POLICY org_isolation_opportunity_assumption_overrides ON opportunity_assumption_overrides
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DROP POLICY IF EXISTS org_isolation_workspace_roi_prices ON workspace_roi_prices;
CREATE POLICY org_isolation_workspace_roi_prices ON workspace_roi_prices
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
