import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-solid text-canvas hover:bg-solid-hover active:scale-[0.99] shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]",
  secondary:
    "bg-surface text-ink border border-subtle hover:border-ink-muted",
  ghost: "bg-transparent text-ink-secondary hover:bg-muted hover:text-ink",
  outline:
    "bg-transparent text-ink border border-subtle hover:bg-muted hover:border-ink-muted",
  danger: "bg-danger text-white hover:bg-danger/90",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[12px] gap-1.5 rounded-md",
  md: "h-9 px-4 text-[13px] gap-2 rounded-md",
  lg: "h-11 px-5 text-[14px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
