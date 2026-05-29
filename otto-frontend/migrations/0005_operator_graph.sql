DO $$ BEGIN
  CREATE TYPE process_node_type AS ENUM (
    'start',
    'task',
    'decision',
    'wait',
    'handoff',
    'exception',
    'end'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE process_edge_type AS ENUM (
    'seq',
    'conditional',
    'handoff',
    'parallel'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE process_node_level AS ENUM ('L3', 'L4');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE synthesis_run_type ADD VALUE IF NOT EXISTS 'process_graph';

CREATE TABLE IF NOT EXISTS process_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  parent_node_id uuid REFERENCES process_nodes(id),
  ordinal integer NOT NULL,
  level process_node_level NOT NULL DEFAULT 'L4',
  node_type process_node_type NOT NULL,
  title text NOT NULL,
  description text,
  lane_role_id uuid REFERENCES roles(id),
  owner_role_id uuid REFERENCES roles(id),
  owner_person_id uuid REFERENCES people(id),
  sla_seconds integer,
  frequency text,
  est_minutes_per_run numeric(10,2),
  automation_candidate boolean NOT NULL DEFAULT false,
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  position_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_count integer NOT NULL DEFAULT 0,
  top_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS process_nodes_org_id_idx ON process_nodes(org_id);
CREATE INDEX IF NOT EXISTS process_nodes_workspace_process_idx
  ON process_nodes(workspace_id, process_id);
CREATE INDEX IF NOT EXISTS process_nodes_version_ordinal_idx
  ON process_nodes(version_id, ordinal);
CREATE INDEX IF NOT EXISTS process_nodes_parent_node_id_idx
  ON process_nodes(parent_node_id);

CREATE TABLE IF NOT EXISTS process_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  source_node_id uuid NOT NULL REFERENCES process_nodes(id),
  target_node_id uuid NOT NULL REFERENCES process_nodes(id),
  edge_type process_edge_type NOT NULL,
  label text,
  condition text,
  probability numeric(5,4),
  is_exception_path boolean NOT NULL DEFAULT false,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_count integer NOT NULL DEFAULT 0,
  top_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS process_edges_version_id_idx
  ON process_edges(version_id);
CREATE INDEX IF NOT EXISTS process_edges_source_node_id_idx
  ON process_edges(source_node_id);
CREATE INDEX IF NOT EXISTS process_edges_target_node_id_idx
  ON process_edges(target_node_id);
CREATE INDEX IF NOT EXISTS process_edges_org_id_idx ON process_edges(org_id);
CREATE INDEX IF NOT EXISTS process_edges_workspace_process_idx
  ON process_edges(workspace_id, process_id);

CREATE TABLE IF NOT EXISTS node_systems (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  node_id uuid NOT NULL REFERENCES process_nodes(id),
  system_id uuid NOT NULL REFERENCES systems(id),
  usage text NOT NULL CHECK (usage IN ('read', 'write', 'both', 'unknown')),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, system_id, usage)
);
CREATE INDEX IF NOT EXISTS node_systems_org_id_idx ON node_systems(org_id);
CREATE INDEX IF NOT EXISTS node_systems_workspace_id_idx ON node_systems(workspace_id);
CREATE INDEX IF NOT EXISTS node_systems_system_id_idx ON node_systems(system_id);

CREATE TABLE IF NOT EXISTS node_io (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  node_id uuid NOT NULL REFERENCES process_nodes(id),
  kind text NOT NULL CHECK (kind IN ('input', 'output', 'artifact')),
  name text NOT NULL,
  description text,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS node_io_org_id_idx ON node_io(org_id);
CREATE INDEX IF NOT EXISTS node_io_workspace_id_idx ON node_io(workspace_id);
CREATE INDEX IF NOT EXISTS node_io_node_id_idx ON node_io(node_id);

CREATE TABLE IF NOT EXISTS exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  node_id uuid NOT NULL REFERENCES process_nodes(id),
  sub_type text NOT NULL,
  label text NOT NULL,
  trigger text,
  detection text,
  handler_role_id uuid REFERENCES roles(id),
  frequency_pct numeric(5,2),
  time_to_resolve_seconds integer,
  impact_cents integer,
  evidence_count integer NOT NULL DEFAULT 0,
  top_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exceptions_org_id_idx ON exceptions(org_id);
CREATE INDEX IF NOT EXISTS exceptions_version_id_idx ON exceptions(version_id);
CREATE INDEX IF NOT EXISTS exceptions_node_id_idx ON exceptions(node_id);

CREATE TABLE IF NOT EXISTS workarounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  node_id uuid NOT NULL REFERENCES process_nodes(id),
  description text NOT NULL,
  why_it_exists text,
  evidence_count integer NOT NULL DEFAULT 0,
  top_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workarounds_org_id_idx ON workarounds(org_id);
CREATE INDEX IF NOT EXISTS workarounds_version_id_idx ON workarounds(version_id);
CREATE INDEX IF NOT EXISTS workarounds_node_id_idx ON workarounds(node_id);

CREATE TABLE IF NOT EXISTS variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  process_id uuid NOT NULL REFERENCES processes(id),
  version_id uuid NOT NULL REFERENCES process_versions(id),
  node_id uuid NOT NULL REFERENCES process_nodes(id),
  condition text NOT NULL,
  alt_node_id uuid REFERENCES process_nodes(id),
  evidence_count integer NOT NULL DEFAULT 0,
  top_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS variants_org_id_idx ON variants(org_id);
CREATE INDEX IF NOT EXISTS variants_version_id_idx ON variants(version_id);
CREATE INDEX IF NOT EXISTS variants_node_id_idx ON variants(node_id);

ALTER TABLE process_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_io ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workarounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;

ALTER TABLE process_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE process_edges FORCE ROW LEVEL SECURITY;
ALTER TABLE node_systems FORCE ROW LEVEL SECURITY;
ALTER TABLE node_io FORCE ROW LEVEL SECURITY;
ALTER TABLE exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE workarounds FORCE ROW LEVEL SECURITY;
ALTER TABLE variants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_process_nodes ON process_nodes;
CREATE POLICY org_isolation_process_nodes ON process_nodes
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_process_edges ON process_edges;
CREATE POLICY org_isolation_process_edges ON process_edges
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_node_systems ON node_systems;
CREATE POLICY org_isolation_node_systems ON node_systems
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_node_io ON node_io;
CREATE POLICY org_isolation_node_io ON node_io
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_exceptions ON exceptions;
CREATE POLICY org_isolation_exceptions ON exceptions
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_workarounds ON workarounds;
CREATE POLICY org_isolation_workarounds ON workarounds
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
DROP POLICY IF EXISTS org_isolation_variants ON variants;
CREATE POLICY org_isolation_variants ON variants
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());
