import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { CaptureUnavailable } from "@/components/capture/CaptureUnavailable";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";
import { OperatorVoicePreStartClient } from "./OperatorVoicePreStartClient";

export default async function OperatorVoicePage({
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
          back={{ href: `/process/${id}/capture`, label: "Capture" }}
          crumbs={[
            { label: process.name, href: `/process/${id}` },
            { label: "Voice interview" },
          ]}
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
        back={{ href: `/process/${id}/capture`, label: "Capture" }}
        crumbs={[
          { label: process.name, href: `/process/${id}` },
          { label: "Voice interview" },
        ]}
      />
      <main className="flex-1 px-8 py-10">
        <header className="mb-8 space-y-1.5 text-center">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">
            Voice-only operator interview
          </h1>
          <p className="mx-auto max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
            Capture how {process.name} actually runs from the operator&apos;s
            point of view.
          </p>
        </header>
        <OperatorVoicePreStartClient
          workspaceId={workspace.id}
          processId={id}
          processName={process.name}
        />
      </main>
    </div>
  );
}
