import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type EvalMetric = {
  name: string;
  score: number;
  minimum?: number;
};

export type EvalReport = {
  suite: string;
  fixture: string;
  cases: number;
  metrics: EvalMetric[];
};

export function reportEvalScores(report: EvalReport) {
  const normalized = {
    ...report,
    metrics: report.metrics.map((metric) => ({
      ...metric,
      score: roundScore(metric.score),
      minimum:
        typeof metric.minimum === "number" ? roundScore(metric.minimum) : undefined,
    })),
  };
  const line = JSON.stringify({ type: "eval_score", ...normalized });
  console.info(line);

  const reportPath = process.env.OTTO_EVAL_REPORT_PATH;
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  appendFileSync(reportPath, `${line}\n`, "utf8");
}

export function averageMetric<T extends Record<string, number>>(
  scores: T[],
  metric: keyof T,
) {
  if (scores.length === 0) return 1;
  return scores.reduce((sum, score) => sum + Number(score[metric]), 0) / scores.length;
}

export function ratio(numerator: number, denominator: number) {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function roundScore(score: number) {
  return Math.round(score * 1000) / 1000;
}
