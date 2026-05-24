import { cn } from "@/lib/cn";

type Tone = "neutral" | "role" | "system" | "high" | "med" | "low" | "success" | "warn" | "danger" | "draft";

const tones: Record<Tone, string> = {
  neutral: "bg-muted text-ink-secondary border-subtle",
  role: "bg-[#EEF1FB] text-[#2C3F8C] border-[#DDE3F3]",
  system: "bg-[#EFF6EE] text-[#3D6A45] border-[#DDE8DC]",
  high: "bg-complexity-high-bg text-complexity-high-ink border-complexity-high-bg/0",
  med: "bg-complexity-med-bg text-complexity-med-ink border-complexity-med-bg/0",
  low: "bg-complexity-low-bg text-complexity-low-ink border-complexity-low-bg/0",
  success: "bg-complexity-low-bg text-complexity-low-ink border-complexity-low-bg/0",
  warn: "bg-complexity-med-bg text-complexity-med-ink border-complexity-med-bg/0",
  danger: "bg-complexity-high-bg text-complexity-high-ink border-complexity-high-bg/0",
  draft: "bg-[#F2EEFC] text-[#574083] border-[#E3DBF5]",
};

export function Pill({
  children,
  tone = "neutral",
  className,
  icon,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-5 whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
