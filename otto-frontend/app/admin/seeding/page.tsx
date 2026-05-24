import { Button } from "@/components/ui/Button";

export default function SeedingPage() {
  return (
    <div className="max-w-[760px] space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Hypothesis seeding
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Pre-seed hypotheses the interview agent should probe. These become
          high-priority probe intents on the very next session.
        </p>
      </header>

      <form className="space-y-4 rounded-lg border border-subtle bg-surface p-5">
        <Field label="Target process">
          <select className="w-full rounded-md border border-subtle bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-muted focus:outline-none">
            <option>Promotion Management</option>
            <option>Product Lifecycle Management</option>
            <option>Fresh Produce Ordering</option>
          </select>
        </Field>
        <Field label="Hypothesis to test">
          <textarea
            rows={3}
            className="block w-full resize-none rounded-md border border-subtle bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-muted focus:outline-none"
            placeholder="e.g. Coordinator may be re-keying approved promo terms; check for an Excel intermediary."
          />
        </Field>
        <Field label="Confidence">
          <select className="w-48 rounded-md border border-subtle bg-canvas px-3 py-2 text-[13px] text-ink focus:border-ink-muted focus:outline-none">
            <option>Low — sniff test only</option>
            <option>Medium — explicit probe</option>
            <option>High — must-fire</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary">Save draft</Button>
          <Button>Inject into next session</Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
