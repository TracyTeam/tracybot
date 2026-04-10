// Helper that splits a sorted list of lines into contiguous chunks
// e.g. [1,2,3,100,101] => [[1,2,3], [100,101]]
export function getContiguousChunks(lines: number[]): number[][] {
  if (lines.length === 0) { return []; }

  const sorted = [...lines].sort((a, b) => a - b);
  const chunks: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastChunk = chunks[chunks.length - 1];
    const lastLine = lastChunk[lastChunk.length - 1];

    // If this line is consecutive with the previous, add to current chunk
    if (current === lastLine + 1) {
      lastChunk.push(current);
    } else {
      // Otherwise start a new chunk
      chunks.push([current]);
    }
  }

  return chunks;
}