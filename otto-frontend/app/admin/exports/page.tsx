import { Button } from "@/components/ui/Button";

const FORMATS = [
  {
    id: "pdf",
    label: "PDF — Executive Report",
    description: "Director-facing artifact with map, narrative, ROI ranking, and assumptions.",
  },
  {
    id: "bpmn",
    label: "BPMN 2.0 XML",
    description: "Standards-compliant process model for import into Camunda / Signavio / Lucidchart.",
  },
  {
    id: "json",
    label: "JSON (full schema)",
    description: "Graph + claims + evidence + opportunities. Source of truth dump.",
  },
  {
    id: "pptx",
    label: "PPTX deck",
    description: "Slide-ready summary, current-vs-proposed, and opportunity stack.",
  },
];

export default function ExportsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Exports
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Generate executive-ready artifacts from the approved process version.
          PII redactions are applied automatically.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3">
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
            <div className="mt-4 flex items-center gap-2">
              <Button size="sm">Generate</Button>
              <Button variant="secondary" size="sm">
                Preview
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
