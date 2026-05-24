CREATE TYPE slot_state_status AS ENUM (
  'empty',
  'partial',
  'filled',
  'asked_unknown',
  'conflicting',
  'pending_re_extract'
);

CREATE TYPE candidate_process_status AS ENUM (
  'pending',
  'promoted',
  'discarded',
  'merged'
);

CREATE TYPE capture_link_type AS ENUM (
  'created',
  'enriched',
  'corrected',
  'candidate'
);

CREATE TYPE follow_up_task_type AS ENUM (
  'open_question',
  'conflicting_slot',
  'low_confidence_claim',
  'failed_stage',
  'weak_merge',
  'redaction_failure'
);

CREATE TYPE follow_up_task_status AS ENUM (
  'open',
  'in_progress',
  'resolved',
  'dismissed'
);

CREATE TYPE synthesis_run_status AS ENUM (
  'queued',
  'running',
  'partial_synthesis',
  'completed',
  'failed'
);

CREATE TYPE synthesis_run_type AS ENUM (
  'document_inventory',
  'director_inventory',
  'combined_inventory'
);

CREATE TYPE synthesis_stage_status AS ENUM (
  'queued',
  'running',
  'completed',
  'skipped',
  'failed'
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS data_tier text NOT NULL DEFAULT 'trial';

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_artifact_ordinal_idx
  ON document_chunks(artifact_id, ordinal);

DROP INDEX IF EXISTS claims_active_subject_field_idx;
CREATE UNIQUE INDEX claims_active_subject_field_idx
  ON claims(subject_type, subject_id, field)
  WHERE status = 'active'
    AND superseded_by_claim_id IS NULL
    AND field NOT IN (
      'pain_point',
      'risk',
      'kpi',
      'upstream_dependency',
      'downstream_dependency',
      'used_in_process',
      'participates_in_process',
      'handoff_target'
    );

CREATE TABLE slot_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  slot_path text NOT NULL,
  value jsonb,
  status slot_state_status NOT NULL DEFAULT 'empty',
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  last_asked_at timestamptz,
  priority integer NOT NULL DEFAULT 0,
  candidates jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_session_id, slot_path)
);
CREATE INDEX slot_states_org_id_idx ON slot_states(org_id);
CREATE INDEX slot_states_workspace_id_idx ON slot_states(workspace_id);
CREATE INDEX slot_states_capture_session_id_idx ON slot_states(capture_session_id);
CREATE INDEX slot_states_capture_status_priority_idx
  ON slot_states(capture_session_id, status, priority DESC);

CREATE TABLE candidate_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  proposed_name text NOT NULL,
  proposed_function text,
  proposed_owner_role_id uuid REFERENCES roles(id),
  frequency text,
  complexity_hint text,
  status candidate_process_status NOT NULL DEFAULT 'pending',
  promoted_process_id uuid REFERENCES processes(id),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_processes_org_id_idx ON candidate_processes(org_id);
CREATE INDEX candidate_processes_workspace_status_idx
  ON candidate_processes(workspace_id, status);
CREATE INDEX candidate_processes_capture_session_id_idx
  ON candidate_processes(capture_session_id);

CREATE TABLE capture_process_links (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  link_type capture_link_type NOT NULL,
  confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_session_id, process_id, link_type)
);
CREATE INDEX capture_process_links_org_id_idx ON capture_process_links(org_id);
CREATE INDEX capture_process_links_workspace_id_idx ON capture_process_links(workspace_id);
CREATE INDEX capture_process_links_process_id_idx ON capture_process_links(process_id);

CREATE TABLE follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid REFERENCES workspaces(id),
  process_id uuid REFERENCES processes(id),
  capture_session_id uuid REFERENCES capture_sessions(id),
  task_type follow_up_task_type NOT NULL,
  title text NOT NULL,
  description text,
  target_type text,
  target_id uuid,
  priority numeric(6,3) NOT NULL DEFAULT 1.0,
  status follow_up_task_status NOT NULL DEFAULT 'open',
  assigned_to_user_id uuid REFERENCES users(id),
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX follow_up_tasks_org_id_idx ON follow_up_tasks(org_id);
CREATE INDEX follow_up_tasks_workspace_status_priority_idx
  ON follow_up_tasks(workspace_id, status, priority DESC);
CREATE INDEX follow_up_tasks_capture_session_id_idx ON follow_up_tasks(capture_session_id);

CREATE TABLE synthesis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_ids uuid[] NOT NULL DEFAULT '{}',
  run_type synthesis_run_type NOT NULL,
  status synthesis_run_status NOT NULL DEFAULT 'queued',
  stage text,
  stage_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX synthesis_runs_org_id_idx ON synthesis_runs(org_id);
CREATE INDEX synthesis_runs_workspace_status_idx ON synthesis_runs(workspace_id, status);

CREATE TABLE synthesis_stage_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  synthesis_run_id uuid NOT NULL REFERENCES synthesis_runs(id),
  stage_name text NOT NULL,
  input_row_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_row_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status synthesis_stage_status NOT NULL DEFAULT 'queued',
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX synthesis_stage_outputs_org_id_idx ON synthesis_stage_outputs(org_id);
CREATE INDEX synthesis_stage_outputs_run_stage_idx
  ON synthesis_stage_outputs(synthesis_run_id, stage_name);

CREATE TABLE agent_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid REFERENCES workspaces(id),
  capture_session_id uuid REFERENCES capture_sessions(id),
  synthesis_run_id uuid REFERENCES synthesis_runs(id),
  turn_index integer,
  stage_name text,
  ts_start timestamptz NOT NULL,
  ts_end timestamptz,
  transcript_segment_ids uuid[] NOT NULL DEFAULT '{}',
  slot_updates jsonb,
  ranked_probe_intents jsonb,
  chosen_intent jsonb,
  sanitized_agent_utterance text,
  prompt_template_id text,
  prompt_template_version text,
  tool_calls jsonb,
  model text,
  token_count_input integer,
  token_count_output integer,
  cost_cents numeric(10,3),
  latency_ms integer,
  cache_hit boolean,
  degraded_quality boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_decision_log_org_created_idx ON agent_decision_log(org_id, created_at DESC);
CREATE INDEX agent_decision_log_capture_ts_idx ON agent_decision_log(capture_session_id, ts_start);
CREATE INDEX agent_decision_log_synthesis_stage_idx ON agent_decision_log(synthesis_run_id, stage_name);

CREATE TABLE process_systems (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  system_id uuid NOT NULL REFERENCES systems(id),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (process_id, system_id)
);
CREATE INDEX process_systems_org_id_idx ON process_systems(org_id);
CREATE INDEX process_systems_workspace_id_idx ON process_systems(workspace_id);
CREATE INDEX process_systems_system_id_idx ON process_systems(system_id);

CREATE TABLE process_roles (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (process_id, role_id)
);
CREATE INDEX process_roles_org_id_idx ON process_roles(org_id);
CREATE INDEX process_roles_workspace_id_idx ON process_roles(workspace_id);
CREATE INDEX process_roles_role_id_idx ON process_roles(role_id);

CREATE TABLE process_people (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  person_id uuid NOT NULL REFERENCES people(id),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (process_id, person_id)
);
CREATE INDEX process_people_org_id_idx ON process_people(org_id);
CREATE INDEX process_people_workspace_id_idx ON process_people(workspace_id);
CREATE INDEX process_people_person_id_idx ON process_people(person_id);

ALTER TABLE slot_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_process_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_stage_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_decision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_people ENABLE ROW LEVEL SECURITY;

ALTER TABLE slot_states FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_processes FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_process_links FORCE ROW LEVEL SECURITY;
ALTER TABLE follow_up_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE synthesis_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE synthesis_stage_outputs FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_decision_log FORCE ROW LEVEL SECURITY;
ALTER TABLE process_systems FORCE ROW LEVEL SECURITY;
ALTER TABLE process_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE process_people FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation_slot_states ON slot_states
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_candidate_processes ON candidate_processes
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_capture_process_links ON capture_process_links
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_follow_up_tasks ON follow_up_tasks
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_synthesis_runs ON synthesis_runs
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_synthesis_stage_outputs ON synthesis_stage_outputs
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_agent_decision_log ON agent_decision_log
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_process_systems ON process_systems
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_process_roles ON process_roles
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_process_people ON process_people
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
