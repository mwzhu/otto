"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { StatusBadge } from "@/components/common/StatusBadge";
import type { ProcessSummary } from "@/lib/types";
import { Button } from "@/components/ui/Button";

export function ProcessCard({
  p,
  workspaceId,
}: {
  p: ProcessSummary;
  workspaceId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"promote" | "discard" | null>(null);
  const card = (
    <Card interactive={Boolean(p.href)} className="flex h-full flex-col p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-[14.5px] font-semibold leading-snug tracking-tight text-ink">
            {p.name}
          </h3>
          {p.needs_capture ? (
            <Pill tone="neutral">More info needed</Pill>
          ) : (
            <Pill tone={p.complexity}>{complexityLabel(p.complexity)}</Pill>
          )}
        </div>
        <div className="mb-3">
          <StatusBadge status={p.status} />
        </div>
        <p className="line-clamp-3 grow text-[12.5px] leading-relaxed text-ink-secondary">
          {p.description}
        </p>
        {p.needs_capture && (p.missing_slots?.length ?? 0) > 0 && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">
            Not captured yet: {p.missing_slots!.slice(0, 4).join(", ")}
            {p.missing_slots!.length > 4 ? `, +${p.missing_slots!.length - 4} more` : ""}.
            Continue the interview or run a deep-dive to score this process.
          </p>
        )}
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-subtle pt-3 text-[11.5px]">
          <KV k="People" v={p.people_count} />
          <KV k="Systems" v={p.systems.length} />
          <KV k="Frequency" v={p.frequency} />
        </dl>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-[11.5px]">
          <KV k="Evidence" v={p.evidence_count ?? 0} />
          <KV k="Capture coverage" v={`${p.coverage_percent ?? Math.round(p.doc_coverage * 100)}%`} />
        </dl>
        <div className="mt-3 flex flex-wrap gap-1">
          {p.systems.slice(0, 3).map((s) => (
            <Pill key={s} tone="system">
              {s}
            </Pill>
          ))}
          {p.systems.length > 3 && (
            <Pill tone="neutral">+{p.systems.length - 3} more</Pill>
          )}
        </div>
        {p.source === "candidate" ? (
          <div className="mt-4 flex gap-2 self-end">
            <Button
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => mutateCandidate("promote")}
            >
              {busy === "promote" ? "Promoting" : "Promote"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={Boolean(busy)}
              onClick={() => mutateCandidate("discard")}
            >
              Discard
            </Button>
          </div>
        ) : (
          <div className="mt-4 self-end text-[11.5px] font-medium text-ink-secondary">
            View details →
          </div>
        )}
      </Card>
  );

  if (p.href) {
    return (
      <Link href={p.href} className="block">
        {card}
      </Link>
    );
  }
  return card;

  async function mutateCandidate(action: "promote" | "discard") {
    if (!workspaceId) return;
    setBusy(action);
    const response = await fetch(`/api/candidate-processes/${p.id}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${action}:${p.id}:${Date.now()}`,
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    setBusy(null);
    if (!response.ok) return;
    const result = await response.json();
    if (action === "promote" && result.process_id) {
      router.push(`/process/${result.process_id}`);
    } else {
      router.refresh();
    }
  }
}

function complexityLabel(c: ProcessSummary["complexity"]) {
  return c === "high"
    ? "High complexity"
    : c === "med"
      ? "Medium complexity"
      : "Low complexity";
}

function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div>
      <div className="text-ink-muted">{k}</div>
      <div className="font-medium text-ink">{v}</div>
    </div>
  );
}
