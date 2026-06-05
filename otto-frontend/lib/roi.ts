import type { ROIAssumptions } from "@/lib/types";

export type ROIResult = {
  annual_time_value: number;
  annual_error_value: number;
  annual_delay_value: number;
  gross_value: number;
  net_score: number;
};

export type ROIRange = {
  low: number;
  base: number;
  high: number;
};

export type ROIRangeAssumptions = {
  annual_volume: ROIRange;
  minutes_saved_per_case: ROIRange;
  error_rate: ROIRange;
  exception_rate: ROIRange;
};

export type ROIRangeResult = {
  annual_time_value: ROIRange;
  annual_error_value: ROIRange;
  annual_delay_value: ROIRange;
  gross_value: ROIRange;
  net_score: ROIRange;
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

export function computeRoiRange(
  ranges: ROIRangeAssumptions,
  prices: Pick<
    ROIAssumptions,
    "loaded_hourly_cost" | "cost_per_error" | "delay_cost"
  >,
  modifiers: Pick<ROIAssumptions, "confidence" | "effort_penalty">,
): ROIRangeResult {
  const point = (key: keyof ROIRange) => {
    const result = computeROI({
      annual_volume: ranges.annual_volume[key],
      minutes_saved_per_case: ranges.minutes_saved_per_case[key],
      loaded_hourly_cost: prices.loaded_hourly_cost,
      error_rate: ranges.error_rate[key],
      cost_per_error: prices.cost_per_error,
      exception_rate: ranges.exception_rate[key],
      delay_cost: prices.delay_cost,
      confidence: modifiers.confidence,
      effort_penalty: modifiers.effort_penalty,
    });
    return result;
  };
  const low = point("low");
  const base = point("base");
  const high = point("high");
  return {
    annual_time_value: rangeFromPoints(low, base, high, "annual_time_value"),
    annual_error_value: rangeFromPoints(low, base, high, "annual_error_value"),
    annual_delay_value: rangeFromPoints(low, base, high, "annual_delay_value"),
    gross_value: rangeFromPoints(low, base, high, "gross_value"),
    net_score: rangeFromPoints(low, base, high, "net_score"),
  };
}

function rangeFromPoints(
  low: ROIResult,
  base: ROIResult,
  high: ROIResult,
  key: keyof ROIResult,
): ROIRange {
  return { low: low[key], base: base[key], high: high[key] };
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
