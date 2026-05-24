import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-8 py-12">
        {children}
      </main>
    </div>
  );
}
