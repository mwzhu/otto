import "server-only";

import { readLocalUpload, localUploadKeyFromUrl } from "@/lib/adapters/local-upload";
import { withRetry } from "@/lib/adapters/retry";
import { isLocallyTextParsable } from "@/lib/documents/validation";
import { getServerEnv } from "@/lib/env";

export type ParsedDocument = {
  text: string;
  metadata: {
    parser: "llamaparse" | "unstructured" | "local-text";
    pageCount?: number;
    jobId?: string;
    providerErrors?: string[];
  };
};

export async function parseDocument(input: {
  filename: string;
  mimeType: string;
  storageKey: string;
  storageUrl?: string | null;
}): Promise<ParsedDocument> {
  const env = getServerEnv();
  const providerErrors: string[] = [];
  const textParsed = await parseTextUpload(input, providerErrors);
  if (textParsed) return textParsed;
  if (env.LLAMAPARSE_API_KEY) {
    try {
      return await parseWithLlamaParse(
        input,
        env.LLAMAPARSE_API_KEY,
        env.LLAMAPARSE_API_URL,
      );
    } catch (error) {
      providerErrors.push(errorMessage("llamaparse", error));
    }
  }
  if (env.UNSTRUCTURED_API_KEY) {
    try {
      return await parseWithUnstructured(
        input,
        env.UNSTRUCTURED_API_KEY,
        env.UNSTRUCTURED_API_URL,
        providerErrors,
      );
    } catch (error) {
      providerErrors.push(errorMessage("unstructured", error));
    }
  }
  if (providerErrors.length > 0) {
    throw new Error(`Document parser failed: ${providerErrors.join("; ")}`);
  }
  throw new Error(
    `No parser is configured for ${input.mimeType}. Use TXT, Markdown, CSV, or JSON, or configure LlamaParse/Unstructured.`,
  );
}

async function parseWithLlamaParse(
  input: {
    filename: string;
    mimeType: string;
    storageKey: string;
    storageUrl?: string | null;
  },
  apiKey: string,
  apiUrl = "https://api.cloud.llamaindex.ai/api/v2/parse",
): Promise<ParsedDocument> {
  if (!input.storageUrl) {
    throw new Error("LlamaParse requires a public storage URL for Phase 1 parsing.");
  }
  const created = await fetchJson<LlamaParseCreateResponse>(apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source_url: input.storageUrl,
      tier: "fast",
      version: "latest",
      output_options: { markdown: {} },
      client_name: "otto-phase-1",
    }),
  });
  const jobId = created.id ?? created.job?.id;
  if (!jobId) {
    throw new Error("LlamaParse did not return a parse job id.");
  }

  const resultUrl = `${apiUrl.replace(/\/$/, "")}/${jobId}?expand=markdown&expand=text&expand=job_metadata`;
  const completed = await pollParseJob(resultUrl, apiKey, "llamaparse");
  const text = extractLlamaParseText(completed);
  if (!text.trim()) {
    throw new Error("LlamaParse completed without text output.");
  }
  return {
    text,
    metadata: {
      parser: "llamaparse",
      pageCount: extractLlamaParsePageCount(completed, text),
      jobId,
    },
  };
}

async function parseWithUnstructured(
  input: {
    filename: string;
    mimeType: string;
    storageKey: string;
    storageUrl?: string | null;
  },
  apiKey: string,
  apiUrl = "https://api.unstructuredapp.io/general/v0/general",
  providerErrors: string[] = [],
): Promise<ParsedDocument> {
  if (!input.storageUrl) {
    throw new Error("Unstructured requires a public storage URL for Phase 1 parsing.");
  }
  const sourceResponse = await fetchOkWithRetry(input.storageUrl);
  const file = new Blob([await sourceResponse.arrayBuffer()], {
    type: input.mimeType,
  });
  const form = new FormData();
  form.set("files", file, input.filename);
  form.set("content_type", input.mimeType);
  form.set("strategy", "auto");
  form.set("output_format", "application/json");

  const elements = await fetchJson<UnstructuredElement[]>(apiUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "unstructured-api-key": apiKey,
    },
    body: form,
  });
  const text = elements
    .map((element) => element.text?.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text.trim()) {
    throw new Error("Unstructured completed without text output.");
  }
  const pages = new Set(
    elements
      .map((element) => element.metadata?.page_number)
      .filter((page): page is number => typeof page === "number"),
  );
  return {
    text,
    metadata: {
      parser: "unstructured",
      pageCount: pages.size || Math.max(1, Math.ceil(text.length / 2400)),
      providerErrors,
    },
  };
}

async function pollParseJob(
  url: string,
  apiKey: string,
  parserName: string,
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = await fetchJson<LlamaParseGetResponse>(url, {
      headers: { authorization: `Bearer ${apiKey}` },
    }, { retry: false });
    const status = body.job?.status ?? body.status;
    if (status === "COMPLETED") return body;
    if (status === "FAILED" || status === "CANCELLED") {
      throw new Error(
        `${parserName} parse job ${status.toLowerCase()}: ${
          body.job?.error_message ?? body.error_message ?? "unknown error"
        }`,
      );
    }
    await sleep(1000);
  }
  throw new Error(`${parserName} parse job timed out.`);
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  options: { retry?: boolean } = {},
): Promise<T> {
  const response =
    options.retry === false ? await fetchOkOnce(url, init) : await fetchOkWithRetry(url, init);
  return response.json() as Promise<T>;
}

async function fetchOkWithRetry(url: string, init?: RequestInit) {
  return withRetry(async () => {
    const response = await fetch(url, init);
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    throw new Error(
      `Document parser request failed: ${response.status}${body ? ` ${body}` : ""}`,
    );
  }, {
    maxAttempts: 4,
    classify: (error) => {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      return isFatalHttpMessage(message)
        ? "fatal"
        : "unknown";
    },
  });
}

async function fetchOkOnce(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new Error(
    `Document parser request failed: ${response.status}${body ? ` ${body}` : ""}`,
  );
}

async function parseTextUpload(
  input: {
    filename: string;
    mimeType: string;
    storageKey: string;
    storageUrl?: string | null;
  },
  providerErrors: string[],
): Promise<ParsedDocument | null> {
  if (!isLocallyTextParsable(input.mimeType)) {
    return null;
  }
  const localKey = localUploadKeyFromUrl(input.storageUrl);
  const bytes = localKey
    ? (await readLocalUpload(localKey)).bytes
    : await readPublicUploadBytes(input.storageUrl);
  if (!bytes) return null;
  const text = normalizeExtractedText(
    new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  );
  if (!text.trim()) {
    throw new Error("Uploaded text document contained no text.");
  }
  return {
    text,
    metadata: {
      parser: "local-text",
      pageCount: Math.max(1, Math.ceil(text.length / 2400)),
      providerErrors,
    },
  };
}

async function readPublicUploadBytes(storageUrl?: string | null) {
  if (!storageUrl) return null;
  const response = await fetchOkWithRetry(storageUrl);
  return response.arrayBuffer();
}

function extractLlamaParseText(body: LlamaParseGetResponse) {
  return (
    textValue(body.markdown) ??
    textValue(body.text) ??
    body.items?.pages
      ?.flatMap((page) => page.items ?? [])
      .map((item) => item.md ?? item.value ?? "")
      .filter(Boolean)
      .join("\n\n") ??
    ""
  );
}

function extractLlamaParsePageCount(body: LlamaParseGetResponse, text: string) {
  return (
    body.job_metadata?.page_count ??
    body.items?.pages?.length ??
    Math.max(1, Math.ceil(text.length / 2400))
  );
}

function textValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExtractedText(text: string) {
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

function errorMessage(provider: string, error: unknown) {
  return `${provider}: ${error instanceof Error ? error.message : String(error)}`;
}

function isFatalHttpMessage(message: string) {
  return /^document parser request failed:\s*(400|401|403|404|413|415|422)\b/.test(
    message,
  );
}

type LlamaParseCreateResponse = {
  id?: string;
  job?: { id?: string };
};

type LlamaParseGetResponse = {
  status?: string;
  error_message?: string;
  job?: {
    id?: string;
    status?: string;
    error_message?: string;
  };
  markdown?: unknown;
  text?: unknown;
  job_metadata?: { page_count?: number };
  items?: {
    pages?: Array<{
      items?: Array<{ md?: string; value?: string }>;
    }>;
  };
};

type UnstructuredElement = {
  text?: string;
  metadata?: {
    page_number?: number;
  };
};
