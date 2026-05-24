import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";
import ScreenshareClient from "./ScreenshareClient";

export default async function ScreensharePage({
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
        back={{ href: `/process/${id}/capture`, label: "Capture" }}
        crumbs={[
          { label: process.name, href: `/process/${id}` },
          { label: "Screenshare interview" },
        ]}
      />
      <ScreenshareClient processId={id} />
    </div>
  );
}
