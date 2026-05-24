import { withRetry, type RetryOptions } from "@/lib/adapters/retry";
import { getServerEnv } from "@/lib/env";

export type EmbeddingProvider = "voyage" | "openai" | "lexical-fallback";

export type EmbeddingResult = {
  embedding: number[];
  provider: EmbeddingProvider;
  lexicalFallback: boolean;
  providerErrors?: string[];
};

export async function embedText(opts: {
  prompt_template_id: string;
  text: string;
  dimensions?: number;
  retry?: RetryOptions;
}) {
  const result = await embedTextWithMetadata(opts);
  return result.embedding;
}

export async function embedTextWithMetadata(opts: {
  prompt_template_id: string;
  text: string;
  dimensions?: number;
  retry?: RetryOptions;
}): Promise<EmbeddingResult> {
  return withRetry(async () => {
    const env = getServerEnv();
    const errors: string[] = [];
    if (env.VOYAGE_API_KEY) {
      try {
        return await embedVoyage(opts.text);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    if (env.OPENAI_API_KEY) {
      try {
        return await embedOpenAI(opts.text);
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    return lexicalEmbedding(opts.text, opts.dimensions, errors);
  }, opts.retry);
}

export async function embedBatch(opts: {
  prompt_template_id: string;
  texts: string[];
  dimensions?: number;
  retry?: RetryOptions;
}): Promise<EmbeddingResult[]> {
  return Promise.all(
    opts.texts.map((text) =>
      embedTextWithMetadata({
        prompt_template_id: opts.prompt_template_id,
        text,
        dimensions: opts.dimensions,
        retry: opts.retry,
      }),
    ),
  );
}

async function embedVoyage(text: string): Promise<EmbeddingResult> {
  const env = getServerEnv();
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model: "voyage-3",
    }),
  });
  if (!response.ok) {
    throw new Error(`Voyage embedding request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = body.data?.[0]?.embedding;
  if (!embedding) throw new Error("Voyage embedding response was empty.");
  return { embedding, provider: "voyage", lexicalFallback: false };
}

async function embedOpenAI(text: string): Promise<EmbeddingResult> {
  const env = getServerEnv();
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-large",
      dimensions: 1536,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embedding request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = body.data?.[0]?.embedding;
  if (!embedding) throw new Error("OpenAI embedding response was empty.");
  return { embedding, provider: "openai", lexicalFallback: false };
}

function lexicalEmbedding(
  text: string,
  dimensions = 1536,
  errors: string[] = [],
): EmbeddingResult {
  const seed = Array.from(text).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return {
    embedding: Array.from(
      { length: dimensions },
      (_, i) => ((seed + i) % 997) / 997,
    ),
    provider: "lexical-fallback",
    lexicalFallback: true,
    ...(errors.length > 0 ? { providerErrors: errors } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
