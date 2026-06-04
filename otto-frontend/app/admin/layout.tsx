import Link from "next/link";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/coverage", label: "Coverage scorecard" },
  { href: "/admin/observability", label: "Observability" },
  { href: "/admin/variants", label: "Variant queue" },
  { href: "/admin/evidence", label: "Evidence inventory" },
  { href: "/admin/seeding", label: "Hypothesis seeding" },
  { href: "/admin/exports", label: "Exports" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        back={{ href: "/overview", label: "Overview" }}
        crumbs={[{ label: "FDE Admin" }]}
      />
      <div className="mx-auto grid w-full max-w-[1320px] flex-1 grid-cols-[220px_minmax(0,1fr)] gap-8 px-8 py-8">
        <aside className="space-y-1 border-r border-subtle pr-4 text-[12.5px]">
          <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
            FDE Tools
          </div>
          {NAV.map((n) => (
            <SidebarLink key={n.href} {...n} />
          ))}
          <div className="mt-6 rounded-md border border-dashed border-subtle p-3 text-[11.5px] text-ink-muted">
            FDE Admin is hidden from directors and operators. Use it to run discovery,
            review variants, and seed hypotheses before interviews.
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}

function SidebarLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-2.5 py-1.5 transition",
        "text-ink-secondary hover:bg-muted hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
}
