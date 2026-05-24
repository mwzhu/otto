import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { CaptureOptionCard } from "@/components/capture/CaptureOptionCard";
import { Button } from "@/components/ui/Button";
import { GradientMark } from "@/components/brand/GradientMark";
import { BRAND } from "@/lib/brand";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";

export default async function CaptureEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  if (!workspace) notFound();
  const process = await getDirectorProcessDetail(auth.orgId, workspace.id, id);
  if (!process) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        back={{ href: `/process/${id}`, label: process.name }}
        crumbs={[{ label: "Capture" }]}
      />
      <main className="mx-auto w-full max-w-[920px] flex-1 px-8 py-10">
        <header className="space-y-1 text-center">
          <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-muted">
            Capture
          </div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">
            Capture <span className="font-semibold">{process.name}</span> process
          </h1>
        </header>

        <div className="mt-2 inline-flex rounded-full bg-ink px-3 py-1.5 text-[11px] font-medium text-canvas">
          {BRAND.name}: Map, Optimize, Automate Retail & CPG operations
        </div>

        <section className="mt-8 grid grid-cols-2 gap-4">
          <CaptureOptionCard
            illustration={<GradientMark variant="wave" size={64} />}
            title={`Take interview with ${BRAND.name}`}
            description="Start a real capture session for this process."
            cta={
              <Link href={`/process/${id}/capture/screenshare`}>
                <Button>Start Interview</Button>
              </Link>
            }
          />
          <CaptureOptionCard
            illustration={<GradientMark variant="doc" size={64} />}
            title="Upload SOP document"
            description="Upload real documentation and extract evidence-backed claims."
            cta={
              <Link href="/onboarding/upload">
                <Button variant="secondary">Upload</Button>
              </Link>
            }
          />
        </section>
      </main>
    </div>
  );
}
