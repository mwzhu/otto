import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export function EntryTile({
  title,
  description,
  illustration,
  cta,
  href,
}: {
  title: string;
  description: string;
  illustration: ReactNode;
  cta: ReactNode;
  href: string;
}) {
  return (
    <Card className="flex h-full flex-col gap-6 p-7">
      <div className="grid h-32 place-items-start">{illustration}</div>
      <div>
        <h2 className="text-[16px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-ink-secondary">
          {description}
        </p>
      </div>
      <Link href={href} className="mt-auto">
        <Button size="md" className="gap-2">
          {cta}
        </Button>
      </Link>
    </Card>
  );
}
