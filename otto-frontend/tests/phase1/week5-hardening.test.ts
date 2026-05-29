import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeForLogs,
  sanitizeJsonForLogs,
} from "@/lib/security/sanitize";
import { parseDocument } from "@/lib/adapters/document-parser";
import { localUploadUrl, writeLocalUpload } from "@/lib/adapters/local-upload";
import { validateDocumentUploadMetadata } from "@/lib/documents/validation";
import { chunkDocument } from "@/lib/documents/chunking";
import { normalizeSystemName } from "@/lib/documents/entity-normalization";

const root = process.cwd();

describe("Week 5 hardening contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LLAMAPARSE_API_KEY;
    delete process.env.LLAMAPARSE_API_URL;
    delete process.env.UNSTRUCTURED_API_KEY;
    delete process.env.UNSTRUCTURED_API_URL;
  });

  test("sanitizer redacts PII before diagnostic persistence", () => {
    const text =
      "Email alex@example.com, call (415) 555-1212, SSN 123-45-6789, card 4242 4242 4242 4242.";

    expect(sanitizeForLogs(text)).toBe(
      "Email [PII:email], call [PII:phone], SSN [PII:ssn], card [PII:card].",
    );
    expect(
      sanitizeJsonForLogs({
        utterance: text,
        diagnostic_id: "70707070-7070-5070-8070-707070707070",
        nested: ["owner is alex@example.com"],
      }),
    ).toEqual({
      utterance:
        "Email [PII:email], call [PII:phone], SSN [PII:ssn], card [PII:card].",
      diagnostic_id: "70707070-7070-5070-8070-707070707070",
      nested: ["owner is [PII:email]"],
    });
  });

  test("manual acceptance and visual smoke coverage include Week 5 surfaces", () => {
    const acceptance = read("docs/phase1-acceptance.md");
    const visualRoutes = read("tests/visual/routes.spec.ts");
    const visualScreenshots = read("tests/visual/screenshots.spec.ts");

    expect(acceptance).toContain("FDE Coverage And Telemetry");
    expect(acceptance).toContain("missing parser/vector/LLM vendor env");
    expect(visualRoutes).toContain('"/admin/coverage"');
    expect(visualScreenshots).toContain('"21-coverage"');
  });

  test("process evidence drawer calls the audit-logging evidence endpoint", () => {
    const drawer = read("components/workspace/EvidenceDrawer.tsx");
    const processPage = read("app/process/[id]/page.tsx");

    expect(drawer).toContain("/api/workspaces/${workspaceId}/evidence");
    expect(drawer).toContain("evidence_id=");
    expect(processPage).toContain("workspaceId={workspace.id}");
    expect(processPage).toContain("getWorkspaceForProcess(auth, id)");
    expect(processPage).toContain("overviewHref");
  });

  test("configured document parser paths call vendors instead of falling back to generated text", async () => {
    process.env.LLAMAPARSE_API_KEY = "llama-test-key";
    await expect(
      parseDocument({
        filename: "sample.pdf",
        mimeType: "application/pdf",
        storageKey: "sample.pdf",
      }),
    ).rejects.toThrow(/LlamaParse requires a public storage URL/);

    delete process.env.LLAMAPARSE_API_KEY;
    process.env.UNSTRUCTURED_API_KEY = "unstructured-test-key";
    process.env.UNSTRUCTURED_API_URL = "https://parser.example.test/general";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://files.example.test/sample.pdf") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return Response.json([
        {
          text: "Process: Promotion Management",
          metadata: { page_number: 1 },
        },
        {
          text: "Systems: Salesforce",
          metadata: { page_number: 1 },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const parsed = await parseDocument({
      filename: "sample.pdf",
      mimeType: "application/pdf",
      storageKey: "sample.pdf",
      storageUrl: "https://files.example.test/sample.pdf",
    });

    expect(parsed.metadata.parser).toBe("unstructured");
    expect(parsed.text).toContain("Promotion Management");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://parser.example.test/general",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "unstructured-api-key": "unstructured-test-key",
        }),
      }),
    );
  });

  test("document parser retries/falls back while preserving provider errors", async () => {
    process.env.LLAMAPARSE_API_KEY = "llama-test-key";
    process.env.LLAMAPARSE_API_URL = "https://parser.example.test/llama";
    process.env.UNSTRUCTURED_API_KEY = "unstructured-test-key";
    process.env.UNSTRUCTURED_API_URL = "https://parser.example.test/general";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://parser.example.test/llama") {
        return new Response("bad request", { status: 400 });
      }
      if (String(url) === "https://files.example.test/sample.pdf") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return Response.json([{ text: "Process: Saved By Unstructured" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const parsed = await parseDocument({
      filename: "sample.pdf",
      mimeType: "application/pdf",
      storageKey: "sample.pdf",
      storageUrl: "https://files.example.test/sample.pdf",
    });

    expect(parsed.metadata.parser).toBe("unstructured");
    expect(parsed.metadata.providerErrors?.[0]).toContain("llamaparse");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("local dev uploads parse the actual uploaded text bytes", async () => {
    const key = `tests/local-upload-${crypto.randomUUID()}.txt`;
    await writeLocalUpload({
      key,
      bytes: new TextEncoder().encode(
        [
          "Process: Renewal Review",
          "Owner: Revenue Operations",
          "Systems: SFDC, G Sheets",
        ].join("\n"),
      ).buffer,
      contentType: "text/plain",
    });

    const parsed = await parseDocument({
      filename: "renewals.txt",
      mimeType: "text/plain",
      storageKey: key,
      storageUrl: localUploadUrl(key),
    });

    expect(parsed.metadata.parser).toBe("local-text");
    expect(parsed.text).toContain("Renewal Review");
    expect(parsed.text).not.toContain("Promotion Management");
  });

  test("document upload validation rejects unsupported and oversized documents", () => {
    expect(() =>
      validateDocumentUploadMetadata({
        filename: "script.exe",
        mimeType: "application/x-msdownload",
        sizeBytes: 100,
        artifactType: "document",
      }),
    ).toThrow(/Unsupported document type/);

    expect(() =>
      validateDocumentUploadMetadata({
        filename: "large.txt",
        mimeType: "text/plain",
        sizeBytes: 26 * 1024 * 1024,
        artifactType: "document",
      }),
    ).toThrow(/Document is too large/);

    expect(() =>
      validateDocumentUploadMetadata({
        filename: "sample.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        artifactType: "document",
      }),
    ).toThrow(/requires configured document parsing/);

    expect(() =>
      validateDocumentUploadMetadata({
        filename: "unknown.txt",
        mimeType: "",
        artifactType: "document",
      }),
    ).toThrow(/Document size is required/);

    expect(
      validateDocumentUploadMetadata({
        filename: "notes.md",
        mimeType: "",
        sizeBytes: 100,
        artifactType: "document",
      }),
    ).toEqual({ mimeType: "text/markdown" });
  });

  test("entity normalization and chunking avoid reviewed edge cases", () => {
    expect(normalizeSystemName("excel report 2024")).toBe("Excel Report 2024");
    expect(normalizeSystemName("see microsoft excel")).toBe("See Microsoft Excel");
    expect(normalizeSystemName("Microsoft Excel")).toBe("Excel");
    expect(chunkDocument("   \n\t  ")).toEqual([]);
  });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}
