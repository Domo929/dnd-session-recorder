export interface Segment {
  text: string;
  startTime: number;
  endTime: number;
  speakerLabel: string | null;
}

export interface BuiltChunk {
  chunkIndex: number;
  startTime: number | null;
  endTime: number | null;
  speakerLabels: string[];
  text: string;
}

const DEFAULT_MAX_CHARS = 3000; // ~600-800 tokens

export function buildTranscriptChunks(
  segments: Segment[],
  opts: { maxChars?: number } = {},
): BuiltChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: BuiltChunk[] = [];
  let buf: Segment[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const speakers: string[] = [];
    for (const s of buf) {
      if (s.speakerLabel && !speakers.includes(s.speakerLabel)) speakers.push(s.speakerLabel);
    }
    chunks.push({
      chunkIndex: chunks.length,
      startTime: buf[0].startTime,
      endTime: buf[buf.length - 1].endTime,
      speakerLabels: speakers,
      text: buf.map((s) => s.text).join(' '),
    });
    buf = [];
    len = 0;
  };

  for (const s of segments) {
    if (len > 0 && len + s.text.length + 1 > maxChars) flush();
    buf.push(s);
    len += s.text.length + 1;
  }
  flush();
  return chunks;
}
