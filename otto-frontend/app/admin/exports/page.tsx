import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { listExportableProcessVersions } from "@/lib/admin/export-queries";
import { getCurrentWorkspace } from "@/lib/workspaces/current";

const FORMATS = [
  {
    id: "json",
    label: "JSON (full schema)",
    description: "Graph + claims + evidence + opportunities. Source of truth dump.",
  },
];

const PLANNED_FORMATS = [
  {
    id: "pdf",
    label: "PDF — Executive Report",
    description:
      "Director-facing artifact with map, narrative, ROI ranking, and assumptions.",
  },
  {
    id: "bpmn",
    label: "BPMN 2.0 XML",
    description:
      "Standards-compliant process model for import into Camunda / Signavio / Lucidchart.",
  },
  {
    id: "pptx",
    label: "PPTX deck",
    description: "Slide-ready summary, current-vs-proposed, and opportunity stack.",
  },
];

export default async function ExportsPage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const versions = workspace
    ? await listExportableProcessVersions(auth.orgId, workspace.id)
    : [];
  const workspaceId = workspace?.id ?? "";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Exports
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Download parseable artifacts from versioned process maps. PII
          redactions are applied automatically.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">
            Available JSON exports
          </h2>
          {workspace ? <Pill tone="neutral">{workspace.name}</Pill> : null}
        </div>
        <div className="space-y-2">
          {versions.map((version) => (
            <Card
              key={version.versionId}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                    {version.processName}
                  </h3>
                  <Pill tone={version.versionStatus === "approved" ? "success" : "draft"}>
                    v{version.versionNumber} {version.versionStatus}
                  </Pill>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                  {version.summary ?? "No version summary captured."}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Pill tone="neutral">{version.nodeCount} graph nodes</Pill>
                  <Pill tone={version.evidenceCount > 0 ? "success" : "warn"}>
                    {version.evidenceCount} evidence rows
                  </Pill>
                </div>
              </div>
              <Link
                href={`/api/admin/exports/process-json?workspace_id=${workspaceId}&process_id=${version.processId}&version_id=${version.versionId}`}
                className="shrink-0"
              >
                <Button size="sm">Download JSON</Button>
              </Link>
            </Card>
          ))}
          {versions.length === 0 && (
            <Card className="p-5 text-[13px] text-ink-secondary">
              Publish a process map before exporting. Export controls only appear
              after a versioned graph exists in the active workspace.
            </Card>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        {FORMATS.map((f) => (
          <div
            key={f.id}
            className="rounded-lg border border-subtle bg-surface p-5"
          >
            <div className="text-[14px] font-semibold tracking-tight text-ink">
              {f.label}
            </div>
            <p className="mt-1.5 text-[12.5px] text-ink-secondary">
              {f.description}
            </p>
            <Pill tone="success" className="mt-4">
              Available
            </Pill>
          </div>
        ))}
        {PLANNED_FORMATS.map((f) => (
          <div
            key={f.id}
            className="rounded-lg border border-subtle bg-surface p-5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[14px] font-semibold tracking-tight text-ink">
                {f.label}
              </div>
              <Pill tone="neutral">Planned</Pill>
            </div>
            <p className="mt-1.5 text-[12.5px] text-ink-secondary">
              {f.description}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
