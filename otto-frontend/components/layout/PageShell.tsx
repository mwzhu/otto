import { BreadcrumbHeader, type Crumb } from "./BreadcrumbHeader";
import { cn } from "@/lib/cn";

export function PageShell({
  crumbs,
  back,
  headerRight,
  children,
  maxWidth = "default",
  bare = false,
}: {
  crumbs?: Crumb[];
  back?: { href: string; label: string };
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: "default" | "wide" | "full";
  bare?: boolean;
}) {
  const widthClass =
    maxWidth === "full"
      ? "w-full"
      : maxWidth === "wide"
      ? "mx-auto w-full max-w-[1440px] px-8"
      : "mx-auto w-full max-w-[1180px] px-8";

  return (
    <div className="flex min-h-screen flex-col">
      {!bare && (
        <BreadcrumbHeader crumbs={crumbs} back={back} right={headerRight} />
      )}
      <main className={cn("flex-1 py-8", widthClass)}>{children}</main>
    </div>
  );
}
