import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendCaptureMessage,
  captureMessageFromDataEvent,
} from "@/components/capture/operatorConversationEvents";
import { operatorTurnPlanAnthropicToolSchema } from "@/lib/interview/operator/brain";
import { operatorTurnPlanSchema } from "@/lib/interview/operator/schema";
import { operatorSlotScope } from "@/lib/interview/operator/slot-schema";
import { directorTurnPlanSchema } from "@/lib/schemas/phase1";

const root = process.cwd();

describe("Phase 2 operator capture contract", () => {
  test("conversation events merge dispatched and delivery updates for the same agent turn", () => {
    const dispatched = captureMessageFromDataEvent([
      JSON.stringify({
        event: "operator.turn.dispatched",
        payload: {
          turn_index: 4,
          agent_utterance: "Got it. Keep going with the next step.",
          sent_at: "2026-06-04T21:19:00.000Z",
        },
      }),
    ]);
    const delivered = captureMessageFromDataEvent([
      JSON.stringify({
        event: "operator.turn.delivery_updated",
        payload: {
          turn_index: 4,
          agent_utterance: "Got it. Keep going",
          sent_at: "2026-06-04T21:19:01.000Z",
        },
      }),
    ]);

    expect(dispatched).not.toBeNull();
    expect(delivered).not.toBeNull();
    expect(dispatched?.id).toBe(delivered?.id);

    const messages = appendCaptureMessage(
      appendCaptureMessage([], dispatched!),
      delivered!,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      speaker: "agent",
      text: "Got it. Keep going with the next step.",
    });
  });

  test("capture evidence migration adds mode provenance and step-scoped slots", () => {
    const migration = read("migrations/0006_capture_evidence.sql");
    const sourceMigration = read(
      "migrations/0009_provisional_step_sources.sql",
    );

    expect(migration).toContain("CREATE TYPE capture_mode AS ENUM");
    expect(migration).toContain("'operator_voice'");
    expect(migration).toContain("'operator_screenshare'");
    expect(migration).toContain("'screen_recording_upload'");
    expect(migration).toContain("'process_document_upload'");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS capture_mode");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS screen_events");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS provisional_steps");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS provisional_step_id");
    expect(migration).toContain(
      "slot_states_capture_provisional_step_slot_idx",
    );
    expect(migration).not.toContain(
      "UNIQUE (capture_session_id, ordinal_hint)",
    );
    expect(sourceMigration).toContain("'live_screen_segmenter'");
    expect(sourceMigration).toContain("'screen_vision_segmenter'");
    expect(sourceMigration).toContain("'document_hypothesis'");
  });

  test("operator slot scope distinguishes capture-level and step-level slots", () => {
    expect(operatorSlotScope("process.frequency")).toBe("capture");
    expect(operatorSlotScope("sop.contradictions")).toBe("capture");
    expect(operatorSlotScope("step.systems")).toBe("step");
    expect(operatorSlotScope("step.inputs_outputs")).toBe("compatibility");
  });

  test("browser artifact uploads can fall back to authenticated proxy uploads", () => {
    const screenshare = read(
      "app/process/[id]/capture/screenshare/ScreenshareClient.tsx",
    );
    const processCaptureUpload = read(
      "components/capture/ProcessCaptureUploadClient.tsx",
    );
    const presignRoute = read(
      "app/api/workspaces/[workspaceId]/artifacts/presign/route.ts",
    );

    expect(presignRoute).toContain('artifactType === "screen_frame"');
    expect(presignRoute).toContain('artifactType === "video"');
    expect(presignRoute).toContain("sizeBytes <= MAX_PROXY_UPLOAD_BYTES");
    expect(screenshare).toContain("proxy_upload_url");
    expect(screenshare).toContain("fallbackUploadUrl: presign.proxy_upload_url");
    expect(screenshare).toContain("uploadArtifactBlob");
    expect(screenshare).toContain("Storage upload failed before the server accepted the file.");
    expect(processCaptureUpload).toContain("proxy_upload_url");
    expect(processCaptureUpload).toContain(
      "fallbackUploadUrl: presign.proxy_upload_url",
    );
    expect(processCaptureUpload).toContain("uploadArtifactBytes");
  });

  test("operator graph migration keeps graph rows canonical and RLS-protected", () => {
    const migration = read("migrations/0005_operator_graph.sql");
    const claimSubjects = JSON.parse(
      read("../schemas/claim-subject-fields.json"),
    ) as {
      allowed: Array<{
        subject_type: string;
        fields: Array<{ field: string }>;
      }>;
    };

    for (const table of [
      "process_nodes",
      "process_edges",
      "node_systems",
      "node_io",
      "exceptions",
      "workarounds",
      "variants",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain(
      "version_id uuid NOT NULL REFERENCES process_versions(id)",
    );
    expect(migration).toContain(
      "ALTER TYPE synthesis_run_type ADD VALUE IF NOT EXISTS 'process_graph'",
    );
    for (const subject of [
      "process_node",
      "process_edge",
      "exception",
      "workaround",
      "variant",
      "narrative_paragraph",
    ]) {
      expect(
        claimSubjects.allowed.some((entry) => entry.subject_type === subject),
      ).toBe(true);
    }
    expect(
      claimSubjects.allowed
        .find((entry) => entry.subject_type === "process_node")
        ?.fields.map((field) => field.field),
    ).toEqual(expect.arrayContaining(["input", "output", "evidence_coverage"]));
    expect(
      claimSubjects.allowed
        .find((entry) => entry.subject_type === "workaround")
        ?.fields.map((field) => field.field),
    ).toEqual(expect.arrayContaining(["description", "why_it_exists"]));
  });

  test("four capture modes have process-scoped front doors", () => {
    const entry = read("app/process/[id]/capture/page.tsx");
    const voice = read(
      "app/process/[id]/capture/voice/OperatorVoicePreStartClient.tsx",
    );
    const voiceLive = read(
      "app/process/[id]/capture/voice/live/OperatorVoiceLiveClient.tsx",
    );
    const screenshare = read(
      "app/process/[id]/capture/screenshare/ScreenshareClient.tsx",
    );
    const controls = read("components/capture/CaptureControls.tsx");
    const conversation = read("components/capture/ConversationPanel.tsx");
    const conversationEvents = read(
      "components/capture/operatorConversationEvents.ts",
    );
    const captureUnavailable = read(
      "components/capture/CaptureUnavailable.tsx",
    );
    const upload = read("components/capture/ProcessCaptureUploadClient.tsx");
    const voicePage = read("app/process/[id]/capture/voice/page.tsx");
    const screensharePage = read(
      "app/process/[id]/capture/screenshare/page.tsx",
    );
    const uploadVideoPage = read(
      "app/process/[id]/capture/upload-video/page.tsx",
    );
    const uploadDocumentPage = read(
      "app/process/[id]/capture/upload-document/page.tsx",
    );

    expect(entry).toContain("/capture/voice");
    expect(entry).toContain("/capture/screenshare");
    expect(entry).toContain("/capture/upload-video");
    expect(entry).toContain("/capture/upload-document");
    expect(entry).toContain(
      "isOperatorCaptureEligibleStatus(process.process_status)",
    );
    expect(captureUnavailable).toContain(
      "Promote {processName} before operator capture",
    );
    expect(voicePage).toContain(
      "isOperatorCaptureEligibleStatus(process.process_status)",
    );
    expect(screensharePage).toContain(
      "isOperatorCaptureEligibleStatus(process.process_status)",
    );
    expect(uploadVideoPage).toContain(
      "isOperatorCaptureEligibleStatus(process.process_status)",
    );
    expect(uploadDocumentPage).toContain(
      "isOperatorCaptureEligibleStatus(process.process_status)",
    );
    expect(voice).toContain("/operator-captures");
    expect(voice).toContain("/api/livekit/operator-room");
    expect(voice).toContain('mode: "voice"');
    expect(voice).toContain("operator_voice_v1");
    expect(screenshare).toContain("/operator-captures");
    expect(screenshare).toContain("/api/livekit/operator-room");
    expect(screenshare).toContain('mode: "screenshare"');
    expect(screenshare).toContain("operator_screenshare_v1");
    expect(screenshare).toContain('await import("livekit-client")');
    expect(screenshare).toContain("publishTrack");
    expect(screenshare).toContain("screen_share");
    expect(screenshare).toContain("ParticipantConnected");
    expect(screenshare).toContain("LocalTrackPublished");
    expect(screenshare).toContain("getDisplayMedia");
    expect(screenshare).toContain("startScreenFrameSampler");
    expect(screenshare).toContain("screenStream");
    expect(screenshare).toContain("micStreamRef");
    expect(screenshare).toContain("new MediaStream([");
    expect(screenshare).toContain("onScreenStreamChange");
    expect(screenshare).toContain("setScreenshareCapturePaused");
    expect(screenshare).toContain("pauseMediaRecorder");
    expect(screenshare).toContain("stopScreenFrameSampler");
    expect(screenshare).toContain("stopAndUploadMediaRecorderFallback");
    expect(screenshare).toContain("SCREEN_FRAME_SAMPLE_INTERVAL_MS = 500");
    expect(screenshare).toContain("uploadInFlight");
    expect(screenshare).toContain("warnIfStalled");
    expect(screenshare).toContain("SCREEN_FRAME_DUPLICATE_DIFF_THRESHOLD");
    expect(screenshare).toContain("screen_frame");
    expect(screenshare).toContain("/screen-frames");
    expect(screenshare).toContain("perceptual_hash");
    expect(screenshare).toContain("hammingDistance");
    expect(screenshare).toContain("sendLiveKitOperatorControl");
    expect(screenshare).toContain("otto.operator.control");
    expect(screenshare).toContain('event: "operator.control"');
    expect(screenshare).toContain("setOperatorMicrophoneMuted");
    expect(screenshare).toContain('muted ? "mute" : "unmute"');
    expect(screenshare).toContain("events.DataReceived");
    expect(screenshare).toContain("captureMessageFromDataEvent");
    expect(screenshare).toContain("/complete");
    expect(screenshare).toContain("/redactions");
    expect(screenshare).toContain("operator_requested_last_30_seconds");
    expect(conversation).toContain("CaptureConversationMessage");
    expect(conversation).toContain("ConversationBubble");
    expect(conversation).toContain("Operator transcript, Otto questions");
    expect(conversationEvents).toContain("captureMessageFromDataEvent");
    expect(conversationEvents).toContain("operator.turn.ingested");
    expect(conversationEvents).toContain("operator.turn.dispatched");
    expect(conversationEvents).toContain("operator.turn.delivery_updated");
    expect(voiceLive).toContain("/complete");
    expect(voiceLive).toContain(
      "/api/operator-captures/${session.captureSessionId}/turns",
    );
    expect(voiceLive).toContain("Typed fallback is ready");
    expect(voiceLive).toContain("postOperatorTurn");
    expect(voiceLive).toContain('await import("livekit-client")');
    expect(voiceLive).toContain("connectOperatorVoiceRoom");
    expect(voiceLive).toContain("events.DataReceived");
    expect(voiceLive).toContain("captureMessageFromDataEvent");
    expect(voiceLive).toContain("setMicrophoneEnabled");
    expect(voiceLive).toContain("sendLiveKitOperatorControl");
    expect(voiceLive).toContain("otto.operator.control");
    expect(voiceLive).toContain('event: "operator.control"');
    expect(controls).toContain("onMuteChange");
    expect(controls).toContain("Could not update pause state");
    expect(controls).toContain("await onComplete?.()");
    expect(upload).toContain("/captures/uploads");
    expect(upload).toContain(
      'type UploadKind = "screen_recording" | "document"',
    );
    expect(upload).toContain('uploadKind === "screen_recording"');
    expect(upload).toContain(
      'artifactType = uploadKind === "screen_recording" ? "video" : "document"',
    );
  });

  test("operator capture visual spec covers required route states", () => {
    const visualSpec = read("tests/visual/operator-process.spec.ts");

    expect(visualSpec).toContain(
      "renders four capture modes and each capture shell",
    );
    expect(visualSpec).toContain(
      "renders empty and populated operator workflow graph states",
    );
    expect(visualSpec).toContain("/capture");
    expect(visualSpec).toContain("/capture/voice");
    expect(visualSpec).toContain("/capture/voice/live");
    expect(visualSpec).toContain("/capture/screenshare");
    expect(visualSpec).toContain("/capture/upload-video");
    expect(visualSpec).toContain("/capture/upload-document");
    expect(visualSpec).toContain("Build the workflow map");
    expect(visualSpec).toContain("Approve Draft");
    expect(visualSpec).toContain("View evidence");
    expect(visualSpec).toContain("Captured screen evidence");
    expect(visualSpec).toContain(
      "DATABASE_SERVICE_URL ?? process.env.DATABASE_URL",
    );
  });

  test("operator capture APIs preserve process linkage and idempotency", () => {
    const operatorRoute = read(
      "app/api/processes/[processId]/operator-captures/route.ts",
    );
    const operatorRoomRoute = read("app/api/livekit/operator-room/route.ts");
    const uploadsRoute = read(
      "app/api/processes/[processId]/captures/uploads/route.ts",
    );
    const completeRoute = read(
      "app/api/processes/[processId]/operator-captures/[captureSessionId]/complete/route.ts",
    );
    const recordingRoute = read(
      "app/api/processes/[processId]/operator-captures/[captureSessionId]/recording/route.ts",
    );
    const internalCompleteRoute = read(
      "app/api/internal/operator-captures/complete/route.ts",
    );
    const redactionsRoute = read(
      "app/api/processes/[processId]/operator-captures/[captureSessionId]/redactions/route.ts",
    );

    expect(operatorRoute).toContain("requireIdempotencyKey");
    expect(operatorRoute).toContain("pg_advisory_xact_lock");
    expect(operatorRoute).toContain("operator.capture.start");
    expect(operatorRoute).toContain("getIdempotentResponse");
    expect(operatorRoute).toContain(
      'ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"])',
    );
    expect(operatorRoute).toContain(
      "isOperatorCaptureEligibleStatus(process.status)",
    );
    expect(operatorRoute).toContain(
      "Operator capture requires a draft or approved process",
    );
    expect(operatorRoute).toContain('captureType: "operator_interview"');
    expect(operatorRoute).toContain('"operator_screenshare"');
    expect(operatorRoute).toContain('"operator_voice"');

    expect(operatorRoomRoute).toContain("operatorVoiceReadiness");
    expect(operatorRoomRoute).toContain("createOperatorRoomToken");
    expect(operatorRoomRoute).toContain("requireIdempotencyKey");
    expect(operatorRoomRoute).toContain("reserveIdempotentRequest");
    expect(operatorRoomRoute).toContain(
      'eq(captureSessions.captureType, "operator_interview")',
    );
    expect(operatorRoomRoute).toContain('"operator_screenshare"');
    expect(operatorRoomRoute).toContain("capture.operator_voice.vendor_export");

    expect(uploadsRoute).toContain("requireIdempotencyKey");
    expect(uploadsRoute).toContain("pg_advisory_xact_lock");
    expect(uploadsRoute).toContain("process.capture.upload");
    expect(uploadsRoute).toContain("captureProcessLinks");
    expect(uploadsRoute).toContain('linkType: "enriched"');
    expect(uploadsRoute).toContain("operatorScreenRecordingUploadedEventName");
    expect(uploadsRoute).toContain("processDocumentUploadedEventName");
    expect(uploadsRoute).toContain("shouldSendEvent: false");
    expect(uploadsRoute).toContain("shouldSendEvent: true");
    expect(uploadsRoute).toContain(
      "isOperatorCaptureEligibleStatus(process.status)",
    );
    expect(uploadsRoute).toContain(
      "Operator capture uploads require a draft or approved process",
    );
    expect(uploadsRoute).toContain("validateUploadKind");

    expect(completeRoute).toContain("requireIdempotencyKey");
    expect(completeRoute).toContain("pg_advisory_xact_lock");
    expect(completeRoute).toContain("operator.capture.complete");
    expect(completeRoute).toContain("operatorCaptureCompletedEventName");
    expect(completeRoute).toContain("operatorScreenRecordingUploadedEventName");
    expect(completeRoute).toContain("shouldSendEvent: false");
    expect(completeRoute).toContain(
      "shouldSendEvent: existing.completedAt === null",
    );
    expect(completeRoute).toContain("shouldSendRecordingEvent");
    expect(completeRoute).toContain("background_recording_event");
    expect(completeRoute).toContain("recordingRouteOwnsProcessing");
    expect(completeRoute).toContain(
      'recordingProvider === "mediarecorder-final-blob"',
    );
    expect(completeRoute).toContain("captureHasRecordingProcessing");
    expect(completeRoute).toContain("tool_calls->>'artifact_id'");
    expect(completeRoute).toContain("artifact_id = ${input.artifactId}");
    expect(completeRoute).toContain("metadata_json->>'artifact_id'");
    expect(completeRoute).toContain("assertAllOperatorExtractionTerminal");
    expect(completeRoute).toContain("operator_extraction_windows");
    expect(completeRoute).toContain("stage_name = 'operator.turn'");
    expect(completeRoute).toContain("extraction_pending");
    expect(completeRoute).toContain("extraction_failed");
    expect(completeRoute).toContain(
      'eq(captureSessions.captureType, "operator_interview")',
    );
    expect(completeRoute).toContain("isNull(captureSessions.completedAt)");
    expect(completeRoute).toContain("capture.operator.completed");
    expect(recordingRoute).toContain(
      "operatorScreenRecordingUploadedEventName",
    );
    expect(recordingRoute).toContain("background_event");
    expect(recordingRoute).toContain("captureHasRecordingProcessing");
    expect(recordingRoute).toContain("tool_calls->>'artifact_id'");
    expect(recordingRoute).toContain("artifact_id = ${input.artifactId}");
    expect(recordingRoute).toContain("metadata_json->>'artifact_id'");
    expect(recordingRoute).toContain(
      "Failed to enqueue operator recording processing event",
    );
    expect(internalCompleteRoute).toContain("requireLiveKitAgentService");
    expect(internalCompleteRoute).toContain("resolveOperatorSessionContext");
    expect(internalCompleteRoute).toContain(
      "operatorCaptureCompletedEventName",
    );
    expect(internalCompleteRoute).toContain('source: "livekit_agent"');
    expect(internalCompleteRoute).toContain("clearPendingIdempotentRequest");
    expect(internalCompleteRoute).toContain("previousCompletionForThisKey");
    expect(internalCompleteRoute).toContain(
      "Boolean(previousCompletionForThisKey)",
    );

    expect(redactionsRoute).toContain("requireIdempotencyKey");
    expect(redactionsRoute).toContain("pg_advisory_xact_lock");
    expect(redactionsRoute).toContain("operator.redaction.request");
    expect(redactionsRoute).toContain("inArray(captureSessions.captureType");
    expect(redactionsRoute).toContain('"screen_recording_upload"');
    expect(redactionsRoute).toContain("redactions");
    expect(redactionsRoute).toContain("operatorRedactionRequestedEventName");
    expect(redactionsRoute).toContain('status: "pending"');
    expect(redactionsRoute).toContain("shouldSendEvent: false");
    expect(redactionsRoute).toContain("shouldSendEvent: true");
    expect(redactionsRoute).toContain("transcriptSegments");
    expect(redactionsRoute).toContain("screenEvents");
    expect(redactionsRoute).toContain(
      "Redaction failed; retry before using this capture.",
    );
    expect(redactionsRoute).toContain("markRedactionEnqueueFailed");
    expect(redactionsRoute).toContain("followUpTasks");
    expect(redactionsRoute).toContain('taskType: "redaction_failure"');
    expect(redactionsRoute).toContain('"redaction_enqueue_failed"');
    expect(redactionsRoute).toContain("statusCode: 503");
    expect(redactionsRoute).toContain("deletedAt: new Date()");
    expect(redactionsRoute).toContain("capture.operator.redacted");
    expect(redactionsRoute).toContain("last_seconds");
  });

  test("operator capture events are registered for process graph synthesis", () => {
    const client = read("lib/inngest/client.ts");
    const functions = read("lib/inngest/functions.ts");
    const operatorSynthesis = read("lib/synthesis/operator-process.ts");
    const graphWriter = read("lib/synthesis/operator.ts");
    const graphValidation = read("lib/synthesis/operator-graph-validation.ts");
    const graphTypes = read("lib/types/graph.ts");
    const graphQueries = read("lib/processes/graph-queries.ts");
    const workflowEval = read("tests/phase2/operator-workflow-eval.test.ts");
    const workflowFixtures = read("../evals/operator/workflow-fixtures.json");
    const semanticWorkflowEval = read(
      "tests/phase2/operator-semantic-workflow-eval.test.ts",
    );
    const semanticWorkflowFixtures = read(
      "../evals/operator/business-workflow-fixtures.json",
    );
    const processCanvas = read("components/canvas/ProcessCanvas.tsx");
    const workspaceClient = read(
      "app/process/[id]/workspace/WorkspaceClient.tsx",
    );
    const stepsTab = read("components/workspace/tabs/StepsTab.tsx");
    const processDocument = read("lib/documents/process-document.ts");
    const screenRecording = read("lib/video/process-screen-recording.ts");
    const screenRecordingAnalyzer = read(
      "lib/adapters/screen-recording-analyzer.ts",
    );
    const operatorRedaction = read("lib/redactions/operator-redaction.ts");
    const storage = read("lib/adapters/storage.ts");
    const localUpload = read("lib/adapters/local-upload.ts");
    const screenFrameRoute = read(
      "app/api/processes/[processId]/operator-captures/[captureSessionId]/screen-frames/route.ts",
    );
    const screenFrameVision = read("lib/vision/operator-screen-frame.ts");
    const visionAdapter = read("lib/adapters/vision.ts");

    expect(client).toContain("operator.capture.completed.v1");
    expect(client).toContain("operator.screen_recording.uploaded.v1");
    expect(client).toContain("process.document.uploaded.v1");
    expect(client).toContain("synthesis.operator_process.requested.v1");
    expect(client).toContain("operator.redaction.requested.v1");
    expect(client).toContain("operator.screen_frame.captured.v1");
    expect(functions).toContain("operatorCaptureReady");
    expect(functions).toContain("operatorProcessSynthesis");
    expect(functions).toContain("operatorRedactionRequested");
    expect(functions).toContain("operatorScreenFrameCaptured");
    expect(functions).toContain("operatorCaptureCompletedEventName");
    expect(functions).toContain("operatorScreenRecordingUploadedEventName");
    expect(functions).toContain("processDocumentUploadedEventName");
    expect(functions).toContain("operatorRedactionRequestedEventName");
    expect(functions).toContain("operatorScreenFrameCapturedEventName");
    expect(functions).toContain("operatorProcessSynthesisRequestedEventName");
    expect(functions).toContain("runOperatorProcessSynthesis");
    expect(functions).toContain("runOperatorRedaction");
    expect(functions).toContain("processOperatorScreenFrame");
    expect(functions).toContain("processSpecificDocumentArtifact");
    expect(functions).toContain("processScreenRecordingArtifact");
    expect(functions).toContain("parse-process-specific-document");
    expect(functions).toContain("process-operator-screen-recording");
    expect(functions).toContain("captureProcessingResult.ok !== true");
    expect(functions).toContain("operator_capture_processing_failed");
    expect(functions).toContain("process-operator-screen-frame-vision");
    expect(functions).toContain("operatorCaptureReady,");
    expect(functions).toContain("operatorProcessSynthesis,");
    expect(functions).toContain("operatorScreenFrameCaptured,");

    expect(operatorSynthesis).toContain('runType: "process_graph"');
    expect(operatorSynthesis).toContain("loadOperatorEvidencePack");
    expect(operatorSynthesis).toContain("priorVersion");
    expect(operatorSynthesis).toContain("processClaims");
    expect(operatorSynthesis).toContain(
      "current_draft_version_id ?? process.current_approved_version_id",
    );
    expect(operatorSynthesis).toContain("subject_type = 'process_version'");
    expect(operatorSynthesis).toContain("process_claim_count");
    expect(operatorSynthesis).toContain("redactionWindows");
    expect(operatorSynthesis).toContain("redaction_window_count");
    expect(operatorSynthesis).toContain('table: "claims"');
    expect(operatorSynthesis).toContain('table: "redactions"');
    expect(operatorSynthesis).toContain("operatorEdgeWaypoints");
    expect(operatorSynthesis).toContain("FROM redactions r");
    expect(operatorSynthesis).toContain("r.status <> 'failed'");
    expect(operatorSynthesis).toContain("ts.start_ms <= r.end_ms");
    expect(operatorSynthesis).toContain("ts.end_ms >= r.start_ms");
    expect(operatorSynthesis).toContain(
      "se.ts_ms BETWEEN r.start_ms AND r.end_ms",
    );
    expect(operatorSynthesis).toContain(
      "provisional_steps.ts_start_ms <= r.end_ms",
    );
    expect(operatorSynthesis).toContain(
      "source IN ('live_screen_segmenter', 'screen_vision_segmenter')",
    );
    expect(operatorSynthesis).toContain("buildDeterministicOperatorGraph");
    expect(operatorSynthesis).toContain("buildOperatorWorkflowGraph");
    expect(operatorSynthesis).toContain("workflowSemanticModels");
    expect(operatorSynthesis).toContain("stage-2a-semantic-extraction");
    expect(operatorSynthesis).toContain(
      "stage-3a-semantic-enrichment-and-validation",
    );
    expect(operatorSynthesis).toContain("linkWorkflowSemanticModelToVersion");
    expect(operatorSynthesis).toContain("createSemanticFollowUpTasks");
    expect(operatorSynthesis).toContain(
      "createSemanticDiagnosticFollowUpTasks",
    );
    expect(operatorSynthesis).toContain("shouldPublishOperatorWorkflowGraph");
    expect(operatorSynthesis).toContain("semantic_workflow_not_publishable");
    expect(operatorSynthesis).toContain("semanticFollowUpsForModel");
    expect(operatorSynthesis).toContain("mergeTaskSeeds");
    expect(operatorSynthesis).toContain("screenSignalDetails");
    expect(operatorSynthesis).toContain("slotDetailsForProvisionalStep");
    expect(operatorSynthesis).toContain("systemNamesFromScreenEvent");
    expect(operatorSynthesis).toContain("screenIoDetails");
    expect(operatorSynthesis).toContain("systems: seed.systems");
    expect(operatorSynthesis).toContain("inputs: seed.inputs");
    expect(operatorSynthesis).toContain("outputs: seed.outputs");
    expect(operatorSynthesis).toContain("writeOperatorGraphDraft");
    expect(operatorSynthesis).toContain("materializeProcessVersionClaims");
    expect(operatorSynthesis).toContain('subjectType: "process_version"');
    expect(operatorSynthesis).toContain('field: "summary"');
    expect(operatorSynthesis).toContain('field: "steps"');
    expect(operatorSynthesis).toContain('field: "evidence_coverage"');
    expect(operatorSynthesis).toContain("claimEvidence");
    expect(operatorSynthesis).toContain(
      "synthesis.operator.version_claims_materialized",
    );
    expect(operatorSynthesis).toContain("publishOperatorGraphDraft");
    expect(operatorSynthesis).toContain("stage-0-capture-ingest");
    expect(operatorSynthesis).toContain("stage-1-evidence-pack");
    expect(operatorSynthesis).toContain("stage-4-graph-build");
    expect(operatorSynthesis).toContain(
      "stage-5-gap-and-contradiction-followups",
    );
    expect(operatorSynthesis).toContain("stage-6-complexity-and-coverage");
    expect(operatorSynthesis).toContain("stage-7-narrative");
    expect(operatorSynthesis).toContain("validateOperatorGraph");
    expect(operatorSynthesis).toContain("graph_validation_failed");
    expect(operatorSynthesis).toContain("linkProvisionalStepsToGraphNodes");
    expect(operatorSynthesis).toContain("superseded_by_node_id");
    expect(operatorSynthesis).toContain("createGraphFollowUpTasks");
    expect(operatorSynthesis).toContain("linkOperatorCapturesToProcess");
    expect(operatorSynthesis).toContain("captureProcessLinks");
    expect(operatorSynthesis).toContain('linkType: "enriched"');
    expect(operatorSynthesis).toContain(
      "synthesis.operator.capture_links_materialized",
    );
    expect(operatorSynthesis).toContain("detectOperatorContradictionGaps");
    expect(operatorSynthesis).toContain(
      "export function detectOperatorContradictionGaps",
    );
    expect(operatorSynthesis).toContain("operatorDraftWarnings");
    expect(operatorSynthesis).toContain("computeOperatorGraphComplexity");
    expect(operatorSynthesis).toContain("buildOperatorDraftNarrative");
    expect(operatorSynthesis).toContain("sop_observed_spreadsheet_gap");
    expect(operatorSynthesis).toContain("low_confidence_inferred_graph_node");
    expect(operatorSynthesis).toContain("stage-8-publish-draft");
    expect(operatorSynthesis).toContain("synthesis.operator_process.started");
    expect(operatorSynthesis).toContain(
      "JOIN synthesis_runs sr ON sr.id = al.subject_id",
    );
    expect(operatorSynthesis).toContain("sr.status <> 'failed'");
    expect(operatorSynthesis).toContain("operator_synthesis_unhandled_error");
    expect(operatorSynthesis).toContain(
      "Preserve the original synthesis error",
    );
    expect(operatorSynthesis).toContain("synthesis.operator.completed");
    expect(graphWriter).toContain("semantic_step_id");
    expect(graphWriter).toContain("semantic_edge_id");
    expect(graphQueries).toContain("semantic_step_id");
    expect(graphQueries).toContain("semantic_edge_id");
    expect(semanticWorkflowEval).toContain("business_step_recall");
    expect(semanticWorkflowEval).toContain("technical_artifact_leakage_rate");
    expect(semanticWorkflowFixtures).toContain("promotion-management-map1-3");
    expect(semanticWorkflowFixtures).toContain("Supplier funding confirmed?");
    expect(semanticWorkflowFixtures).toContain("frontend-mockups/map7.png");
    expect(semanticWorkflowFixtures).toContain("Manual Re-Entry Data Bridge");
    expect(graphWriter).toContain("evidence_count");
    expect(graphWriter).toContain("top_evidence_ids");
    expect(graphWriter).toContain("assertValidOperatorGraph");
    expect(graphWriter).toContain("INSERT INTO node_systems");
    expect(graphWriter).toContain("INSERT INTO systems");
    expect(graphWriter).toContain("'operator_observed'");
    expect(graphWriter).toContain("INSERT INTO node_io");
    expect(graphWriter).toContain("INSERT INTO exceptions");
    expect(graphWriter).toContain("INSERT INTO workarounds");
    expect(graphWriter).toContain("INSERT INTO variants");
    expect(graphValidation).toContain("invalid_start_count");
    expect(graphValidation).toContain("dangling_edge");
    expect(graphValidation).toContain("unreachable_node");
    expect(graphValidation).toContain("missing_outgoing_edge");
    expect(graphValidation).toContain("unevidenced_high_confidence_node");
    expect(graphTypes).toContain("evidence_ids?: string[]");
    expect(graphTypes).toContain("terminal?: boolean");
    expect(graphTypes).toContain("warnings?: Array");
    expect(graphTypes).toContain("source_provisional_step_ids?: string[]");
    expect(processCanvas).toContain("onNodeEvidenceOpen");
    expect(processCanvas).toContain("evidence_ids");
    expect(workspaceClient).toContain("NodeEvidenceDrawer");
    expect(workspaceClient).toContain("canvasEvidence");
    expect(stepsTab).toContain("export function NodeEvidenceDrawer");
    expect(stepsTab).toContain("Frame expired by retention policy");
    expect(stepsTab).toContain("Captured screen evidence");
    expect(workflowEval).toContain("operator workflow builder early eval gate");
    expect(workflowEval).toContain("step_recall");
    expect(workflowEval).toContain("workaround_recall");
    expect(workflowFixtures).toContain("voice-purchase-order");
    expect(workflowFixtures).toContain("screenshare-spreadsheet-workaround");
    expect(processDocument).toContain("processSpecificDocumentArtifact");
    expect(processDocument).toContain("artifact_not_document");
    expect(processDocument).toContain("process-document.process");
    expect(processDocument).toContain("pg_advisory_xact_lock");
    expect(processDocument).toContain("findExistingProcessDocumentExtraction");
    expect(processDocument).toContain("process-document.claims");
    expect(processDocument).toContain("existingRiskChunkIds");
    expect(processDocument).toContain("value->>'document_chunk_id'");
    expect(processDocument).toContain("process.document.parsed");
    expect(processDocument).toContain("Review failed SOP upload");
    expect(processDocument).toContain("process_document_upload_failed");
    expect(processDocument).toContain("candidate_process_ids: []");
    expect(processDocument).toContain('evidenceLabel: "documented"');
    expect(processDocument).toContain('source: "document_hypothesis"');
    expect(processDocument).toContain("documentStepHypotheses");
    expect(processDocument).toContain("materializeProcessDocumentClaims");
    expect(processDocument).toContain('"documentation_maturity"');
    expect(processDocument).toContain('"control"');
    expect(processDocument).toContain('"risk"');
    expect(processDocument).toContain("claimEvidence");
    expect(processDocument).toContain("process.document.claims_materialized");
    expect(processDocument).toContain("no_document_step_hypotheses");
    expect(screenRecording).toContain("processScreenRecordingArtifact");
    expect(screenRecording).toContain("analyzeScreenRecording");
    expect(screenRecording).toContain("analyzeScreenFrame");
    expect(screenRecording).toContain('eventType: "screen_recording_upload"');
    expect(screenRecording).toContain('eventType: "screen_recording_keyframe"');
    expect(screenRecording).toContain(
      "screen_recording_keyframe_vision_processed",
    );
    expect(screenRecording).toContain("vision_provider");
    expect(screenRecording).toContain("transcriptSegments");
    expect(screenRecording).toContain("provisionalSteps");
    expect(screenRecording).toContain('source: "video_segmenter"');
    expect(screenRecording).toContain('evidenceLabel: "observed"');
    expect(screenRecording).toContain('evidenceLabel: "stated_operator"');
    expect(screenRecording).toContain("degraded_reasons");
    expect(screenRecording).toContain("screen_recording_upload_pipeline");
    expect(screenRecording).toContain("Review failed screen recording upload");
    expect(screenRecording).toContain("screen_recording_upload_failed");
    expect(screenRecording).toContain(
      "silent_screen_recording_requires_voice_follow_up",
    );
    expect(screenRecording).toContain("Schedule follow-up voice pass");
    expect(screenRecording).toContain("cleanupUploadedFrameObjects");
    expect(screenRecording).toContain("deleteArtifactObject");
    expect(screenRecording).toContain("frameObjectsPersisted");
    expect(screenRecordingAnalyzer).toContain("deepgram-prerecorded");
    expect(screenRecordingAnalyzer).toContain(
      "deepgram-prerecorded-local-audio",
    );
    expect(screenRecordingAnalyzer).toContain("demuxLocalUploadAudio");
    expect(screenRecordingAnalyzer).toContain('spawn("ffmpeg"');
    expect(screenRecordingAnalyzer).toContain("readLocalUpload");
    expect(screenRecordingAnalyzer).toContain("fetch(input.storageUrl)");
    expect(screenRecordingAnalyzer).toContain("extractFrameWithHash");
    expect(screenRecordingAnalyzer).toContain("frame extraction");
    expect(screenRecordingAnalyzer).toContain("frame hash extraction");
    expect(screenRecordingAnalyzer).toContain(
      "transcribeWithDeepgramAudioBytes",
    );
    expect(screenRecordingAnalyzer).toContain("deterministic-video-sampler");
    expect(screenRecordingAnalyzer).toContain("audio_demux_failed");
    expect(screenRecordingAnalyzer).toContain(
      "video_transcription_unavailable",
    );
    expect(screenRecordingAnalyzer).toContain(
      "keyframe_ocr_provider_not_configured",
    );
    expect(screenRecordingAnalyzer).toContain(
      "weakStepCandidatesFromKeyframes",
    );
    expect(screenRecordingAnalyzer).toContain("confidence: 0.32");
    expect(operatorRedaction).toContain("runOperatorRedaction");
    expect(operatorRedaction).toContain("deleteArtifactObject");
    expect(operatorRedaction).toContain("artifact_type IN ('video', 'audio')");
    expect(operatorRedaction).toContain("raw_capture_artifact_ids");
    expect(operatorRedaction).toContain("redaction_artifacts_deleted");
    expect(operatorRedaction).toContain("failed_storage_deletions");
    expect(operatorRedaction).toContain("UPDATE evidence");
    expect(operatorRedaction).toContain("UPDATE claim_evidence");
    expect(operatorRedaction).toContain("UPDATE claims");
    expect(operatorRedaction).toContain("removeRedactedEvidenceFromGraphRefs");
    expect(operatorRedaction).toContain("UPDATE process_nodes");
    expect(operatorRedaction).toContain("UPDATE process_edges");
    expect(operatorRedaction).toContain("UPDATE process_versions");
    expect(operatorRedaction).toContain("stripEvidenceIdsFromJson");
    expect(operatorRedaction).toContain("capture.operator.redaction_completed");
    expect(operatorRedaction).toContain(
      "REDACTION_FAILURE_FOLLOW_UP_DESCRIPTION",
    );
    expect(operatorRedaction).toContain('reason: "redaction_failed"');
    expect(operatorRedaction).toContain("internal_failure_detail");
    expect(storage).toContain("DeleteObjectCommand");
    expect(storage).toContain("deleteArtifactObject");
    expect(localUpload).toContain("deleteLocalUpload");
    expect(screenFrameVision).toContain("processOperatorScreenFrame");
    expect(screenFrameVision).toContain("operator.screen_frame_vision");
    expect(screenFrameVision).toContain("isNull(screenEvents.redactedAt)");
    expect(screenFrameVision).toContain("isNull(artifacts.redactedAt)");
    expect(screenFrameVision).toContain("screen_frame_not_found_or_redacted");
    expect(screenFrameVision).toContain("screen_vision_segmenter");
    expect(screenFrameVision).toContain("screen_keyframe_vision_processed");
    expect(screenFrameVision).toContain(
      "capture.operator.screen_frame_vision_processed",
    );
    expect(screenFrameRoute).toContain("Screen keyframe was saved");
    expect(screenFrameRoute).toContain("warning: backgroundWarning");
    expect(visionAdapter).toContain("analyzeScreenFrame");
    expect(visionAdapter).toContain("deriveScreenSignalTags");
    expect(visionAdapter).toContain("deterministic-screen-vision");
    expect(visionAdapter).toContain("copy_paste_between_systems");
    expect(visionAdapter).toContain("manual_search_or_filtering");
  });

  test("operator graph drafts render in workspace and can be approved", () => {
    const workspacePage = read("app/process/[id]/workspace/page.tsx");
    const workspaceClient = read(
      "app/process/[id]/workspace/WorkspaceClient.tsx",
    );
    const stepsTab = read("components/workspace/tabs/StepsTab.tsx");
    const summaryTab = read("components/workspace/tabs/SummaryTab.tsx");
    const insightsTab = read("components/workspace/tabs/InsightsTab.tsx");
    const riskTab = read("components/workspace/tabs/RiskTab.tsx");
    const followUpPresentation = read(
      "lib/processes/follow-up-presentation.ts",
    );
    const graphTypes = read("lib/types/graph.ts");
    const graphQueries = read("lib/processes/graph-queries.ts");
    const processQueries = read("lib/processes/queries.ts");
    const followUpQueries = read("lib/processes/follow-up-queries.ts");
    const evidenceQueries = read("lib/processes/evidence-queries.ts");
    const evidenceRoute = read(
      "app/api/processes/[processId]/evidence/route.ts",
    );
    const approveRoute = read(
      "app/api/processes/[processId]/versions/[versionId]/approve/route.ts",
    );

    expect(workspacePage).toContain("getCurrentProcessGraph");
    expect(workspacePage).toContain("getProcessGraphVersion");
    expect(workspacePage).toContain("getProcessGraphVersions");
    expect(workspacePage).toContain("getProcessFollowUps");
    expect(workspacePage).toContain("hasWorkspaceRole(auth, workspace.id");
    expect(workspacePage).toContain("getLatestWorkflowSemanticModelStatus");
    expect(workspacePage).toContain("Workflow map blocked");
    expect(workspacePage).toContain("semantic_workflow_not_publishable");
    expect(workspacePage).toContain("query.version");
    expect(workspacePage).toContain("followUps.filter(isRiskFollowUp)");
    expect(workspacePage).toContain("<WorkspaceClient");
    expect(workspacePage).toContain("Build the workflow map");
    expect(workspacePage).toContain("/capture/voice");
    expect(workspacePage).toContain("/capture/screenshare");
    expect(workspacePage).toContain("/capture/upload-video");
    expect(workspacePage).toContain("/capture/upload-document");
    expect(workspaceClient).toContain("workspaceId={workspaceId}");
    expect(workspaceClient).toContain("graphVersions");
    expect(workspaceClient).toContain("followUps={followUps}");
    expect(workspaceClient).toContain("graph={graph}");
    expect(workspacePage).toContain("canApproveDraft={canApproveDraft}");
    expect(workspaceClient).toContain("Version");
    expect(workspaceClient).toContain("?version=${versionId}");
    expect(workspaceClient).toContain("Approve Draft");
    expect(workspaceClient).toContain(
      'canApproveDraft && graph.status === "draft"',
    );
    expect(workspaceClient).toContain("/versions/${versionId}/approve");
    expect(stepsTab).toContain("View evidence");
    expect(stepsTab).toContain("NodeEvidenceDrawer");
    expect(stepsTab).toContain("versionId={graph?.version_id}");
    expect(stepsTab).toContain("StepDetails");
    expect(stepsTab).toContain("Exceptions");
    expect(stepsTab).toContain("Workarounds");
    expect(stepsTab).toContain("Variants");
    expect(stepsTab).toContain("/api/processes/${processId}/evidence");
    expect(stepsTab).toContain("Frame expired by retention policy");
    expect(stepsTab).toContain("evidence source");
    expect(stepsTab).toContain('params.set("version_id", versionId)');
    expect(summaryTab).toContain("version {graph?.version_number");
    expect(summaryTab).toContain("{graph.summary}");
    expect(summaryTab).toContain("Draft warnings");
    expect(summaryTab).toContain("Open follow-ups");
    expect(summaryTab).toContain("FollowUpSummaryItem");
    expect(summaryTab).toContain("followUpDescriptionForDisplay");
    expect(insightsTab).toContain("Generated narrative");
    expect(insightsTab).toContain("buildInsights");
    expect(insightsTab).toContain("Systems touched");
    expect(insightsTab).toContain("Workarounds");
    expect(insightsTab).toContain("Handoffs");
    expect(riskTab).toContain("Risk follow-ups");
    expect(riskTab).toContain("redaction_failure");
    expect(riskTab).toContain("contradiction|gap|low_confidence|redaction");
    expect(riskTab).toContain("followUpDescriptionForDisplay");
    expect(followUpPresentation).toContain(
      "REDACTION_FAILURE_FOLLOW_UP_DESCRIPTION",
    );
    expect(followUpPresentation).toContain("failed query");
    expect(followUpPresentation).toContain("params:");
    expect(graphTypes).toContain("summary?: string | null");
    expect(graphQueries).toContain("version_id: version.version_id");
    expect(graphQueries).toContain(
      'status: version.status === "approved" ? "approved" : "draft"',
    );
    expect(graphQueries).toContain("version_number: version.version_number");
    expect(graphQueries).toContain(
      "summary: cached.summary ?? version.summary",
    );
    expect(graphQueries).toContain("n.top_evidence_ids AS evidence_ids");
    expect(graphQueries).toContain("top_evidence_ids AS evidence_ids");
    expect(graphQueries).toContain("evidence_ids: row.evidence_ids ?? []");
    expect(graphQueries).toContain("validWarnings");
    expect(graphQueries).toContain("getProcessGraphVersions");
    expect(graphQueries).toContain("is_current_draft");
    expect(graphQueries).toContain("synthesis.operator.draft_published");
    expect(graphQueries).toContain("p.current_draft_version_id = pv.id");
    expect(processQueries).toContain(
      "COALESCE(p.current_draft_version_id, p.current_approved_version_id)",
    );
    expect(graphQueries).toContain("input_rows");
    expect(graphQueries).toContain("exception_rows");
    expect(graphQueries).toContain("sourceProvisionalStepIds");
    expect(followUpQueries).toContain("getProcessFollowUps");
    expect(followUpQueries).toContain("FROM follow_up_tasks");
    expect(followUpQueries).toContain("ORDER BY priority DESC");
    expect(evidenceQueries).toContain("getProcessEvidenceRows");
    expect(evidenceQueries).toContain("target_version");
    expect(evidenceQueries).toContain("requestedVersionId");
    expect(evidenceQueries).toContain("JOIN allowed_evidence");
    expect(evidenceQueries).toContain("synthesis.operator.draft_published");
    expect(evidenceQueries).toContain("a.artifact_type = 'screen_frame'");
    expect(evidenceQueries).toContain("screenshot_artifact_expired");
    expect(evidenceQueries).toContain("e.redacted_at IS NULL");
    expect(evidenceRoute).toContain(
      "ensureWorkspaceRole(auth, query.workspace_id",
    );
    expect(evidenceRoute).toContain('"viewer"');
    expect(evidenceRoute).toContain("versionId: query.version_id");
    expect(evidenceRoute).toContain("evidence_ids");
    expect(evidenceRoute).toContain("getProcessEvidenceRows");
    expect(approveRoute).toContain("process.version.approved");
    expect(
      approveRoute.indexOf("process.version.approve:${processId}:${versionId}"),
    ).toBeLessThan(
      approveRoute.indexOf("const cached = await getIdempotentResponse"),
    );
    expect(approveRoute).toContain("currentApprovedVersionId");
    expect(approveRoute).toContain("currentDraftVersionId: null");
    expect(approveRoute).toContain(
      "Only published draft process versions can be approved",
    );
    expect(approveRoute).toContain("synthesis.operator.draft_published");
    expect(approveRoute).toContain(
      'ensureWorkspaceRole(auth, body.workspace_id, ["director"])',
    );
  });

  test("synthesis handoff waits for completed operator graph runs", () => {
    const statusRoute = read("app/api/synthesis/status/route.ts");

    expect(statusRoute).toContain('latestRun?.status === "completed"');
    expect(statusRoute).toContain('latestRun?.status === "failed"');
    expect(statusRoute).toContain('latestRun?.status === "completed" &&');
    expect(statusRoute).toContain(
      "captureInventoryCount === null ? metrics.processCount > 0 : captureInventoryCount > 0",
    );
    expect(statusRoute).not.toContain(
      'latestRun?.status === "partial_synthesis" ||',
    );
    expect(statusRoute).not.toContain(
      'latestRun?.status === "partial_synthesis");',
    );
  });

  test("voice-only operator turns have split routes and write step evidence", () => {
    const schema = read("lib/interview/operator/schema.ts");
    const slotSchema = read("lib/interview/operator/slot-schema.ts");
    const jsonSchema = read("../schemas/operator-turn-plan.schema.json");
    const prompt = read("../prompts/operator.turn.plan.md");
    const voicePrompt = read("../prompts/operator.voice.phrase-intent.md");
    const probes = read("../probes/operator.yaml");
    const tools = read("lib/interview/operator/tools.ts");
    const transaction = read("lib/interview/operator/turn-transaction.ts");
    const brain = read("lib/interview/operator/brain.ts");
    const realtimeCore = read("lib/interview/_core/utterance.ts");
    const segmenter = read("lib/interview/operator/segmenter.ts");
    const operatorLayout = read("lib/synthesis/operator-layout.ts");
    const livekit = read("lib/adapters/livekit.ts");
    const aiModels = read("lib/ai/models.ts");
    const env = read("lib/env.ts");
    const frontendEnvExample = read(".env.example");
    const operatorEnvExample = read("../agents/operator/.env.example");
    const publicTurns = read(
      "app/api/operator-captures/[captureSessionId]/turns/route.ts",
    );
    const coverage = read(
      "app/api/operator-captures/[captureSessionId]/coverage/route.ts",
    );
    const ingest = read("app/api/internal/operator-turns/ingest/route.ts");
    const plan = read("app/api/internal/operator-turns/plan/route.ts");
    const dispatch = read("app/api/internal/operator-turns/dispatch/route.ts");
    const notice = read("app/api/internal/operator-turns/notice/route.ts");
    const delivery = read(
      "app/api/internal/operator-turns/[turnIndex]/delivery/route.ts",
    );
    const screenEvents = read(
      "app/api/internal/operator-screen-events/route.ts",
    );
    const screenFrames = read(
      "app/api/processes/[processId]/operator-captures/[captureSessionId]/screen-frames/route.ts",
    );
    const internalRedactions = read(
      "app/api/internal/operator-redactions/route.ts",
    );

    expect(schema).toContain("operatorTurnPlanSchema");
    expect(schema).toContain("planned_agent_utterance");
    expect(schema).toContain("operatorSlotDefinitions");
    expect(slotSchema).toContain("process.trigger");
    expect(slotSchema).toContain("process.happy_path_complete");
    expect(slotSchema).toContain("step.action_verb");
    expect(slotSchema).toContain("step.decision_criteria");
    expect(slotSchema).toContain("step.intentional_deviations");
    expect(slotSchema).toContain("step.what_makes_this_case_hard");
    expect(slotSchema).toContain("step.inputs_outputs");
    expect(slotSchema).toContain("operatorSlotScope");
    expect(jsonSchema).toContain('"OperatorTurnPlan"');
    expect(jsonSchema).toContain('"planned_agent_utterance"');
    expect(jsonSchema).not.toContain(
      '"chosen_intent",\n    "planned_agent_utterance"',
    );
    const operatorPlanPropertyOrder = Object.keys(
      JSON.parse(jsonSchema).properties,
    );
    expect(operatorPlanPropertyOrder.indexOf("chosen_intent")).toBeLessThan(
      operatorPlanPropertyOrder.indexOf("step_updates"),
    );
    expect(
      operatorPlanPropertyOrder.indexOf("planned_agent_utterance"),
    ).toBeLessThan(operatorPlanPropertyOrder.indexOf("step_updates"));
    expect(jsonSchema).toContain('"current_phase"');
    expect(jsonSchema).toContain('"happy_path"');
    expect(jsonSchema).toContain('"exception_sweep"');
    expect(jsonSchema).toContain('"step_updates"');
    expect(prompt).toContain("Operator Turn Planner");
    expect(prompt).toContain("sound like a calm workflow partner");
    expect(prompt).toContain("SOP/document chunks are documented evidence");
    expect(prompt).toContain("Live reconciliation signals are priority hints");
    expect(prompt).toContain("bypass normal probe cooldown");
    expect(voicePrompt).toContain("Operator Voice Phraser");
    expect(voicePrompt).toContain("Sound practical and curious");
    expect(voicePrompt).toContain("Return only Otto's next spoken sentence");
    expect(probes).toContain("agent: operator_workflow_mapper");
    expect(probes).toContain("intent: clarify_sop_contradiction");
    expect(tools).toContain("operatorToolSchemas");
    expect(tools).toContain("mark_step_boundary");
    expect(tools).toContain("record_handoff");
    expect(tools).toContain("flag_intentional_deviation");
    expect(tools).toContain("update_slot_state");
    expect(tools).toContain("request_redaction");
    expect(transaction).toContain('evidenceLabel: "stated_operator"');
    expect(transaction).toContain("insertOperatorProvisionalStep");
    expect(transaction).toContain("idempotencyKey: input.idempotencyKey");
    expect(transaction).toContain(".onConflictDoNothing()");
    expect(transaction).toContain(
      "Operator provisional step idempotency replay",
    );
    expect(transaction).toContain("upsertOperatorSlotState");
    expect(segmenter).toContain("stepCandidatesFromTranscript");
    expect(segmenter).toContain("stepCandidateFromScreenEvent");
    expect(segmenter).toContain("duplicate_data_entry");
    expect(segmenter).toContain("left_system_of_record");
    expect(operatorLayout).toContain("layoutOperatorGraph");
    expect(operatorLayout).toContain("operatorEdgeWaypoints");
    expect(brain).toContain("planOperatorTurnStreamed");
    expect(brain).toContain("structuredStream");
    expect(brain).toContain("scopedOperatorProvisionalStepId");
    expect(brain).toContain("operatorTurnPlanAnthropicToolSchema");
    expect(brain).toContain("operator_brain_llm");
    expect(brain).toContain("readOperatorPlanningContext");
    expect(brain).toContain("detectLiveReconciliationSignals");
    expect(brain).toContain("applyLiveReconciliationSignals");
    expect(brain).toContain("writeOperatorInterviewState");
    expect(brain).toContain("Phase machine");
    expect(brain).toContain("three_low_info_operator_turns");
    expect(brain).toContain("Operator interview forced close needs follow-up");
    expect(brain).toContain("executeOperatorToolCalls");
    expect(brain).toContain("parseOperatorToolCall");
    expect(brain).toContain("mark_step_boundary");
    expect(brain).toContain("operator-turn:${input.turnIndex}:step:${index}");
    expect(brain).toContain(
      "operator-turn:${input.input.turnIndex}:tool:${callIndex}:mark_step_boundary",
    );
    expect(brain).toContain("request_redaction");
    expect(brain).toContain("step.decision_criteria");
    expect(brain).toContain("step.intentional_deviations");
    expect(brain).toContain("operatorRedactionRequestedEventName");
    expect(brain).toContain("create_follow_up_gap");
    expect(brain).toContain("clarify_sop_contradiction");
    expect(brain).toContain("clarify_observed_workaround");
    expect(brain).toContain("stream_cutoff");
    expect(brain).toContain("deterministicOperatorTurnPlan");
    expect(brain).toContain("decisionStageName?: string");
    expect(brain).toContain('stageName: input.decisionStageName ?? "operator.turn"');
    expect(brain).toContain("planned_agent_utterance");
    expect(brain).toContain("llm_call_elided: options.llmCallElided ?? true");
    expect(brain).toContain("OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM");
    expect(brain).toContain("operator.voice.phrase-intent");
    expect(brain).toContain("separate_voice_llm");
    expect(brain).toContain("@/lib/interview/_core/utterance");
    expect(realtimeCore).toContain("limitToSingleQuestion");
    expect(aiModels).toContain("OPERATOR_BRAIN_MODEL");
    expect(aiModels).toContain("OPERATOR_VOICE_MODEL");
    expect(aiModels).toContain("OPERATOR_WORKFLOW_MODEL");
    expect(aiModels).toContain(
      'promptTemplateId.startsWith("operator.workflow_")',
    );
    expect(aiModels).toContain(
      'promptTemplateId.startsWith("operator.turn.plan")',
    );
    expect(aiModels).toContain(
      'promptTemplateId.startsWith("operator.voice.")',
    );
    expect(env).toContain("OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM");
    expect(env).toContain(
      "OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK",
    );
    expect(env).toContain("OPERATOR_BRAIN_MODEL");
    expect(env).toContain("OPERATOR_VOICE_MODEL");
    expect(env).toContain("OPERATOR_WORKFLOW_MODEL");
    expect(frontendEnvExample).toContain("OPERATOR_BRAIN_MODEL");
    expect(frontendEnvExample).toContain("OPERATOR_VOICE_MODEL");
    expect(frontendEnvExample).toContain("OPERATOR_WORKFLOW_MODEL");
    expect(frontendEnvExample).toContain(
      'OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM="false"',
    );
    expect(frontendEnvExample).toContain(
      'OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK="false"',
    );
    expect(operatorEnvExample).toContain("OPERATOR_BRAIN_MODEL");
    expect(operatorEnvExample).toContain("OPERATOR_VOICE_MODEL");
    expect(operatorEnvExample).toContain("OPERATOR_WORKFLOW_MODEL");
    expect(operatorEnvExample).toContain(
      'OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM="false"',
    );
    expect(operatorEnvExample).toContain(
      'OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK="false"',
    );

    expect(publicTurns).toContain("runOperatorTurn");
    expect(publicTurns).toContain("operator_interview");
    expect(publicTurns).toContain("clearPendingIdempotentRequest");
    expect(publicTurns).toContain("Preserve the original typed-turn error");
    expect(coverage).toContain("operatorSlotDefinitions");
    expect(coverage).toContain("priority_coverage");
    expect(coverage).toContain("provisional_step_count");
    expect(coverage).toContain("ensureWorkspaceRole(auth, query.workspace_id");
    expect(ingest).toContain("requireLiveKitAgentService");
    expect(ingest).toContain("ingestOperatorTurn");
    expect(plan).toContain("text/event-stream");
    expect(plan).toContain("planned_agent_utterance");
    expect(plan).toContain("planOperatorTurnStreamed");
    expect(plan).toContain("clearPendingIdempotentRequest");
    expect(plan).toContain("Plan stream failed.");
    expect(dispatch).toContain("dispatchOperatorTurnPlan");
    expect(dispatch).toContain("operatorTurnPlanSchema");
    expect(dispatch).toContain("clearPendingIdempotentRequest");
    expect(dispatch).toContain("pendingIdempotency");
    expect(dispatch).toContain("Preserve the original dispatch error");
    expect(notice).toContain("operator.notice.dispatch_failed_after_tts_start");
    expect(notice).toContain("writeAgentDecisionInTransaction");
    expect(notice).toContain("failed_text_fallback");
    expect(notice).toContain("dispatch_failed_after_tts_start");
    expect(delivery).toContain("updateOperatorTurnDelivery");
    expect(delivery).toContain("readTerminalOperatorTurnDelivery");
    expect(delivery).toContain("failed_text_fallback");
    expect(transaction).toContain("updateOperatorTurnDelivery");
    expect(screenEvents).toContain("requireLiveKitAgentService");
    expect(screenEvents).toContain("assertOperatorCaptureAcceptsTurns");
    expect(
      screenEvents.indexOf("const replay = await getIdempotentResponse"),
    ).toBeLessThan(
      screenEvents.indexOf("await assertOperatorCaptureAcceptsTurns"),
    );
    expect(
      screenEvents.indexOf("await assertOperatorCaptureAcceptsTurns"),
    ).toBeLessThan(
      screenEvents.indexOf("const cached = await reserveIdempotentRequest"),
    );
    expect(screenEvents).toContain("screenEvents");
    expect(screenEvents).toContain("provisionalSteps");
    expect(screenEvents).toContain("stepCandidateFromScreenEvent");
    expect(screenEvents).toContain('sourceType: "screen_event"');
    expect(screenEvents).toContain('evidenceLabel: "observed"');
    expect(screenEvents).toContain('source: "live_screen_segmenter"');
    expect(screenEvents).toContain("provisional_step");
    expect(screenEvents).toContain("signal_tags");
    expect(screenFrames).toContain('artifactType, "screen_frame"');
    expect(screenFrames).toContain("pg_advisory_xact_lock");
    expect(screenFrames).toContain("operator.screen_frame.capture");
    expect(screenFrames).toContain("screenshotArtifactId");
    expect(screenFrames).toContain("screen_frame_keyframe");
    expect(screenFrames).toContain("screen_keyframe_pending_vision");
    expect(screenFrames).toContain("operatorScreenFrameCapturedEventName");
    expect(screenFrames).toContain("shouldSendEvent: false");
    expect(screenFrames).toContain("shouldSendEvent: true");
    expect(screenFrames).toContain('source: "live_screen_segmenter"');
    expect(screenFrames).toContain("ttlAt");
    expect(internalRedactions).toContain("requireLiveKitAgentService");
    expect(internalRedactions).toContain("pg_advisory_xact_lock");
    expect(internalRedactions).toContain("operator.redaction.request");
    expect(internalRedactions).toContain("operatorRedactionRequestedEventName");
    expect(internalRedactions).toContain("redactionId");
    expect(internalRedactions).toContain('status: "pending"');
    expect(livekit).toContain("createOperatorRoomToken");
    expect(livekit).toContain("operatorAgentParticipantIdentity");
    expect(livekit).toContain("LIVEKIT_OPERATOR_AGENT_NAME");
    expect(livekit).toContain("TrackSource.SCREEN_SHARE");
  });

  test("live turn schemas accept absent planned utterance but reject blank strings", () => {
    const operatorToolSchema = operatorTurnPlanAnthropicToolSchema();
    const operatorPlan = {
      utterance_type: "substantive_answer",
      current_phase: "orient",
      proposed_next_phase: "happy_path",
      phase_transition_ready: true,
      ranked_intents: [intent("capture_next_step")],
      chosen_intent: intent("capture_next_step"),
    };
    const directorPlan = {
      utterance_type: "substantive_answer",
      slot_updates: [],
      claims: [],
      tool_calls: [],
      contradiction_signals: [],
      current_phase: "orient",
      proposed_next_phase: "inventory",
      phase_transition_ready: true,
      ranked_intents: [intent("discover_function")],
      chosen_intent: intent("discover_function"),
    };

    expect(operatorToolSchema.required).toContain("planned_agent_utterance");
    expect(
      operatorTurnPlanSchema.parse({
        ...operatorPlan,
        planned_agent_utterance: "Where does the next handoff happen?",
      }).planned_agent_utterance,
    ).toBe("Where does the next handoff happen?");
    expect(
      operatorTurnPlanSchema.parse(operatorPlan).planned_agent_utterance,
    ).toBeUndefined();
    expect(
      operatorTurnPlanSchema.safeParse({
        ...operatorPlan,
        planned_agent_utterance: "",
      }).success,
    ).toBe(false);

    expect(
      directorTurnPlanSchema.parse({
        ...directorPlan,
        planned_agent_utterance: "What part of the business do you oversee?",
      }).planned_agent_utterance,
    ).toBe("What part of the business do you oversee?");
    expect(
      directorTurnPlanSchema.parse(directorPlan).planned_agent_utterance,
    ).toBeUndefined();
    expect(
      directorTurnPlanSchema.safeParse({
        ...directorPlan,
        planned_agent_utterance: "",
      }).success,
    ).toBe(false);
  });

  test("operator LiveKit worker package targets split operator runtime", () => {
    const pyproject = read("../agents/operator/pyproject.toml");
    const worker = read("../agents/operator/operator_agent/worker.py");
    const agent = read("../agents/operator/operator_agent/agent.py");
    const api = read("../agents/operator/operator_agent/otto_api.py");
    const schemas = read("../agents/operator/operator_agent/schemas.py");
    const readme = read("../agents/operator/README.md");

    expect(pyproject).toContain("otto-operator-agent");
    expect(pyproject).toContain("operator_agent.worker:main");
    expect(pyproject).toContain("otto-realtime-core");
    expect(pyproject).toContain("../realtime_core");
    expect(worker).toContain('r"operator-([0-9a-fA-F-]{36})"');
    expect(worker).toContain("LIVEKIT_OPERATOR_AGENT_NAME");
    expect(worker).toContain("accept_operator_job");
    expect(worker).toContain("load_env_file_arg(sys.argv)");
    expect(worker).toContain('"--env-file"');
    expect(agent).toContain("OperatorWorkflowAgent");
    expect(agent).toContain("from otto_realtime_core import");
    expect(agent).toContain("on_planned_agent_utterance");
    expect(agent).toContain("self.session.say(spoken_utterance");
    expect(agent).toContain("superseded_before_dispatch");
    expect(agent).toContain('"truncated-before-dispatch"');
    expect(agent).toContain('"pre_tts_total_ms"');
    expect(agent).toContain("OPERATOR_DISPATCH_RETRY_DELAYS_SECONDS");
    expect(agent).toContain("OPERATOR_COMPLETION_RETRY_DELAYS_SECONDS");
    expect(agent).toContain("operator.session.completed");
    expect(agent).toContain("dispatch_failed_after_tts_start");
    expect(agent).toContain("record_notice");
    expect(agent).toContain("update_delivery");
    expect(agent).toContain('self._room.on("track_subscribed"');
    expect(agent).toContain("screen_share_track_subscribed");
    expect(agent).toContain("create_screen_event");
    expect(api).toContain("/api/internal/operator-turns/ingest");
    expect(api).toContain("/api/internal/operator-turns/plan");
    expect(api).toContain("/api/internal/operator-turns/dispatch");
    expect(api).toContain("/api/internal/operator-turns/notice");
    expect(api).toContain("/api/internal/operator-captures/complete");
    expect(api).toContain("record_notice");
    expect(api).toContain("/api/internal/operator-turns/{turn_index}/delivery");
    expect(api).toContain("/api/internal/operator-redactions");
    expect(api).toContain("/api/internal/operator-screen-events");
    expect(api).toContain("create_screen_event");
    expect(schemas).toContain("OperatorTurnPlan");
    expect(schemas).toContain("PlannedTurnResponse");
    expect(readme).toContain("planned_agent_utterance");
  });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function intent(name: string) {
  return {
    intent: name,
    score: 100,
    reason: "Test intent",
  };
}
