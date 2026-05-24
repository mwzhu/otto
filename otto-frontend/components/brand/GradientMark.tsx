import { cn } from "@/lib/cn";

type Variant = "wave" | "doc" | "loops" | "logo";

export function GradientMark({
  variant = "wave",
  className,
  size = 96,
}: {
  variant?: Variant;
  className?: string;
  size?: number;
}) {
  const w = size;
  const h = size;
  const gid = `g-${variant}-${size}`;

  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 96 96"
      className={cn(className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--color-grad-from)" />
          <stop offset="55%" stopColor="var(--color-grad-mid)" />
          <stop offset="100%" stopColor="var(--color-grad-to)" />
        </linearGradient>
      </defs>

      {variant === "wave" && (
        <g stroke={`url(#${gid})`} strokeWidth="6" strokeLinecap="round" fill="none">
          <line x1="14" y1="44" x2="14" y2="52" />
          <line x1="24" y1="34" x2="24" y2="62" />
          <line x1="34" y1="22" x2="34" y2="74" />
          <line x1="44" y1="14" x2="44" y2="82" />
          <line x1="54" y1="24" x2="54" y2="72" />
          <line x1="64" y1="34" x2="64" y2="62" />
          <line x1="74" y1="40" x2="74" y2="56" />
          <line x1="84" y1="44" x2="84" y2="52" />
        </g>
      )}

      {variant === "doc" && (
        <g
          stroke={`url(#${gid})`}
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M28 22 H62 L72 32 V76 H28 Z" />
          <path d="M62 22 V32 H72" />
          <line x1="36" y1="44" x2="60" y2="44" />
          <line x1="36" y1="54" x2="64" y2="54" />
          <line x1="36" y1="64" x2="52" y2="64" />
        </g>
      )}

      {variant === "loops" && (
        <g
          stroke={`url(#${gid})`}
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M24 40 C 24 24, 48 24, 48 40 S 72 56, 72 40" />
          <path d="M24 60 C 24 44, 48 44, 48 60 S 72 76, 72 60" />
        </g>
      )}

      {variant === "logo" && (
        <g>
          <circle cx="48" cy="48" r="22" fill={`url(#${gid})`} opacity="0.18" />
          <circle
            cx="48"
            cy="48"
            r="22"
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth="3"
          />
          <circle cx="48" cy="48" r="6" fill="var(--color-ink)" />
        </g>
      )}
    </svg>
  );
}
