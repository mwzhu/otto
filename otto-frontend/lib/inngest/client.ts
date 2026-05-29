import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "otto-phase-1" });

export const artifactUploadedEventName = "artifact.uploaded.v1";
export const directorInterviewCompletedEventName =
  "director.interview.completed.v1";
export const documentArtifactUploadedEventName = "document.artifact.uploaded.v1";
export const inventorySynthesisRequestedEventName =
  "synthesis.inventory.requested.v1";
export const operatorCaptureCompletedEventName =
  "operator.capture.completed.v1";
export const operatorScreenRecordingUploadedEventName =
  "operator.screen_recording.uploaded.v1";
export const processDocumentUploadedEventName =
  "process.document.uploaded.v1";
export const operatorProcessSynthesisRequestedEventName =
  "synthesis.operator_process.requested.v1";
export const operatorRedactionRequestedEventName =
  "operator.redaction.requested.v1";
export const operatorScreenFrameCapturedEventName =
  "operator.screen_frame.captured.v1";
