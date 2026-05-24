import { notFound } from "next/navigation";
import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { WorkspaceTopNav } from "@/components/workspace/WorkspaceTopNav";
import { requirePageAuth } from "@/lib/auth/session";
import { getCurrentWorkspace } from "@/lib/workspaces/current";
import { getDirectorProcessDetail } from "@/lib/processes/queries";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
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
        back={{ href: "/overview", label: "Overview" }}
        crumbs={[
          { label: process.function, href: "/overview" },
          { label: process.name },
        ]}
      />
      <WorkspaceTopNav processId={id} processName={process.name} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
