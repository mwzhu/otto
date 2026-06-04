"use client";

import { useState } from "react";

type PriceKey = "loaded_hourly_cost" | "cost_per_error" | "delay_cost";
type WorkspaceRoiPrices = Record<PriceKey, number> & { currency: string };

const FIELDS: { key: PriceKey; label: string }[] = [
  { key: "loaded_hourly_cost", label: "Loaded hourly cost" },
  { key: "cost_per_error", label: "Cost per error" },
  { key: "delay_cost", label: "Delay cost" },
];

export function WorkspaceRoiPricesPanel({
  workspaceId,
  initialPrices,
  canEdit,
}: {
  workspaceId: string;
  initialPrices: WorkspaceRoiPrices;
  canEdit: boolean;
}) {
  const [prices, setPrices] = useState(initialPrices);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    if (!canEdit) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/roi-prices`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(prices),
      });
      if (!response.ok) throw new Error("Failed to save finance settings.");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
              {field.label}
            </span>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[12px] text-ink-muted">$</span>
              <input
                type="number"
                min={field.key === "loaded_hourly_cost" ? 1 : 0}
                value={prices[field.key]}
                disabled={!canEdit}
                onChange={(event) => {
                  setPrices((current) => ({
                    ...current,
                    [field.key]: Number(event.target.value),
                  }));
                  setSaveState("idle");
                }}
                className="w-full rounded-md border border-subtle bg-surface px-2 py-1.5 text-[12.5px] font-medium tabular-nums text-ink focus:border-ink-muted focus:outline-none disabled:bg-muted disabled:text-ink-muted"
              />
            </div>
          </label>
        ))}
      </div>

      <label className="block max-w-[160px]">
        <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
          Currency
        </span>
        <input
          type="text"
          maxLength={3}
          value={prices.currency}
          disabled={!canEdit}
          onChange={(event) => {
            setPrices((current) => ({
              ...current,
              currency: event.target.value.toUpperCase(),
            }));
            setSaveState("idle");
          }}
          className="mt-1 w-full rounded-md border border-subtle bg-surface px-2 py-1.5 text-[12.5px] font-medium uppercase tracking-wide text-ink focus:border-ink-muted focus:outline-none disabled:bg-muted disabled:text-ink-muted"
        />
      </label>

      <div className="flex items-center justify-between gap-3">
        <div className="text-[11.5px] text-ink-muted">
          {saveState === "saved"
            ? "Saved"
            : saveState === "error"
              ? "Save failed"
              : canEdit
                ? "Used by automation opportunity ROI scoring."
                : "Admin access required."}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!canEdit || saveState === "saving"}
          className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:border-subtle disabled:bg-muted disabled:text-ink-muted"
        >
          {saveState === "saving" ? "Saving" : "Save"}
        </button>
      </div>
    </div>
  );
}
