import { notFound, redirect } from "next/navigation";
import { requirePageAuth } from "@/lib/auth/session";
import { getWorkspaceForProcess } from "@/lib/workspaces/current";

export default async function AutomationRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const auth = await requirePageAuth();
  const workspace = await getWorkspaceForProcess(auth, id);
  if (!workspace) notFound();

  redirect(
    `/overview?workspace_id=${encodeURIComponent(workspace.id)}&tab=automation`,
  );
}
