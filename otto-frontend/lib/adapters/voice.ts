import { withRetry, type RetryOptions } from "@/lib/adapters/retry";

export type Transcript = {
  text: string;
  confidence: number;
};

export async function transcribe(
  _stream: ReadableStream,
  opts: { prompt_template_id: string; retry?: RetryOptions },
): Promise<Transcript> {
  return withRetry(async () => {
    return {
      text: `[mock:${opts.prompt_template_id}]`,
      confidence: 1,
    };
  }, opts.retry);
}

