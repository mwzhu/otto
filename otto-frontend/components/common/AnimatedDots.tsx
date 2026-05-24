import { cn } from "@/lib/cn";

export function AnimatedDots({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "dot-pulse inline-flex items-center gap-1 text-ink-muted",
        className,
      )}
      aria-label="Thinking"
    >
      <span className="size-1.5 rounded-full bg-current" />
      <span className="size-1.5 rounded-full bg-current" />
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}
