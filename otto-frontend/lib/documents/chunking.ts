import "server-only";

export type DocumentChunk = {
  ordinal: number;
  text: string;
  start: number;
  end: number;
};

export function normalizeDocumentText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/[ \u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function chunkDocument(text: string, targetChars = 1800, overlapChars = 180) {
  const normalized = normalizeDocumentText(text);
  if (!normalized) return [];

  const blocks = splitBlocks(normalized).flatMap((block) =>
    splitLargeBlock(block, targetChars),
  );
  const chunks: DocumentChunk[] = [];
  let buffer = "";
  let start = blocks[0]?.start ?? 0;
  let end = start;

  for (const block of blocks) {
    const next = buffer ? `${buffer}\n\n${block.text}` : block.text;
    if (buffer && next.length > targetChars) {
      chunks.push({ ordinal: chunks.length, text: buffer, start, end });
      const overlap = overlapTail(buffer, overlapChars);
      buffer = overlap ? `${overlap}\n\n${block.text}` : block.text;
      start = overlap ? Math.max(start, end - overlap.length) : block.start;
      end = block.end;
      continue;
    }
    buffer = next;
    end = block.end;
  }
  if (buffer) chunks.push({ ordinal: chunks.length, text: buffer, start, end });
  return chunks;
}

function splitBlocks(text: string) {
  const blocks: Array<{ text: string; start: number; end: number }> = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  let start = 0;
  let cursor = 0;
  let tableMode = false;

  const flush = (end: number) => {
    const value = buffer.join("\n").trim();
    if (value) blocks.push({ text: value, start, end });
    buffer = [];
    tableMode = false;
  };

  for (const line of lines) {
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    const trimmed = line.trim();
    const isTableLine = /\|.+\|/.test(trimmed);
    const isHeading = isLikelyHeading(trimmed);

    if (!trimmed) {
      flush(lineStart);
      cursor = lineEnd + 1;
      continue;
    }
    if (buffer.length && isHeading && !tableMode) {
      flush(lineStart);
    }
    if (!buffer.length) start = lineStart;
    if (tableMode && !isTableLine) flush(lineStart);
    buffer.push(line);
    tableMode = isTableLine;
    cursor = lineEnd + 1;
  }
  flush(text.length);
  return blocks;
}

function splitLargeBlock(
  block: { text: string; start: number; end: number },
  targetChars: number,
) {
  if (block.text.length <= targetChars) return [block];
  const parts: Array<{ text: string; start: number; end: number }> = [];
  const lines = block.text.split("\n");
  let buffer = "";
  let start = block.start;
  let cursor = block.start;

  for (const line of lines) {
    const next = buffer ? `${buffer}\n${line}` : line;
    if (buffer && next.length > targetChars) {
      parts.push({ text: buffer, start, end: cursor - 1 });
      start = cursor;
      buffer = line;
    } else {
      buffer = next;
    }
    cursor += line.length + 1;
  }
  if (buffer) parts.push({ text: buffer, start, end: block.end });
  return parts;
}

function isLikelyHeading(line: string) {
  return (
    /^#{1,6}\s+\S/.test(line) ||
    /^\d+(\.\d+)*[.)]\s+\S/.test(line) ||
    (/^[A-Z][A-Za-z0-9 /&-]{2,80}:?$/.test(line) && !/[.!?]$/.test(line))
  );
}

function overlapTail(text: string, maxChars: number) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const boundary = tail.search(/[.!?\n]\s+/);
  return boundary >= 0 ? tail.slice(boundary + 1).trim() : tail.trim();
}
