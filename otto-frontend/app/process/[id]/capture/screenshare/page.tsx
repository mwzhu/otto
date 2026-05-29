import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { CaptureUnavailable } from "@/components/capture/CaptureUnavailable";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";
import ScreenshareClient from "./ScreenshareClient";

export default async function ScreensharePage({
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
            { label: "Screenshare interview" },
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
          { label: "Screenshare interview" },
        ]}
      />
      <ScreenshareClient
        workspaceId={workspace.id}
        processId={id}
        processName={process.name}
      />
    </div>
  );
}
