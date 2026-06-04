import type { ProcessFollowUpTask } from "@/lib/processes/follow-up-queries";

export const REDACTION_FAILURE_FOLLOW_UP_DESCRIPTION =
  "Redaction could not complete. Retry redaction before using this capture, and review the capture before publishing.";

const INTERNAL_DIAGNOSTIC_PATTERN =
  /\b(failed query|params:|update\s+\w+|insert\s+into|delete\s+from|select\s+.+\s+from|postgres|drizzle|stack trace)\b/i;

export function followUpDescriptionForDisplay(task: ProcessFollowUpTask) {
  if (!task.description) return null;
  if (task.task_type === "redaction_failure") {
    return REDACTION_FAILURE_FOLLOW_UP_DESCRIPTION;
  }
  if (INTERNAL_DIAGNOSTIC_PATTERN.test(task.description)) {
    return "This follow-up needs reviewer attention. Internal diagnostic details were captured in logs.";
  }
  return task.description;
}
