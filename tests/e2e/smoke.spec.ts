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
