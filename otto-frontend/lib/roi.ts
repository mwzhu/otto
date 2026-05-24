import type { ROIAssumptions } from "@/lib/types";

export type ROIResult = {
  annual_time_value: number;
  annual_error_value: number;
  annual_delay_value: number;
  gross_value: number;
  net_score: number;
};

// BUILD_PLAN.md §9.1 — deterministic ROI math
export function computeROI(a: ROIAssumptions): ROIResult {
  const annual_time_value =
    (a.annual_volume * a.minutes_saved_per_case * a.loaded_hourly_cost) / 60;
  const annual_error_value =
    a.annual_volume * a.error_rate * a.cost_per_error;
  const annual_delay_value =
    a.annual_volume * a.exception_rate * a.delay_cost;
  const gross_value =
    annual_time_value + annual_error_value + annual_delay_value;
  const net_score = (gross_value * a.confidence) / Math.max(1, a.effort_penalty);
  return {
    annual_time_value,
    annual_error_value,
    annual_delay_value,
    gross_value,
    net_score,
  };
}

export function fmtUSD(n: number, opts?: { decimals?: number }): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: opts?.decimals ?? 0,
  }).format(n);
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
