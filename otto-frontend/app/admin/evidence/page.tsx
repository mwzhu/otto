import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getEvidenceInventory } from "@/lib/admin/evidence-queries";

export default async function EvidencePage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const rows = workspace
    ? await getEvidenceInventory(auth.orgId, workspace.id)
    : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Evidence inventory
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Every evidence row collected from interviews, screen events,
          documents, and corrections. Searchable across processes.
        </p>
      </header>

      <div className="overflow-hidden rounded-lg border border-subtle bg-surface">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-muted text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="px-3 py-2.5">Label</th>
              <th className="px-3 py-2.5">Source</th>
              <th className="px-3 py-2.5">Evidence</th>
              <th className="px-3 py-2.5">Observed</th>
              <th className="px-3 py-2.5">Conf.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-subtle">
            {rows.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="px-3 py-3">
                  <Pill tone={toneForLabel(e.evidenceLabel)}>
                    {e.evidenceLabel.replace(/_/g, " ")}
                  </Pill>
                </td>
                <td className="px-3 py-3 text-ink-secondary">
                  {e.sourceType.replace(/_/g, " ")}
                </td>
                <td className="px-3 py-3 text-ink">
                  {e.quote ? `"${e.quote}"` : (e.summary ?? "No evidence text captured.")}
                </td>
                <td className="px-3 py-3 font-mono text-[11px] tabular-nums text-ink-muted">
                  {(e.observedAt ?? new Date()).toLocaleDateString()}
                </td>
                <td className="px-3 py-3 font-mono text-[11px] tabular-nums text-ink">
                  {(Number(e.confidence) * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-ink-muted">
                  No evidence rows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function toneForLabel(label: string) {
  switch (label) {
    case "corrected":
    case "confirmed":
      return "success" as const;
    case "stated_operator":
    case "observed":
      return "role" as const;
    case "documented":
      return "system" as const;
    case "inferred":
      return "warn" as const;
    default:
      return "neutral" as const;
  }
}
