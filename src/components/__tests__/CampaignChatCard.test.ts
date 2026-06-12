import { describe, expect, it } from 'vitest';
import { readTextStream, responseErrorMessage } from '../campaignChatStream';

describe('CampaignChatCard helpers', () => {
  it('reads streamed plain text chunks incrementally', async () => {
    const chunks: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('Hello'));
        controller.enqueue(new TextEncoder().encode(' adventurer'));
        controller.close();
      },
    });

    const result = await readTextStream(stream, (chunk) => chunks.push(chunk));

    expect(chunks).toEqual(['Hello', ' adventurer']);
    expect(result).toBe('Hello adventurer');
  });

  it('prefers JSON error text for forbidden responses', async () => {
    const response = new Response(JSON.stringify({ error: 'Owner access required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(responseErrorMessage(response)).resolves.toBe('Owner access required');
  });

  it('falls back when an error response is not JSON', async () => {
    const response = new Response('nope', { status: 500 });

    await expect(responseErrorMessage(response)).resolves.toBe('Failed to ask the campaign');
  });
});
