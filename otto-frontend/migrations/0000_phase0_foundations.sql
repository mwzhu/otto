CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TYPE org_role AS ENUM ('org_admin', 'fde');
CREATE TYPE workspace_role AS ENUM ('director', 'operator', 'viewer');
CREATE TYPE workspace_status AS ENUM ('active', 'archived');
CREATE TYPE process_status AS ENUM ('candidate', 'draft', 'approved', 'archived');
CREATE TYPE process_version_status AS ENUM ('draft', 'approved', 'rejected');
CREATE TYPE claim_status AS ENUM ('active', 'superseded', 'redacted', 'tombstoned');
CREATE TYPE evidence_label AS ENUM (
  'observed',
  'stated_operator',
  'stated_director',
  'documented',
  'inferred',
  'confirmed',
  'corrected'
);
CREATE TYPE evidence_source_type AS ENUM (
  'transcript_segment',
  'screen_event',
  'document_chunk',
  'user_correction',
  'agent_inference'
);
CREATE TYPE capture_type AS ENUM (
  'director_interview',
  'operator_interview',
  'screen_recording_upload',
  'document_upload',
  'mixed'
);
CREATE TYPE artifact_status AS ENUM (
  'pending_upload',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'redacted'
);
CREATE TYPE artifact_type AS ENUM (
  'document',
  'audio',
  'video',
  'screen_frame',
  'image',
  'other'
);
CREATE TYPE ontology_term_type AS ENUM (
  'role',
  'system',
  'process',
  'metric',
  'custom'
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workos_user_id text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  org_role org_role,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX users_org_id_idx ON users(org_id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  function_name text NOT NULL,
  status workspace_status NOT NULL DEFAULT 'active',
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_org_id_idx ON workspaces(org_id);

CREATE TABLE workspace_memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_role workspace_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_org_id_idx ON workspace_memberships(org_id);
CREATE INDEX workspace_memberships_user_id_idx ON workspace_memberships(user_id);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  description text,
  canonical_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roles_org_id_idx ON roles(org_id);

CREATE TABLE processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  description text,
  status process_status NOT NULL DEFAULT 'draft',
  owner_role_id uuid REFERENCES roles(id),
  current_draft_version_id uuid,
  current_approved_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processes_org_id_idx ON processes(org_id);
CREATE INDEX processes_workspace_id_idx ON processes(workspace_id);

CREATE TABLE process_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_number integer NOT NULL,
  status process_version_status NOT NULL DEFAULT 'draft',
  summary text,
  graph_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by_user_id uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (process_id, version_number)
);
CREATE INDEX process_versions_org_id_idx ON process_versions(org_id);
CREATE INDEX process_versions_process_id_idx ON process_versions(process_id);

ALTER TABLE processes
  ADD CONSTRAINT processes_current_draft_version_fk
  FOREIGN KEY (current_draft_version_id) REFERENCES process_versions(id);
ALTER TABLE processes
  ADD CONSTRAINT processes_current_approved_version_fk
  FOREIGN KEY (current_approved_version_id) REFERENCES process_versions(id);

CREATE TABLE capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid REFERENCES processes(id),
  participant_person_id uuid,
  capture_type capture_type NOT NULL,
  frame_egress_dir text,
  recording_url text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capture_sessions_org_id_idx ON capture_sessions(org_id);
CREATE INDEX capture_sessions_workspace_id_idx ON capture_sessions(workspace_id);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid REFERENCES capture_sessions(id),
  uploaded_by_user_id uuid REFERENCES users(id),
  artifact_type artifact_type NOT NULL,
  status artifact_status NOT NULL DEFAULT 'pending_upload',
  storage_key text NOT NULL,
  storage_url text,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer,
  duration_seconds integer,
  ttl_at timestamptz,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_org_id_idx ON artifacts(org_id);
CREATE INDEX artifacts_workspace_id_idx ON artifacts(workspace_id);

CREATE TABLE transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id),
  speaker text NOT NULL,
  speaker_role text,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  text text NOT NULL,
  embedding vector(1536),
  confidence numeric(4,3),
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_segments_org_id_idx ON transcript_segments(org_id);
CREATE INDEX transcript_segments_capture_session_id_idx ON transcript_segments(capture_session_id);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  ordinal integer NOT NULL,
  text text NOT NULL,
  embedding vector(1536),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_chunks_org_id_idx ON document_chunks(org_id);
CREATE INDEX document_chunks_artifact_id_idx ON document_chunks(artifact_id);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_type evidence_source_type NOT NULL,
  source_id uuid,
  evidence_label evidence_label NOT NULL,
  span_start integer,
  span_end integer,
  quote text,
  summary text,
  observed_at timestamptz,
  confidence numeric(4,3) NOT NULL DEFAULT 1,
  redacted_at timestamptz,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_org_id_idx ON evidence(org_id);
CREATE INDEX evidence_workspace_id_idx ON evidence(workspace_id);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  field text NOT NULL,
  value jsonb NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 1,
  status claim_status NOT NULL DEFAULT 'active',
  superseded_by_claim_id uuid,
  redacted_at timestamptz,
  tombstoned_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_org_id_idx ON claims(org_id);
CREATE INDEX claims_workspace_id_idx ON claims(workspace_id);
CREATE INDEX claims_subject_field_idx ON claims(subject_type, subject_id, field);
CREATE UNIQUE INDEX claims_active_subject_field_idx
  ON claims(subject_type, subject_id, field)
  WHERE status = 'active' AND superseded_by_claim_id IS NULL;
ALTER TABLE claims
  ADD CONSTRAINT claims_superseded_by_claim_id_fkey
  FOREIGN KEY (superseded_by_claim_id)
  REFERENCES claims(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE claim_evidence (
  claim_id uuid NOT NULL REFERENCES claims(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, evidence_id)
);
CREATE INDEX claim_evidence_evidence_id_idx ON claim_evidence(evidence_id);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid REFERENCES workspaces(id),
  user_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_id_idx ON audit_log(org_id);
CREATE INDEX audit_log_workspace_id_idx ON audit_log(workspace_id);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response_json jsonb,
  status_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (org_id, key, route)
);

CREATE TABLE systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  type text,
  description text,
  integration_status text,
  canonical_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX systems_org_id_idx ON systems(org_id);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  title text,
  department text,
  manager_id uuid,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_org_id_idx ON people(org_id);

CREATE TABLE ontology_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  term text NOT NULL,
  type ontology_term_type NOT NULL,
  definition text,
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_evidence_ids uuid[],
  confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ontology_terms_org_id_idx ON ontology_terms(org_id);

CREATE OR REPLACE FUNCTION app_current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE ontology_terms ENABLE ROW LEVEL SECURITY;

ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE processes FORCE ROW LEVEL SECURITY;
ALTER TABLE process_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments FORCE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE systems FORCE ROW LEVEL SECURITY;
ALTER TABLE people FORCE ROW LEVEL SECURITY;
ALTER TABLE ontology_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation_organizations ON organizations
  USING (id = app_current_org_id())
  WITH CHECK (id = app_current_org_id());

CREATE POLICY org_isolation_users ON users
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_workspaces ON workspaces
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_workspace_memberships ON workspace_memberships
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_roles ON roles
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_processes ON processes
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_process_versions ON process_versions
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_capture_sessions ON capture_sessions
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_artifacts ON artifacts
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_transcript_segments ON transcript_segments
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_document_chunks ON document_chunks
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_evidence ON evidence
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_claims ON claims
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_audit_log ON audit_log
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_idempotency_keys ON idempotency_keys
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_systems ON systems
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_people ON people
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
CREATE POLICY org_isolation_ontology_terms ON ontology_terms
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

CREATE POLICY claim_evidence_org_isolation ON claim_evidence
  USING (
    EXISTS (
      SELECT 1 FROM claims
      WHERE claims.id = claim_evidence.claim_id
        AND claims.org_id = app_current_org_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM claims
      WHERE claims.id = claim_evidence.claim_id
        AND claims.org_id = app_current_org_id()
    )
  );
