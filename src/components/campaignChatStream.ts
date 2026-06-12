export async function readTextStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    fullText += chunk;
    onChunk(chunk);
  }

  const trailingChunk = decoder.decode();
  if (trailingChunk) {
    fullText += trailingChunk;
    onChunk(trailingChunk);
  }

  return fullText;
}

export async function responseErrorMessage(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (response.status === 403 && typeof body.error === 'string') {
    return body.error;
  }
  if (typeof body.error === 'string') {
    return body.error;
  }
  return 'Failed to ask the campaign';
}
