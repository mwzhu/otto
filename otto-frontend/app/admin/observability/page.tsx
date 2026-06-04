import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { requirePageAuth } from "@/lib/auth/session";
import { getObservabilityDashboard } from "@/lib/admin/observability-queries";
import { getCurrentWorkspace } from "@/lib/workspaces/current";

export default async function ObservabilityPage() {
  const auth = await requirePageAuth();
  const workspace = await getCurrentWorkspace(auth);
  const dashboard = workspace
    ? await getObservabilityDashboard(auth.orgId, workspace.id)
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          Observability
        </h1>
        <p className="mt-1 text-[12.5px] text-ink-secondary">
          Runtime health signals from agent decisions and synthesis checkpoints.
        </p>
      </header>

      {dashboard ? (
        <>
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {dashboard.metrics.map((metric) => (
              <Card key={metric.key} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                      {metric.label}
                    </div>
                    <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">
                      {formatMetric(metric.value, metric.unit)}
                    </div>
                  </div>
                  <Pill tone={metric.tone === "danger" ? "danger" : metric.tone === "warn" ? "warn" : "success"}>
                    {metric.tone}
                  </Pill>
                </div>
                <div className="mt-3 text-[11.5px] text-ink-muted">
                  {metric.threshold}
                </div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">
                  {metric.detail}
                </div>
              </Card>
            ))}
          </section>

          <section className="rounded-lg border border-subtle bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[14px] font-semibold tracking-tight text-ink">
                  Alerts
                </h2>
                <p className="mt-1 text-[12px] text-ink-secondary">
                  Threshold breaches that need FDE or engineering review.
                </p>
              </div>
              <div className="text-[11.5px] text-ink-muted">
                Updated {new Date(dashboard.generatedAt).toLocaleString()}
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {dashboard.alerts.length ? (
                dashboard.alerts.map((alert) => (
                  <div
                    key={alert.key}
                    className="flex items-center justify-between gap-4 rounded-md border border-subtle px-3 py-2 text-[12.5px]"
                  >
                    <div>
                      <div className="font-medium text-ink">{alert.label}</div>
                      <div className="mt-0.5 text-ink-secondary">{alert.detail}</div>
                    </div>
                    <Pill tone={alert.tone === "danger" ? "danger" : "warn"}>
                      {alert.tone}
                    </Pill>
                  </div>
                ))
              ) : (
                <div className="rounded-md border border-subtle bg-muted px-3 py-2 text-[12.5px] text-ink-secondary">
                  No active threshold alerts for the current workspace.
                </div>
              )}
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-lg border border-subtle bg-surface p-5 text-[13px] text-ink-secondary">
          Create or enter a workspace to populate observability.
        </div>
      )}
    </div>
  );
}

function formatMetric(value: number, unit: "ms" | "%" | "count" | "cents") {
  if (unit === "%") return `${value}%`;
  if (unit === "ms") return `${value}ms`;
  if (unit === "cents") return `${value.toFixed(3)}c`;
  return value.toLocaleString();
}
