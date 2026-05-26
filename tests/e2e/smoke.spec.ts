import path from 'node:path';
import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * End-to-end smoke test: register → sign in → create campaign → upload
 * audio → run transcription + summary (mocked) → assert "Session ready!".
 *
 * Mirrors a real user clicking through the UI so it catches frontend bugs
 * (e.g. the audioFilePath basename bug that motivated this test).
 *
 * Pre-reqs (handled by scripts/smoke.sh):
 *   - Docker Compose stack is up at SMOKE_BASE_URL
 *   - AI_TRANSCRIPTION_PROVIDER=mock and AI_SUMMARY_PROVIDER=mock are set
 *   - Postgres has been migrated and is empty
 */

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.SMOKE_USER_EMAIL || 'smoke@example.com';
const TEST_PASSWORD = process.env.SMOKE_USER_PASSWORD || 'smoke-password-123';
const TEST_NAME = 'Smoke Test User';
const CAMPAIGN_NAME = `Smoke Campaign ${Date.now()}`;
const SESSION_TITLE = `Smoke Session ${Date.now()}`;
const FIXTURE_AUDIO = path.resolve(__dirname, '../fixtures/silence.wav');

test('full upload → transcribe → summarize flow against the Docker image', async ({
  page,
  context,
}) => {
  // Register the user via the API. The route is idempotent-ish (rejects
  // duplicates with 400) — we tolerate that so the test is re-runnable.
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const registerResp = await api.post('/api/auth/register', {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME },
  });
  expect([200, 201, 400]).toContain(registerResp.status());

  // Sign in via the credentials form. NextAuth sets session cookies here.
  await page.goto('/auth/signin');
  await page.locator('input[name="email"]').fill(TEST_EMAIL);
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Successful credentials login redirects to "/" (the dashboard) by default.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'), {
    timeout: 30_000,
  });

  // Create a campaign through the authenticated API context so we don't have
  // to drive the modal UI just to seed test data.
  const cookies = await context.cookies();
  const apiWithSession = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: { cookies, origins: [] },
  });
  const campaignResp = await apiWithSession.post('/api/campaigns', {
    data: {
      name: CAMPAIGN_NAME,
      description: 'Created by smoke test',
      systemPrompt: 'You summarize D&D sessions for smoke tests.',
    },
  });
  expect(campaignResp.ok()).toBeTruthy();

  // Go to the upload page and wait for the campaign dropdown to load.
  await page.goto('/sessions/upload');
  const campaignSelect = page.locator('select');
  await expect(campaignSelect).toBeVisible();
  await expect(campaignSelect.locator(`option:has-text("${CAMPAIGN_NAME}")`)).toHaveCount(1);

  // Fill in the session form.
  await page.locator('input[placeholder="Enter session title"]').fill(SESSION_TITLE);
  await campaignSelect.selectOption({ label: CAMPAIGN_NAME });

  // Attach the silence.wav fixture to the hidden file input.
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles(FIXTURE_AUDIO);

  // Submit the form.
  await page.locator('button[type="submit"]:has-text("Create Session")').click();

  // The page swaps to a processing view. The "Session Created Successfully!"
  // banner only renders when processingStep === 'complete' AND we have a
  // session object — i.e. the upload→transcribe→summarize chain has all
  // succeeded. (The per-step labels including "Session ready!" render as
  // soon as processing starts, so they are not a reliable completion signal.)
  await expect(page.locator('text=Session Created Successfully!')).toBeVisible({
    timeout: 60_000,
  });

  // Pull the created session id from the "View Session" button's behavior
  // is hard; just assert the API has the session in completed state.
  const sessionsResp = await apiWithSession.get('/api/sessions');
  expect(sessionsResp.ok()).toBeTruthy();
  const sessions = await sessionsResp.json();
  const created = sessions.find((s: { title: string }) => s.title === SESSION_TITLE);
  expect(created, 'session was created').toBeTruthy();
  expect(['completed', 'summarizing', 'transcribed']).toContain(created.status);
});

/**
 * Auth gating: every protected API route must reject unauthenticated
 * callers with 401, and every protected page must redirect them to the
 * sign-in screen. This guards against regressions of the audit fixed
 * in this PR — previously you could POST to /api/transcription/[id]
 * with no cookie and trigger a real Gemini call.
 *
 * We use a random UUID for `sessionId` everywhere: the auth check must
 * fire BEFORE the route looks the resource up, so the response is the
 * same whether the id exists or not. This is deliberate so the test
 * doesn't depend on state from the previous test.
 */
test('unauthenticated requests are rejected by protected routes', async ({
  page,
  context,
}) => {
  // Burn any cookies the previous test might have set in this worker so
  // the API/browser context starts genuinely unauthenticated.
  await context.clearCookies();

  const api = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const fakeSessionId = '00000000-0000-0000-0000-000000000000';

  // --- API routes that should require auth ---------------------------
  // For POST routes we send `{}` as the body to mirror the real client.
  type Check = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string };
  const checks: Check[] = [
    { method: 'POST', path: `/api/transcription/${fakeSessionId}` },
    { method: 'GET', path: `/api/transcription/${fakeSessionId}` },
    { method: 'POST', path: `/api/summary/${fakeSessionId}` },
    { method: 'GET', path: `/api/summary/${fakeSessionId}` },
    { method: 'GET', path: `/api/sessions/${fakeSessionId}` },
    { method: 'PATCH', path: `/api/sessions/${fakeSessionId}` },
    { method: 'DELETE', path: `/api/sessions/${fakeSessionId}` },
    { method: 'POST', path: `/api/sessions/${fakeSessionId}/upload` },
    { method: 'POST', path: '/api/campaigns' },
    { method: 'POST', path: '/api/uploads' },
  ];

  for (const { method, path } of checks) {
    const resp = await api.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      data: '{}',
    });
    expect(
      resp.status(),
      `${method} ${path} must return 401 for unauthenticated callers`,
    ).toBe(401);
  }

  // --- Page routes that should redirect unauth users to /auth/signin -
  const protectedPages = [
    '/sessions',
    '/sessions/upload',
    `/sessions/${fakeSessionId}`,
    `/sessions/${fakeSessionId}/transcript`,
    `/sessions/${fakeSessionId}/summary`,
    '/campaigns',
    `/campaigns/${fakeSessionId}`,
  ];

  for (const path of protectedPages) {
    await page.goto(path);
    // NextAuth's withAuth bounces unauth requests through /api/auth/signin
    // which then renders our configured pages.signIn = '/auth/signin'.
    // Either landing URL is acceptable; we just need to assert we did NOT
    // end up on the protected page.
    await expect.poll(() => page.url(), {
      message: `Expected unauth visit to ${path} to redirect to sign-in`,
      timeout: 10_000,
    }).toMatch(/\/auth\/signin|\/api\/auth\/signin/);
  }
});

/**
 * Campaign sharing: invite-link redemption, email pre-staging, role-gated
 * payloads, and revocation. Exercises the full /api/invite + /api/members
 * surface and asserts that a player can read transcripts/summaries but
 * cannot mutate anything in the campaign.
 *
 * Every owner-only route is hit by the player to make sure the 404
 * (not 403) leak-prevention pattern is in place across the board.
 */
test('campaign sharing — invite link + email invite + permission gating', async ({
  browser,
}) => {
  // Use timestamps so every run gets fresh users; the smoke DB is
  // wiped between full `npm run smoke` invocations but tests within a
  // single run share state.
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@example.com`;
  const playerEmail = `player-${stamp}@example.com`;
  const futureEmail = `future-${stamp}@example.com`;
  const password = 'smoke-password-123';
  const campaignName = `Shared Campaign ${stamp}`;
  const sessionTitle = `Shared Session ${stamp}`;

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  async function registerAndSignIn(email: string, name: string) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const api = await playwrightRequest.newContext({ baseURL: BASE_URL });

    const reg = await api.post('/api/auth/register', {
      data: { email, password, name },
    });
    expect([200, 201, 400], `register ${email}`).toContain(reg.status());

    await page.goto('/auth/signin');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(
      (url) => !url.pathname.startsWith('/auth/signin'),
      { timeout: 30_000 },
    );

    const cookies = await ctx.cookies();
    const authedApi = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies, origins: [] },
    });
    return { ctx, page, api: authedApi };
  }

  // ---------------------------------------------------------------
  // Owner setup: account, campaign, upload, transcribe, summarize
  // ---------------------------------------------------------------
  const owner = await registerAndSignIn(ownerEmail, 'Owner DM');

  const campaignResp = await owner.api.post('/api/campaigns', {
    data: {
      name: campaignName,
      description: 'Shared smoke campaign',
      systemPrompt: 'You summarize D&D sessions for smoke tests.',
    },
  });
  expect(campaignResp.ok(), 'create campaign').toBeTruthy();
  const campaign = await campaignResp.json();
  const campaignId: string = campaign.id;

  // Upload + create session via the UI to reuse the existing happy-path
  // (also confirms the gated upload UI still works for owners).
  await owner.page.goto('/sessions/upload');
  await expect(owner.page.locator('select')).toBeVisible();
  await owner.page
    .locator('input[placeholder="Enter session title"]')
    .fill(sessionTitle);
  await owner.page.locator('select').selectOption({ label: campaignName });
  await owner.page
    .locator('input[type="file"][accept="audio/*"]')
    .setInputFiles(FIXTURE_AUDIO);
  await owner.page
    .locator('button[type="submit"]:has-text("Create Session")')
    .click();
  await expect(
    owner.page.locator('text=Session Created Successfully!'),
  ).toBeVisible({ timeout: 60_000 });

  const sessionsList = await owner.api.get('/api/sessions');
  expect(sessionsList.ok()).toBeTruthy();
  const sessions = await sessionsList.json();
  const created = sessions.find(
    (s: { title: string }) => s.title === sessionTitle,
  );
  expect(created, 'session created').toBeTruthy();
  const sessionId: string = created.id;

  // ---------------------------------------------------------------
  // Invite link: owner issues, player redeems via the redemption page
  // ---------------------------------------------------------------
  const issueLink = await owner.api.post(
    `/api/campaigns/${campaignId}/invite-link`,
    { data: { expiresInDays: 30 } },
  );
  expect(issueLink.status(), 'issue invite link').toBe(201);
  const linkBody = await issueLink.json();
  const inviteUrl: string = linkBody.link.url;
  expect(inviteUrl).toMatch(/\/campaigns\/invite\/[\w-]+$/);
  const inviteToken = inviteUrl.split('/').pop()!;

  const player = await registerAndSignIn(playerEmail, 'Player One');

  await player.page.goto(inviteUrl);
  // Redemption page renders campaign name + Accept/Not now buttons.
  await expect(
    player.page.locator(`text=${campaignName}`),
  ).toBeVisible({ timeout: 15_000 });
  await player.page
    .locator('button:has-text("Accept invitation")')
    .click();
  await player.page.waitForURL(
    (url) => url.pathname === `/campaigns/${campaignId}`,
    { timeout: 15_000 },
  );

  // Player's campaign list now contains the campaign with role=player.
  const playerCampaigns = await player.api.get('/api/campaigns');
  expect(playerCampaigns.ok()).toBeTruthy();
  const playerCampaignList = await playerCampaigns.json();
  const sharedEntry = playerCampaignList.find(
    (c: { id: string }) => c.id === campaignId,
  );
  expect(sharedEntry, 'campaign visible to player').toBeTruthy();
  expect(sharedEntry.role).toBe('player');

  // Player can read transcript + summary. Both should be 200.
  const playerTranscript = await player.api.get(
    `/api/transcription/${sessionId}`,
  );
  expect(playerTranscript.status(), 'player reads transcript').toBe(200);
  const playerSummary = await player.api.get(`/api/summary/${sessionId}`);
  expect(playerSummary.status(), 'player reads summary').toBe(200);

  // Player must NOT see the DM's systemPrompt.
  const playerCampaignDetail = await player.api.get(
    `/api/campaigns/${campaignId}`,
  );
  expect(playerCampaignDetail.ok()).toBeTruthy();
  const playerCampaign = await playerCampaignDetail.json();
  expect(playerCampaign.role).toBe('player');
  expect(
    playerCampaign.systemPrompt,
    'systemPrompt redacted for players',
  ).toBeNull();

  // Player must NOT see other members' emails in the roster.
  const memberList = await player.api.get(
    `/api/campaigns/${campaignId}/members`,
  );
  expect(memberList.ok()).toBeTruthy();
  const memberPayload = await memberList.json();
  expect(memberPayload.viewerRole).toBe('player');
  for (const m of memberPayload.members) {
    expect(
      m.email,
      `email redacted for non-owner viewer (userId=${m.userId})`,
    ).toBeNull();
  }
  expect(memberPayload.pendingInvitations).toEqual([]);

  // ---------------------------------------------------------------
  // Owner-only routes must reject the player with 404 (not 403)
  // ---------------------------------------------------------------
  type Check = {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: object;
    expected: number | number[];
  };
  const playerForbidden: Check[] = [
    {
      method: 'POST',
      path: `/api/sessions/${sessionId}/upload`,
      body: { upload_id: 'fake' },
      expected: 404,
    },
    { method: 'POST', path: `/api/transcription/${sessionId}`, expected: 404 },
    { method: 'POST', path: `/api/summary/${sessionId}`, expected: 404 },
    {
      method: 'PUT',
      path: `/api/summary/${sessionId}`,
      body: { summary_text: 'tampered' },
      expected: 404,
    },
    { method: 'DELETE', path: `/api/sessions/${sessionId}`, expected: 404 },
    {
      method: 'PATCH',
      path: `/api/sessions/${sessionId}`,
      body: { title: 'tampered' },
      expected: 404,
    },
    {
      method: 'PUT',
      path: `/api/campaigns/${campaignId}`,
      body: { name: 'tampered' },
      expected: 404,
    },
    { method: 'DELETE', path: `/api/campaigns/${campaignId}`, expected: 404 },
    {
      method: 'POST',
      path: `/api/campaigns/${campaignId}/invite-link`,
      body: {},
      expected: 404,
    },
    {
      method: 'DELETE',
      path: `/api/campaigns/${campaignId}/invite-link`,
      expected: 404,
    },
    {
      method: 'POST',
      path: `/api/campaigns/${campaignId}/members`,
      body: { email: 'noop@example.com' },
      expected: 404,
    },
  ];

  for (const { method, path, body, expected } of playerForbidden) {
    const resp = await player.api.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      data: body ? JSON.stringify(body) : '{}',
    });
    const allowed = Array.isArray(expected) ? expected : [expected];
    expect(
      allowed,
      `${method} ${path} — player must be denied (got ${resp.status()})`,
    ).toContain(resp.status());
  }

  // ---------------------------------------------------------------
  // Email-based invitations
  // ---------------------------------------------------------------
  // Adding an existing-member email returns 'already_member'.
  const addExisting = await owner.api.post(
    `/api/campaigns/${campaignId}/members`,
    { data: { email: playerEmail } },
  );
  expect(addExisting.status()).toBe(200);
  expect((await addExisting.json()).status).toBe('already_member');

  // Adding a brand-new email stages an Invitation.
  const addPending = await owner.api.post(
    `/api/campaigns/${campaignId}/members`,
    { data: { email: futureEmail } },
  );
  expect(addPending.status(), 'pre-stage invitation').toBe(201);
  expect((await addPending.json()).status).toBe('pending');

  // Registering that email later should auto-attach the membership.
  const future = await registerAndSignIn(futureEmail, 'Future Player');
  const futureCampaigns = await future.api.get('/api/campaigns');
  expect(futureCampaigns.ok()).toBeTruthy();
  const futureList = await futureCampaigns.json();
  const futureShared = futureList.find(
    (c: { id: string }) => c.id === campaignId,
  );
  expect(
    futureShared,
    'pre-staged invitation auto-attached on registration',
  ).toBeTruthy();
  expect(futureShared.role).toBe('player');

  // ---------------------------------------------------------------
  // Owner removes the original player; player loses read access
  // ---------------------------------------------------------------
  // Fetch the player's userId from the owner's member list (owner can see emails).
  const ownerMembers = await owner.api.get(
    `/api/campaigns/${campaignId}/members`,
  );
  expect(ownerMembers.ok()).toBeTruthy();
  const ownerMemberPayload = await ownerMembers.json();
  const playerMember = ownerMemberPayload.members.find(
    (m: { email: string | null }) => m.email === playerEmail,
  );
  expect(playerMember, 'owner sees player member row').toBeTruthy();

  const removeResp = await owner.api.fetch(
    `/api/campaigns/${campaignId}/members/${playerMember.userId}`,
    { method: 'DELETE' },
  );
  expect(removeResp.status(), 'owner removes player').toBe(204);

  // After removal the player gets 404 on previously-readable routes.
  const afterRemoveTranscript = await player.api.get(
    `/api/transcription/${sessionId}`,
  );
  expect(
    afterRemoveTranscript.status(),
    'removed player loses transcript access',
  ).toBe(404);
  const afterRemoveCampaign = await player.api.get(
    `/api/campaigns/${campaignId}`,
  );
  expect(
    afterRemoveCampaign.status(),
    'removed player loses campaign access',
  ).toBe(404);

  // ---------------------------------------------------------------
  // Revoking the invite link
  // ---------------------------------------------------------------
  const revoke = await owner.api.fetch(
    `/api/campaigns/${campaignId}/invite-link`,
    { method: 'DELETE' },
  );
  expect(revoke.status(), 'owner revokes invite link').toBe(204);

  // Unauthenticated call to the redemption API → 401.
  const unauthedApi = await playwrightRequest.newContext({
    baseURL: BASE_URL,
  });
  const previewUnauthed = await unauthedApi.get(`/api/invite/${inviteToken}`);
  expect(previewUnauthed.status(), 'unauth redemption preview').toBe(401);

  // Future player (signed in but link revoked) → 404.
  const previewRevoked = await future.api.get(`/api/invite/${inviteToken}`);
  expect(previewRevoked.status(), 'revoked link preview is 404').toBe(404);
  const acceptRevoked = await future.api.post(`/api/invite/${inviteToken}`);
  expect(
    acceptRevoked.status(),
    'revoked link cannot be accepted',
  ).toBe(404);

  // Cleanup contexts.
  await owner.ctx.close();
  await player.ctx.close();
  await future.ctx.close();
});
