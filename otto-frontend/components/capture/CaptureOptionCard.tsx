import { Card } from "@/components/ui/Card";
import type { ReactNode } from "react";

export function CaptureOptionCard({
  title,
  description,
  cta,
  primary = false,
  illustration,
}: {
  title: string;
  description: string;
  cta: ReactNode;
  primary?: boolean;
  illustration?: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col gap-4 p-5">
      {illustration && <div className="h-20">{illustration}</div>}
      <div className="grow">
        <h3 className="text-[14.5px] font-semibold tracking-tight text-ink">
          {title}
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
          {description}
        </p>
      </div>
      <div className="mt-auto">{cta}</div>
    </Card>
  );
}
