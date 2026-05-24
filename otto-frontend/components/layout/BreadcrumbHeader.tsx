import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/cn";

export type Crumb = {
  label: string;
  href?: string;
};

export function BreadcrumbHeader({
  crumbs = [],
  back,
  right,
  className,
}: {
  crumbs?: Crumb[];
  back?: { href: string; label: string };
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-14 items-center justify-between border-b border-subtle bg-canvas/85 px-6 backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center gap-3 text-[13px] text-ink-secondary">
        <Link
          href="/overview"
          className="inline-flex items-center gap-2 text-ink"
        >
          <Logo />
        </Link>
        {back && (
          <Link
            href={back.href}
            className="ml-3 inline-flex items-center gap-1 text-ink-secondary transition hover:text-ink"
          >
            <span aria-hidden>←</span>
            <span>{back.label}</span>
          </Link>
        )}
        {crumbs.length > 0 && (
          <div className="ml-3 flex items-center gap-2">
            <span className="text-ink-muted">/</span>
            {crumbs.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                {c.href ? (
                  <Link
                    href={c.href}
                    className="text-ink-secondary hover:text-ink"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-ink">{c.label}</span>
                )}
                {i < crumbs.length - 1 && (
                  <span className="text-ink-muted">/</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-[13px] text-ink-secondary">
        {right}
        <UserChip />
      </div>
    </header>
  );
}

function UserChip() {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-2 rounded-full border border-subtle bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition hover:border-ink-muted hover:text-ink"
    >
      <span className="grid size-5 place-items-center rounded-full bg-grad-from/40 text-[10px] font-semibold text-ink">
        MZ
      </span>
      <span>Acme Co.</span>
      <span className="text-ink-muted" aria-hidden>
        ▾
      </span>
    </button>
  );
}
