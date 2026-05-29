import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  FileText,
  Mic,
  MonitorUp,
  Video,
} from "lucide-react";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { CaptureOptionCard } from "@/components/capture/CaptureOptionCard";
import { CaptureUnavailable } from "@/components/capture/CaptureUnavailable";
import { Button } from "@/components/ui/Button";
import { BRAND } from "@/lib/brand";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";

export default async function CaptureEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getWorkspaceForProcess(auth, id);
  if (!workspace) notFound();
  const process = await getDirectorProcessDetail(auth.orgId, workspace.id, id);
  if (!process) notFound();

  if (!isOperatorCaptureEligibleStatus(process.process_status)) {
    return (
      <div className="flex min-h-screen flex-col">
        <BreadcrumbHeader
          back={{ href: `/process/${id}`, label: process.name }}
          crumbs={[{ label: "Capture" }]}
        />
        <CaptureUnavailable
          processId={id}
          processName={process.name}
          status={process.process_status}
        />
      </div>
    );
  }

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
            illustration={<ModeIcon icon={<Mic size={26} />} />}
            title="Voice-only interview"
            description={`${BRAND.name} asks step, handoff, system, exception, and workaround questions while the operator talks through the process.`}
            cta={
              <Link href={`/process/${id}/capture/voice`}>
                <Button>Start Interview</Button>
              </Link>
            }
          />
          <CaptureOptionCard
            illustration={<ModeIcon icon={<MonitorUp size={26} />} />}
            title="Screen-share + voice"
            description="Walk through the live workflow while Otto watches for workarounds, duplicate entry, exceptions, and SOP contradictions."
            cta={
              <Link href={`/process/${id}/capture/screenshare`}>
                <Button>Share Screen</Button>
              </Link>
            }
          />
          <CaptureOptionCard
            illustration={<ModeIcon icon={<Video size={26} />} />}
            title="Upload screen recording"
            description="Upload a narrated or silent process walkthrough. Otto extracts transcript, screen events, and follow-up gaps."
            cta={
              <Link href={`/process/${id}/capture/upload-video`}>
                <Button variant="secondary">Upload Video</Button>
              </Link>
            }
          />
          <CaptureOptionCard
            illustration={<ModeIcon icon={<FileText size={26} />} />}
            title="Upload SOP document"
            description="Attach documentation to this process so synthesis can compare documented flow with observed operator reality."
            cta={
              <Link href={`/process/${id}/capture/upload-document`}>
                <Button variant="secondary">Upload SOP</Button>
              </Link>
            }
          />
        </section>
      </main>
    </div>
  );
}

function ModeIcon({ icon }: { icon: ReactNode }) {
  return (
    <div className="grid size-14 place-items-center rounded-lg border border-subtle bg-muted text-ink">
      {icon}
    </div>
  );
}
