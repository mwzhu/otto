import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "otto-phase-1" });

export const artifactUploadedEventName = "artifact.uploaded.v1";
export const directorInterviewCompletedEventName =
  "director.interview.completed.v1";
export const documentArtifactUploadedEventName = "document.artifact.uploaded.v1";
export const inventorySynthesisRequestedEventName =
  "synthesis.inventory.requested.v1";
