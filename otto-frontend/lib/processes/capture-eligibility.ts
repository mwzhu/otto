export type OperatorCaptureProcessStatus =
  | "candidate"
  | "draft"
  | "approved"
  | "archived";

export function isOperatorCaptureEligibleStatus(
  status?: string | null,
): status is "draft" | "approved" {
  return status === "draft" || status === "approved";
}
