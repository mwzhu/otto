-- Round 2 (F3/C1): person works_on claims are multi-value — one person can be
-- linked to several candidate processes, each link its own active claim. The
-- partial unique index on active claims must exclude works_on or the second
-- link violates it (and aborts the whole dispatch transaction).
-- business_outcome was already multi-value in the application layer
-- (write-claim.ts multiValueClaimFields) but missing from the index exclusion
-- — aligned here so the two lists agree.

DROP INDEX IF EXISTS claims_active_subject_field_idx;
CREATE UNIQUE INDEX claims_active_subject_field_idx
  ON claims(subject_type, subject_id, field)
  WHERE status = 'active'
    AND superseded_by_claim_id IS NULL
    AND field NOT IN (
      'pain_point',
      'risk',
      'kpi',
      'business_outcome',
      'upstream_dependency',
      'downstream_dependency',
      'used_in_process',
      'participates_in_process',
      'handoff_target',
      'works_on'
    );
