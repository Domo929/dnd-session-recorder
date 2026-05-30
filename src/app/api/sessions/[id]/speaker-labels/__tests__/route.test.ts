import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/database', () => ({ db: {} }));
vi.mock('@/lib/permissions', () => ({ requireSessionAccess: vi.fn() }));

import { db } from '@/services/database';
import { requireSessionAccess } from '@/lib/permissions';
import { GET, PUT } from '../route';

function getReq(id: string) {
  const req = new Request(`http://localhost/api/sessions/${id}/speaker-labels`) as unknown as Parameters<
    typeof GET
  >[0];
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

function putReq(id: string, body: unknown) {
  const req = new Request(`http://localhost/api/sessions/${id}/speaker-labels`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PUT>[0];
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db as unknown as Record<string, unknown>, {
    getSpeakerLabels: vi.fn(async () => ({ defaults: [], turns: [] })),
    getCampaignSpeakerRegistry: vi.fn(async () => ['Bruce', 'Alice']),
    upsertSpeakerLabels: vi.fn(async () => {}),
  });
  vi.mocked(requireSessionAccess).mockResolvedValue({
    ok: true,
    userId: 'u1',
    role: 'owner',
    campaignId: 'camp_1',
  } as never);
});

describe('GET /api/sessions/[id]/speaker-labels', () => {
  it('returns labels with canEdit for an owner', async () => {
    const { req, ctx } = getReq('s1');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ defaults: [], turns: [], canEdit: true });
  });

  it('marks canEdit false for a player', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: true,
      userId: 'u2',
      role: 'player',
      campaignId: 'camp_1',
    } as never);
    const { req, ctx } = getReq('s1');
    const json = await (await GET(req, ctx)).json();
    expect(json.canEdit).toBe(false);
  });

  it('propagates the access denial', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req, ctx } = getReq('s1');
    expect((await GET(req, ctx)).status).toBe(404);
  });
});

describe('PUT /api/sessions/[id]/speaker-labels', () => {
  it('requires owner access', async () => {
    vi.mocked(requireSessionAccess).mockResolvedValueOnce({
      ok: false,
      response: new Response('no', { status: 404 }),
    } as never);
    const { req, ctx } = putReq('s1', { defaults: [{ speakerKey: 'Speaker 1', name: 'Bruce' }] });
    expect((await PUT(req, ctx)).status).toBe(404);
    expect(db.upsertSpeakerLabels).not.toHaveBeenCalled();
  });

  it('rejects an empty update', async () => {
    const { req, ctx } = putReq('s1', {});
    expect((await PUT(req, ctx)).status).toBe(400);
    expect(db.upsertSpeakerLabels).not.toHaveBeenCalled();
  });

  it('canonicalizes names against the registry before saving', async () => {
    const { req, ctx } = putReq('s1', { defaults: [{ speakerKey: 'Speaker 1', name: 'bruce' }] });
    const res = await PUT(req, ctx);
    expect(res.status).toBe(200);
    const call = vi.mocked(db.upsertSpeakerLabels).mock.calls[0];
    expect(call[0]).toBe('s1');
    expect(call[1]).toBe('camp_1');
    expect(call[2].defaults).toEqual([{ speakerKey: 'Speaker 1', name: 'Bruce' }]);
  });

  it('passes a blank name through unchanged (clears the entry)', async () => {
    const { req, ctx } = putReq('s1', { turns: [{ turnIndex: 3, name: '' }] });
    const res = await PUT(req, ctx);
    expect(res.status).toBe(200);
    const call = vi.mocked(db.upsertSpeakerLabels).mock.calls[0];
    expect(call[2].turns).toEqual([{ turnIndex: 3, name: '' }]);
  });
});
