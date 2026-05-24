import { BreadcrumbHeader } from "@/components/layout/BreadcrumbHeader";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";

export default function SettingsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <BreadcrumbHeader
        back={{ href: "/overview", label: "Overview" }}
        crumbs={[{ label: "Workspace settings" }]}
      />
      <main className="mx-auto w-full max-w-[920px] flex-1 px-8 py-8">
        <header className="mb-8">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">
            Workspace settings
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            Retention policies, RBAC roster, and the audit log preview.
          </p>
        </header>

        <Section title="Retention policies">
          <div className="space-y-2.5 text-[12.5px]">
            <Retention label="Raw frames" current="72 hours post-synthesis" options={["24h", "72h", "30 days", "Opt-in extended"]} />
            <Retention label="Audio recordings" current="30 days" options={["0 days (no recording)", "7 days", "30 days", "365 days"]} />
            <Retention label="Transcripts" current="Persistent" options={["30 days", "1 year", "Persistent"]} />
            <Retention label="Vendor traces (Langfuse)" current="14 days · sanitized" options={["7 days", "14 days", "30 days"]} />
          </div>
        </Section>

        <Section title="Members &amp; roles">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-muted text-left text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Last active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {[
                { name: "Michael Z.", email: "tryflowlabs@gmail.com", role: "Org Admin", last: "now" },
                { name: "B. Owusu", email: "b.owusu@acme.co", role: "Director", last: "yesterday" },
                { name: "S. Klein", email: "s.klein@acme.co", role: "Operator", last: "2 days ago" },
                { name: "FDE — Jordan", email: "jordan@otto.team", role: "FDE", last: "this morning" },
              ].map((m) => (
                <tr key={m.email}>
                  <td className="px-3 py-3 font-medium text-ink">{m.name}</td>
                  <td className="px-3 py-3 text-ink-secondary">{m.email}</td>
                  <td className="px-3 py-3">
                    <Pill tone={m.role === "FDE" ? "success" : m.role === "Org Admin" ? "role" : "neutral"}>
                      {m.role}
                    </Pill>
                  </td>
                  <td className="px-3 py-3 text-ink-muted">{m.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Recent audit events">
          <ul className="space-y-2 text-[12.5px]">
            {[
              { ts: "11:42", event: "draft_approved", subject: "Promotion Management v1", by: "Michael Z." },
              { ts: "11:18", event: "redaction_requested", subject: "capture · screenshare · 30s", by: "S. Klein" },
              { ts: "09:01", event: "export_generated", subject: "PDF · Executive Report", by: "FDE — Jordan" },
              { ts: "yesterday", event: "raw_payload_logging_enabled", subject: "debug window · 1h", by: "FDE — Jordan" },
            ].map((row) => (
              <li
                key={row.ts + row.event}
                className="grid grid-cols-[80px_180px_1fr_120px] items-center gap-3 rounded-md bg-muted px-3 py-2"
              >
                <span className="font-mono text-[11px] tabular-nums text-ink-muted">{row.ts}</span>
                <Pill tone="neutral">{row.event.replace(/_/g, " ")}</Pill>
                <span className="text-ink">{row.subject}</span>
                <span className="text-right text-ink-muted">{row.by}</span>
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="my-8">
      <h2 className="text-[14px] font-semibold tracking-tight text-ink">
        {title}
      </h2>
      <div className="mt-3 rounded-lg border border-subtle bg-surface p-5">{children}</div>
    </section>
  );
}

function Retention({
  label,
  current,
  options,
}: {
  label: string;
  current: string;
  options: string[];
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2.5">
      <div>
        <div className="font-medium text-ink">{label}</div>
        <div className="text-[11.5px] text-ink-muted">Currently: {current}</div>
      </div>
      <select className="rounded-md border border-subtle bg-surface px-2.5 py-1.5 text-[12px] text-ink focus:border-ink-muted focus:outline-none">
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}
