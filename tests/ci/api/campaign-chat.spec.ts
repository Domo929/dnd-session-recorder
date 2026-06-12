import { test, expect, Browser } from '@playwright/test';
import { AuthHelper } from '../../helpers/auth';

/**
 * Integration coverage for the campaign keyword search + RAG chat endpoints,
 * run against a real Postgres + pgvector testcontainer (see scripts/test-server.js
 * and tests/helpers/database.ts, both of which apply migrations with
 * `prisma migrate deploy`).
 *
 * The whole point of these tests is to exercise the raw SQL that the typed
 * Prisma client cannot model: the generated `text_search` tsvector column, the
 * GIN/HNSW indexes, the `vector` extension, and the `<=>` KNN operator. If the
 * schema were applied with `prisma db push` (schema.prisma only) those objects
 * would be missing and these routes would return 500 instead of 200 — so a
 * passing run is the regression guard for the migrate-deploy switch.
 *
 * Seeding a populated transcript is intentionally out of scope here: the CI
 * runner has no ffmpeg/audio fixtures and the Playwright process cannot reach
 * the server-owned container DB. The chunking -> embedding -> search/citation
 * logic is covered by the Vitest unit suites with mocked data. AI calls run
 * under MOCK_AI_SERVICES=true (set by playwright.config.ci.ts), so chat returns
 * a deterministic mock answer and no credits are spent.
 */
test.describe('Campaign search + chat (RAG) integration', () => {
  async function createCampaign(authedPage: import('@playwright/test').Page): Promise<string> {
    const res = await authedPage.request.post('/api/campaigns', {
      data: { name: `RAG Test ${Date.now()}-${Math.random()}`, description: 'integration' },
    });
    expect([200, 201]).toContain(res.status());
    const campaign = await res.json();
    expect(campaign).toHaveProperty('id');
    return campaign.id;
  }

  test('owner can reindex, search, and chat against real Postgres + pgvector', async ({ page }) => {
    const auth = new AuthHelper(page);
    await auth.createAndSignIn('rag-owner');

    const campaignId = await createCampaign(page);

    // Reindex: exercises the campaign_chunks write path. Empty campaign -> 0
    // sessions/chunks, but the route still runs against the real schema.
    const reindexRes = await page.request.post(`/api/campaigns/${campaignId}/reindex`);
    expect(reindexRes.status()).toBe(200);
    const reindexBody = await reindexRes.json();
    expect(reindexBody).toHaveProperty('indexed');
    expect(reindexBody).toHaveProperty('sessions');

    // Search: exercises the generated `text_search` column + websearch_to_tsquery
    // + ts_headline SQL. A 200 (even with empty results) proves the generated
    // column and GIN index exist.
    const searchRes = await page.request.get(
      `/api/campaigns/${campaignId}/search?q=amulet`,
    );
    expect(searchRes.status()).toBe(200);
    const searchBody = await searchRes.json();
    expect(Array.isArray(searchBody.results)).toBe(true);

    // Chat: exercises the pgvector KNN (`embedding <=> $vec::vector`) query and
    // the mock chat stream. A 200 streamed response proves the vector extension
    // and column are present.
    const chatRes = await page.request.post(`/api/campaigns/${campaignId}/chat`, {
      data: { messages: [{ role: 'user', content: 'What happened with the amulet?' }] },
    });
    expect(chatRes.status()).toBe(200);
    const chatText = await chatRes.text();
    expect(chatText.length).toBeGreaterThan(0);
  });

  test('empty question is rejected with 400', async ({ page }) => {
    const auth = new AuthHelper(page);
    await auth.createAndSignIn('rag-empty');
    const campaignId = await createCampaign(page);

    const res = await page.request.post(`/api/campaigns/${campaignId}/chat`, {
      data: { messages: [] },
    });
    expect(res.status()).toBe(400);
  });

  test('non-members get 404 from search, chat, and reindex', async ({
    page,
    browser,
  }: {
    page: import('@playwright/test').Page;
    browser: Browser;
  }) => {
    const ownerAuth = new AuthHelper(page);
    await ownerAuth.createAndSignIn('rag-private-owner');
    const campaignId = await createCampaign(page);

    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    try {
      const outsiderAuth = new AuthHelper(outsiderPage);
      await outsiderAuth.createAndSignIn('rag-outsider');

      const searchRes = await outsiderPage.request.get(
        `/api/campaigns/${campaignId}/search?q=test`,
      );
      expect(searchRes.status()).toBe(404);

      const chatRes = await outsiderPage.request.post(
        `/api/campaigns/${campaignId}/chat`,
        { data: { messages: [{ role: 'user', content: 'hi' }] } },
      );
      expect(chatRes.status()).toBe(404);

      const reindexRes = await outsiderPage.request.post(
        `/api/campaigns/${campaignId}/reindex`,
      );
      expect(reindexRes.status()).toBe(404);
    } finally {
      await outsiderContext.close();
    }
  });

  test('unauthenticated requests are rejected with 401', async ({ request }) => {
    const searchRes = await request.get('/api/campaigns/any-id/search?q=test');
    expect(searchRes.status()).toBe(401);

    const chatRes = await request.post('/api/campaigns/any-id/chat', {
      data: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chatRes.status()).toBe(401);
  });
});
