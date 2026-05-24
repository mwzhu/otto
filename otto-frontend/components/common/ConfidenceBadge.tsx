import { Pill } from "@/components/ui/Pill";

export function ConfidenceBadge({ value }: { value: number }) {
  const tone = value >= 0.8 ? "success" : value >= 0.5 ? "warn" : "danger";
  const label =
    value >= 0.8 ? "High confidence" : value >= 0.5 ? "Medium" : "Low confidence";
  return <Pill tone={tone}>{label} · {(value * 100).toFixed(0)}%</Pill>;
}
