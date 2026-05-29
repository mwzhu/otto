import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { CaptureUnavailable } from "@/components/capture/CaptureUnavailable";
import { ProcessCaptureUploadClient } from "@/components/capture/ProcessCaptureUploadClient";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";

export default async function UploadDocumentPage({
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
            { label: "Upload SOP" },
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
          { label: "Upload SOP" },
        ]}
      />
      <main className="flex-1 px-8 py-10">
        <header className="mb-8 space-y-1.5 text-center">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">
            Upload an SOP or process document
          </h1>
          <p className="mx-auto max-w-[560px] text-[13px] leading-relaxed text-ink-secondary">
            Attach documentation to {process.name}. Otto treats it as documented
            evidence and compares it with observed operator behavior.
          </p>
        </header>
        <ProcessCaptureUploadClient
          workspaceId={workspace.id}
          processId={id}
          uploadKind="document"
        />
      </main>
    </div>
  );
}
