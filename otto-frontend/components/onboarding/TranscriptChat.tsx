"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { BRAND } from "@/lib/brand";

export function TranscriptChat({ nextHref }: { nextHref: string }) {
  const router = useRouter();

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col">
      <div className="rounded-lg border border-subtle bg-surface shadow-card">
        <div className="px-6 py-12 text-center">
          <div className="mx-auto grid size-10 place-items-center rounded-full bg-muted text-[13px] font-semibold text-ink">
            {BRAND.name.slice(0, 1)}
          </div>
          <h2 className="mt-4 text-[15px] font-semibold tracking-tight text-ink">
            Live interview capture is ready for real input
          </h2>
          <p className="mx-auto mt-2 max-w-[440px] text-[12.5px] leading-relaxed text-ink-secondary">
            Start a real interview session or upload a document to create
            evidence-backed inventory.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-subtle px-4 py-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              router.push(`/synthesis?next=${encodeURIComponent(nextHref)}`)
            }
          >
            Finish
          </Button>
        </div>
      </div>
    </div>
  );
}
