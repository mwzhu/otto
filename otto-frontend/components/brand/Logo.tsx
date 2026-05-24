import { cn } from "@/lib/cn";
import { BRAND } from "@/lib/brand";
import { GradientMark } from "./GradientMark";

export function Logo({
  className,
  showName = true,
  size = 22,
}: {
  className?: string;
  showName?: boolean;
  size?: number;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 select-none", className)}>
      <GradientMark variant="logo" size={size} />
      {showName && (
        <span className="text-[15px] font-medium tracking-tight text-ink">
          {BRAND.name}
        </span>
      )}
    </span>
  );
}
