import { Pill } from "@/components/ui/Pill";

export type ProcessStatus = "documented" | "in_progress" | "draft" | "approved";

export function StatusBadge({ status }: { status: ProcessStatus }) {
  switch (status) {
    case "documented":
      return (
        <Pill tone="success" icon={<Dot color="var(--color-success)" />}>
          Documented
        </Pill>
      );
    case "in_progress":
      return (
        <Pill tone="warn" icon={<Dot color="var(--color-warn)" />}>
          In progress
        </Pill>
      );
    case "draft":
      return <Pill tone="draft">Draft</Pill>;
    case "approved":
      return <Pill tone="success">Approved</Pill>;
  }
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-1.5 rounded-full"
      style={{ background: color }}
    />
  );
}
