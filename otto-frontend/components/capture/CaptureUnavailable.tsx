import Link from "next/link";
import { Button } from "@/components/ui/Button";

export function CaptureUnavailable({
  processId,
  processName,
  status,
}: {
  processId: string;
  processName: string;
  status?: string | null;
}) {
  return (
    <main className="flex-1 px-8 py-10">
      <section className="mx-auto max-w-[620px] rounded-lg border border-subtle bg-surface px-8 py-8 text-center shadow-card">
        <div className="mx-auto inline-flex rounded-full bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          Capture unavailable
        </div>
        <h1 className="mt-4 text-[20px] font-semibold tracking-tight text-ink">
          Promote {processName} before operator capture
        </h1>
        <p className="mx-auto mt-3 max-w-[500px] text-[13px] leading-relaxed text-ink-secondary">
          Operator capture can only be added to draft or approved process
          records. This process is currently{" "}
          <span className="font-mono text-ink">{status ?? "unknown"}</span>.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href={`/process/${processId}`}>
            <Button variant="secondary">Review Process</Button>
          </Link>
          <Link href="/overview">
            <Button>Go to Overview</Button>
          </Link>
        </div>
      </section>
    </main>
  );
}
