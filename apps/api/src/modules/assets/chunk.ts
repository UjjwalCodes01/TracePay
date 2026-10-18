/**
 * Splits source content into retrievable passages: one per paragraph, with
 * long paragraphs broken at sentence boundaries so every chunk stays citable.
 */
export const MAX_CHUNK_CHARS = 900;

export function chunkContent(content: string): string[] {
  const paragraphs = content
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_CHUNK_CHARS) {
      chunks.push(p);
      continue;
    }
    let current = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      // A single over-long "sentence" is hard-wrapped.
      for (let i = 0; i < sentence.length; i += MAX_CHUNK_CHARS) {
        const piece = sentence.slice(i, i + MAX_CHUNK_CHARS);
        if (current && current.length + 1 + piece.length > MAX_CHUNK_CHARS) {
          chunks.push(current);
          current = piece;
        } else {
          current = current ? `${current} ${piece}` : piece;
        }
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}
