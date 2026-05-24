"use client";

export function SummaryTab({ processId }: { processId: string }) {
  return (
    <div className="px-5 py-5 text-[13px] leading-relaxed text-ink-secondary">
      Real process summary for <span className="font-mono">{processId}</span>{" "}
      is available on the process detail page. This workspace tab only renders
      evidence-backed content when that content exists in the database.
    </div>
  );
}
