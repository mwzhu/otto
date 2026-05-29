import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import { OperatorVoiceLiveClient } from "./OperatorVoiceLiveClient";

export default async function OperatorVoiceLivePage({
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

  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        back={{ href: `/process/${id}/capture/voice`, label: "Voice setup" }}
        crumbs={[
          { label: process.name, href: `/process/${id}` },
          { label: "Live voice" },
        ]}
      />
      <OperatorVoiceLiveClient processId={id} />
    </div>
  );
}
