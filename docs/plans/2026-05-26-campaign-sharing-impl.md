# Campaign Sharing Implementation Plan

> **For the executor:** REQUIRED SUB-SKILL: Use `executing-plans` (or `subagent-driven-development`) to implement this plan task-by-task. Commit after every task. Run `npm run lint` after every task — it must finish with exit code 0 (warnings are OK; the baseline has warnings). After major phases, run `npm run build`.

**Goal:** Add read-only player sharing to campaigns: a revocable invite link any player can redeem, plus add-by-email (auto-attach on signup), with strict ownership-vs-player permission gating on every existing route and UI affordance.

**Architecture:** New `Member` table makes every user-campaign relationship explicit with a `role` column ('owner' or 'player'); `Campaign.userId` becomes `createdBy` (audit only). New `InviteLink` (hashed token) and `Invitation` (pending-by-email) tables back the two share mechanisms. A new `src/lib/permissions.ts` is the single source of truth for access checks; every existing API route migrates to it. A new `attachPendingInvitations` helper runs on register and every signin to upgrade pending email invitations to memberships.

**Tech Stack:** Next.js 15 App Router, Prisma 5, PostgreSQL, NextAuth (JWT strategy), bcryptjs, zod, Playwright (smoke), Node `crypto` for tokens.

**Design doc:** `docs/plans/2026-05-26-campaign-sharing-design.md` — read it before starting.

**Branch:** `feat/campaign-sharing` (this worktree).

---

## Phase 0 — Pre-flight

### Task 0.1: Verify baseline

**Steps:**
1. Run `npm run lint` and confirm it exits 0 (warnings allowed).
2. Run `npx prisma generate` to make sure the client is current.
3. Run `npx prisma migrate status` to verify migrations are in sync.
4. Read `docs/plans/2026-05-26-campaign-sharing-design.md` end to end.
5. No commit.

---

## Phase 1 — Data model

### Task 1.1: Update Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

**Steps:**

1. In `model User`, replace `campaigns Campaign[]` with two relations:
   ```prisma
     campaignsCreated Campaign[]    @relation("CampaignCreatedBy")
     members          Member[]
   ```

2. Replace the entire `model Campaign` block (lines 72–86 currently) with:
   ```prisma
   model Campaign {
     id           String           @id @default(cuid())
     name         String
     description  String?
     systemPrompt String?          @map("system_prompt")
     createdBy    String           @map("created_by")
     createdAt    DateTime         @default(now()) @map("created_at")
     updatedAt    DateTime         @updatedAt @map("updated_at")

     creator        User            @relation("CampaignCreatedBy", fields: [createdBy], references: [id], onDelete: Restrict)
     members        Member[]
     gamingSessions GamingSession[]
     inviteLinks    InviteLink[]
     invitations    Invitation[]

     @@unique([createdBy, name])
     @@map("campaigns")
   }
   ```

3. Append three new models at the bottom of the file (after `Upload`):
   ```prisma
   model Member {
     id         String   @id @default(cuid())
     campaignId String   @map("campaign_id")
     userId     String   @map("user_id")
     role       String
     invitedBy  String?  @map("invited_by")
     joinedAt   DateTime @default(now()) @map("joined_at")

     campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
     user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@unique([campaignId, userId])
     @@index([userId])
     @@index([campaignId, role])
     @@map("members")
   }

   model InviteLink {
     id         String    @id @default(cuid())
     campaignId String    @map("campaign_id")
     tokenHash  String    @unique @map("token_hash")
     createdBy  String    @map("created_by")
     createdAt  DateTime  @default(now()) @map("created_at")
     expiresAt  DateTime? @map("expires_at")
     revokedAt  DateTime? @map("revoked_at")

     campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

     @@index([campaignId])
     @@map("invite_links")
   }

   model Invitation {
     id         String    @id @default(cuid())
     campaignId String    @map("campaign_id")
     email      String
     invitedBy  String    @map("invited_by")
     createdAt  DateTime  @default(now()) @map("created_at")
     acceptedAt DateTime? @map("accepted_at")

     campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

     @@unique([campaignId, email])
     @@index([email])
     @@map("invitations")
   }
   ```

4. Run `npx prisma format` to canonicalize.
5. Run `npx prisma validate` to check the schema parses.

**Do not generate the migration yet — that's the next task.**

### Task 1.2: Generate the migration

**Files:**
- Create: `prisma/migrations/<timestamp>_campaign_sharing/migration.sql` (auto-generated, then hand-edited)

**Steps:**

1. Ensure Postgres is up locally: `docker compose up -d postgres` from repo root.
2. Verify `.env`/`.env.local` has `DATABASE_URL` pointing at the local Postgres.
3. Run:
   ```bash
   npx prisma migrate dev --create-only --name campaign_sharing
   ```
   This will fail or generate a migration that drops `campaigns_user_id_name_key` and the `user_id` column, recreating things — Prisma cannot infer the rename + member seed by itself.
4. **Replace the generated `migration.sql` entirely** with this hand-written version (Prisma will accept it because we're using `--create-only`):

   ```sql
   -- Step 1: Rename Campaign.user_id to Campaign.created_by (preserves data)
   ALTER TABLE "campaigns" RENAME COLUMN "user_id" TO "created_by";

   -- Step 2: Drop the old unique + FK so we can recreate with new name + onDelete
   ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_user_id_fkey";
   ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_user_id_name_key";

   ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_name_key" UNIQUE ("created_by", "name");
   ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_fkey"
     FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

   -- Step 3: Create members table
   CREATE TABLE "members" (
     "id" TEXT NOT NULL,
     "campaign_id" TEXT NOT NULL,
     "user_id" TEXT NOT NULL,
     "role" TEXT NOT NULL,
     "invited_by" TEXT,
     "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

     CONSTRAINT "members_pkey" PRIMARY KEY ("id")
   );

   CREATE UNIQUE INDEX "members_campaign_id_user_id_key" ON "members"("campaign_id", "user_id");
   CREATE INDEX "members_user_id_idx" ON "members"("user_id");
   CREATE INDEX "members_campaign_id_role_idx" ON "members"("campaign_id", "role");

   ALTER TABLE "members" ADD CONSTRAINT "members_campaign_id_fkey"
     FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey"
     FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

   -- Step 4: Seed owner Member rows for every existing campaign
   INSERT INTO "members" ("id", "campaign_id", "user_id", "role", "invited_by", "joined_at")
   SELECT
     'mig_' || "id",
     "id",
     "created_by",
     'owner',
     NULL,
     "created_at"
   FROM "campaigns";

   -- Step 5: Create invite_links table
   CREATE TABLE "invite_links" (
     "id" TEXT NOT NULL,
     "campaign_id" TEXT NOT NULL,
     "token_hash" TEXT NOT NULL,
     "created_by" TEXT NOT NULL,
     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "expires_at" TIMESTAMP(3),
     "revoked_at" TIMESTAMP(3),

     CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
   );

   CREATE UNIQUE INDEX "invite_links_token_hash_key" ON "invite_links"("token_hash");
   CREATE INDEX "invite_links_campaign_id_idx" ON "invite_links"("campaign_id");

   ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_campaign_id_fkey"
     FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

   -- Step 6: Create invitations table
   CREATE TABLE "invitations" (
     "id" TEXT NOT NULL,
     "campaign_id" TEXT NOT NULL,
     "email" TEXT NOT NULL,
     "invited_by" TEXT NOT NULL,
     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "accepted_at" TIMESTAMP(3),

     CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
   );

   CREATE UNIQUE INDEX "invitations_campaign_id_email_key" ON "invitations"("campaign_id", "email");
   CREATE INDEX "invitations_email_idx" ON "invitations"("email");

   ALTER TABLE "invitations" ADD CONSTRAINT "invitations_campaign_id_fkey"
     FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   ```

5. Apply the migration: `npx prisma migrate dev` (no name; it picks up the existing one).
6. Run `npx prisma generate`.
7. Run `npm run lint`. Expected: exit 0. (Warnings OK.)
8. Run `npx tsc --noEmit` to confirm the Prisma client types compile. **This will surface every place that references `Campaign.userId` — those are the routes you'll migrate in Phase 4.** Note the errors but do NOT fix them yet; the helper from Phase 2 will be the migration target.

   Expected errors include: `src/services/database.ts` (the `getCampaigns` `where: { userId }`, the `createCampaign` `userId`), `src/app/api/campaigns/route.ts`, `src/app/api/campaigns/[id]/route.ts`, `src/app/api/sessions/route.ts`, `src/app/api/sessions/[id]/route.ts`, `src/app/api/sessions/[id]/upload/route.ts`, `src/app/api/transcription/[sessionId]/route.ts`, `src/app/api/summary/[sessionId]/route.ts`.

9. **Commit:**
   ```bash
   git add prisma/schema.prisma prisma/migrations/
   git commit -m "feat(db): add Member, InviteLink, Invitation; rename Campaign.userId to createdBy"
   ```

---

## Phase 2 — Permission helper

### Task 2.1: Create permission helper

**Files:**
- Create: `src/lib/permissions.ts`

**Steps:**

1. Create `src/lib/permissions.ts`:
   ```ts
   import { NextResponse } from 'next/server';
   import { getServerSession } from 'next-auth';
   import { authOptions } from '@/lib/auth';
   import { prisma } from '@/lib/prisma';

   export type CampaignRole = 'owner' | 'player';
   export type AccessLevel = 'any' | 'owner';

   /**
    * Returns the user's role on the campaign, or null if they have no
    * membership. Owner-or-player are the only roles today; future roles
    * (co-DM, etc) would be added here.
    */
   export async function getCampaignAccess(
     userId: string,
     campaignId: string,
   ): Promise<CampaignRole | null> {
     const member = await prisma.member.findUnique({
       where: { campaignId_userId: { campaignId, userId } },
       select: { role: true },
     });
     if (!member) return null;
     if (member.role === 'owner' || member.role === 'player') {
       return member.role;
     }
     return null;
   }

   export type RequireAccessResult =
     | { ok: true; userId: string; role: CampaignRole }
     | { ok: false; response: NextResponse };

   /**
    * One-stop access check for API routes. Always:
    *   - 401 if not signed in
    *   - 404 if no membership (do not leak existence)
    *   - 404 if level='owner' and role='player' (same — do not leak)
    *
    * Usage:
    *   const access = await requireCampaignAccess(campaignId, 'owner');
    *   if (!access.ok) return access.response;
    *   // access.userId, access.role are available here
    */
   export async function requireCampaignAccess(
     campaignId: string,
     level: AccessLevel,
   ): Promise<RequireAccessResult> {
     const session = await getServerSession(authOptions);
     if (!session?.user?.id) {
       return {
         ok: false,
         response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
       };
     }
     const role = await getCampaignAccess(session.user.id, campaignId);
     if (!role) {
       return {
         ok: false,
         response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
       };
     }
     if (level === 'owner' && role !== 'owner') {
       return {
         ok: false,
         response: NextResponse.json({ error: 'Not found' }, { status: 404 }),
       };
     }
     return { ok: true, userId: session.user.id, role };
   }
   ```

2. **Commit:**
   ```bash
   git add src/lib/permissions.ts
   git commit -m "feat(permissions): add getCampaignAccess + requireCampaignAccess helper"
   ```

---

## Phase 3 — attachPendingInvitations + signin/register integration

### Task 3.1: Create attachPendingInvitations helper

**Files:**
- Create: `src/lib/invitations.ts`

**Steps:**

1. Create `src/lib/invitations.ts`:
   ```ts
   import { prisma } from '@/lib/prisma';

   /**
    * Sweep pending Invitation rows for `email` and convert each into a
    * Member row for `userId`. Idempotent — safe to call on every signin.
    *
    * Returns the number of pending invitations consumed (0 on a cold path).
    */
   export async function attachPendingInvitations(
     userId: string,
     email: string | null | undefined,
   ): Promise<number> {
     if (!email) return 0;
     const normalized = email.trim().toLowerCase();
     if (!normalized) return 0;

     const pending = await prisma.invitation.findMany({
       where: { email: normalized, acceptedAt: null },
     });
     if (pending.length === 0) return 0;

     await prisma.$transaction([
       ...pending.map((inv) =>
         prisma.member.upsert({
           where: {
             campaignId_userId: { campaignId: inv.campaignId, userId },
           },
           create: {
             campaignId: inv.campaignId,
             userId,
             role: 'player',
             invitedBy: inv.invitedBy,
           },
           update: {},
         }),
       ),
       prisma.invitation.updateMany({
         where: { id: { in: pending.map((i) => i.id) } },
         data: { acceptedAt: new Date() },
       }),
     ]);

     console.log(
       `[invitations] attached ${pending.length} pending invitation(s) for ${normalized}`,
     );
     return pending.length;
   }
   ```

2. **Commit:**
   ```bash
   git add src/lib/invitations.ts
   git commit -m "feat(invitations): add attachPendingInvitations sweep helper"
   ```

### Task 3.2: Wire register route to attachPendingInvitations

**Files:**
- Modify: `src/app/api/auth/register/route.ts`

**Steps:**

1. Import the helper at the top:
   ```ts
   import { attachPendingInvitations } from '@/lib/invitations';
   ```
2. After `prisma.user.create({ … })` returns `user`, add:
   ```ts
   // Auto-attach any pending email invitations so the new user lands in
   // every campaign they were invited to before signing up.
   try {
     await attachPendingInvitations(user.id, user.email);
   } catch (err) {
     console.error('[register] attachPendingInvitations failed:', err);
     // Non-fatal: registration still succeeds; user can sign in and the
     // signIn event will retry the sweep.
   }
   ```
3. Run `npm run lint`. Expected: exit 0.
4. **Commit:**
   ```bash
   git add src/app/api/auth/register/route.ts
   git commit -m "feat(auth): attach pending invitations on register"
   ```

### Task 3.3: Wire NextAuth signIn event to attachPendingInvitations

**Files:**
- Modify: `src/lib/auth.ts`

**Steps:**

1. Add an import at the top:
   ```ts
   import { attachPendingInvitations } from '@/lib/invitations';
   ```
2. In `events.signIn` (currently just logs), append the sweep AFTER the log:
   ```ts
   events: {
     async signIn({ user, account, profile, isNewUser }) {
       console.log('SignIn event - Success:', { user, account, profile, isNewUser });
       try {
         if (user?.id && user.email) {
           await attachPendingInvitations(user.id, user.email);
         }
       } catch (err) {
         console.error('[auth.signIn] attachPendingInvitations failed:', err);
       }
     },
     // …existing events unchanged
   },
   ```
3. Run `npm run lint`. Expected: exit 0.
4. **Commit:**
   ```bash
   git add src/lib/auth.ts
   git commit -m "feat(auth): attach pending invitations on every sign-in"
   ```

---

## Phase 4 — Migrate existing routes to permission helper

> **Strategy:** these tasks unblock the type errors from Task 1.2. Do them in order. After every task, run `npx tsc --noEmit` and verify the count of remaining errors strictly decreases. After the whole phase, `npx tsc --noEmit` must exit 0.

### Task 4.1: Migrate database service

**Files:**
- Modify: `src/services/database.ts`

**Steps:**

1. In `interface CreateCampaignData`, rename the field `userId` → `createdBy` AND rename it consistently in `createCampaign` (`data.createdBy`) and `updateCampaign`.

2. Replace `createCampaign` to also insert the owner `Member` row in a transaction:
   ```ts
   async createCampaign(data: CreateCampaignData): Promise<Campaign> {
     return prisma.$transaction(async (tx) => {
       const campaign = await tx.campaign.create({
         data: {
           name: data.name,
           description: data.description,
           systemPrompt: data.systemPrompt,
           createdBy: data.createdBy,
         },
       });
       await tx.member.create({
         data: {
           campaignId: campaign.id,
           userId: data.createdBy,
           role: 'owner',
         },
       });
       return campaign;
     });
   }
   ```

3. Replace `getCampaigns` to filter by membership instead of `userId`:
   ```ts
   async getCampaigns(userId?: string): Promise<(Campaign & {
     _count: { gamingSessions: number };
     role?: 'owner' | 'player';
   })[]> {
     if (!userId) {
       return prisma.campaign.findMany({
         orderBy: { createdAt: 'desc' },
         include: { _count: { select: { gamingSessions: true } } },
       });
     }
     // Pull only campaigns the user is a Member of, and annotate role.
     const memberships = await prisma.member.findMany({
       where: { userId },
       select: { role: true, campaignId: true },
     });
     if (memberships.length === 0) return [];
     const byCampaign = new Map(memberships.map((m) => [m.campaignId, m.role as 'owner' | 'player']));
     const campaigns = await prisma.campaign.findMany({
       where: { id: { in: [...byCampaign.keys()] } },
       orderBy: { createdAt: 'desc' },
       include: { _count: { select: { gamingSessions: true } } },
     });
     return campaigns.map((c) => ({ ...c, role: byCampaign.get(c.id) }));
   }
   ```

4. Replace `getSessions` to filter via Member rather than `campaign.userId`:
   ```ts
   async getSessions(userId?: string, campaignId?: string): Promise<SessionListItem[]> {
     return prisma.gamingSession.findMany({
       where: {
         ...(userId && { campaign: { members: { some: { userId } } } }),
         ...(campaignId && { campaignId }),
       },
       include: {
         campaign: { select: { name: true } },
         _count: { select: { transcriptions: true } },
         summary: { select: { id: true } },
       },
       orderBy: [{ sessionDate: 'desc' }, { createdAt: 'desc' }],
     });
   }
   ```

5. Replace `getSessionStats` similarly:
   ```ts
   async getSessionStats(userId?: string): Promise<{
     totalSessions: number;
     completedSessions: number;
     totalCampaigns: number;
   }> {
     const where = userId
       ? { campaign: { members: { some: { userId } } } }
       : undefined;
     const campaignWhere = userId
       ? { members: { some: { userId } } }
       : undefined;

     const [totalSessions, completedSessions, totalCampaigns] = await Promise.all([
       prisma.gamingSession.count({ where }),
       prisma.gamingSession.count({ where: { ...where, status: 'completed' } }),
       prisma.campaign.count({ where: campaignWhere }),
     ]);

     return { totalSessions, completedSessions, totalCampaigns };
   }
   ```

6. Run `npx tsc --noEmit`. Expected: remaining errors are now in `src/app/api/**` only.

7. **Commit:**
   ```bash
   git add src/services/database.ts
   git commit -m "refactor(db): use Member for campaign access; createCampaign seeds owner"
   ```

### Task 4.2: Migrate `/api/campaigns` routes

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Modify: `src/app/api/campaigns/[id]/route.ts`

**Steps for `route.ts` (collection):**

1. In `POST`, change `userId: session.user.id` to `createdBy: session.user.id`.
2. `GET` already passes `session.user.id` — keep as is; `db.getCampaigns` now does the right thing.

**Steps for `[id]/route.ts`:**

1. Add import: `import { requireCampaignAccess } from '@/lib/permissions';`
2. In `GET`, replace the body with:
   ```ts
   const { id } = await params;
   const access = await requireCampaignAccess(id, 'any');
   if (!access.ok) return access.response;
   const campaign = await db.getCampaignById(id);
   if (!campaign) {
     return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
   }
   // Players don't see DM systemPrompt (it may contain spoilers/notes).
   const payload = access.role === 'owner'
     ? { ...campaign, role: access.role }
     : { ...campaign, systemPrompt: null, role: access.role };
   return NextResponse.json(payload);
   ```
3. In `PUT`, replace the body's auth/ownership block with:
   ```ts
   const { id } = await params;
   const access = await requireCampaignAccess(id, 'owner');
   if (!access.ok) return access.response;
   const body = await request.json();
   const validatedData = updateCampaignSchema.parse(body);
   const updatedCampaign = await db.updateCampaign(id, { ... });
   return NextResponse.json(updatedCampaign);
   ```
4. Same pattern for `DELETE` with `'owner'`.
5. Run `npm run lint`. Expected: exit 0.
6. Run `npx tsc --noEmit`. Expected: error count decreased.
7. **Commit:**
   ```bash
   git add src/app/api/campaigns
   git commit -m "refactor(api/campaigns): use requireCampaignAccess; redact systemPrompt for players"
   ```

### Task 4.3: Migrate `/api/sessions` routes

**Files:**
- Modify: `src/app/api/sessions/route.ts`
- Modify: `src/app/api/sessions/[id]/route.ts`

**Steps for `route.ts` (collection):**

1. `GET` is fine: `db.getSessions` now filters by Member.
2. In `POST`, replace the campaign ownership check with `requireCampaignAccess(validatedData.campaign_id, 'owner')`:
   ```ts
   const access = await requireCampaignAccess(validatedData.campaign_id, 'owner');
   if (!access.ok) return access.response;
   ```
   Keep the existing upload-ownership check (`upload.userId !== session.user.id`) — uploads remain per-user. To get `session.user.id` after switching to `requireCampaignAccess`, capture it from `access.userId`.

**Steps for `[id]/route.ts`:**

1. Add import: `import { requireCampaignAccess } from '@/lib/permissions';`
2. Replace `resolveOwnedSession` with a new helper:
   ```ts
   async function resolveSessionAccess(
     sessionId: string,
     level: 'any' | 'owner',
   ) {
     const session = await db.getSessionById(sessionId);
     if (!session) {
       return {
         error: NextResponse.json({ error: 'Session not found' }, { status: 404 }),
       };
     }
     const access = await requireCampaignAccess(session.campaignId, level);
     if (!access.ok) return { error: access.response };
     return { session, role: access.role, userId: access.userId };
   }
   ```
3. `GET` → call with `'any'`.
4. `PATCH` → `'owner'`.
5. `DELETE` → `'owner'`.
6. Run `npm run lint` + `npx tsc --noEmit`. Both must pass / show fewer errors.
7. **Commit:**
   ```bash
   git add src/app/api/sessions
   git commit -m "refactor(api/sessions): use requireCampaignAccess; players can read, owners can write"
   ```

### Task 4.4: Migrate `/api/sessions/[id]/upload`

**Files:**
- Modify: `src/app/api/sessions/[id]/upload/route.ts`

**Steps:**

1. Import `requireCampaignAccess`.
2. In all three handlers (`POST`, `PUT`, `DELETE`), replace the auth + ownership block (the `getServerSession` + `getSessionById` + `getCampaignById` triple) with:
   ```ts
   const sessionId = (await params).id;
   const gamingSession = await db.getSessionById(sessionId);
   if (!gamingSession) {
     return NextResponse.json({ error: 'Session not found' }, { status: 404 });
   }
   const access = await requireCampaignAccess(gamingSession.campaignId, 'owner');
   if (!access.ok) return access.response;
   ```
3. Then for `POST`/`PUT`, retain the body parsing and the upload-ownership check (`upload.userId !== access.userId`).
4. Run `npm run lint` + `npx tsc --noEmit`.
5. **Commit:**
   ```bash
   git add src/app/api/sessions/[id]/upload/route.ts
   git commit -m "refactor(api/sessions/upload): use requireCampaignAccess (owner-only)"
   ```

### Task 4.5: Migrate `/api/transcription/[sessionId]`

**Files:**
- Modify: `src/app/api/transcription/[sessionId]/route.ts`

**Steps:**

1. Import `requireCampaignAccess`.
2. In `POST`, replace the auth + ownership block with the `requireCampaignAccess(session.campaignId, 'owner')` pattern (same shape as Task 4.4).
3. In `GET`, same pattern but with `'any'`.
4. Run `npm run lint` + `npx tsc --noEmit`.
5. **Commit:**
   ```bash
   git add src/app/api/transcription
   git commit -m "refactor(api/transcription): use requireCampaignAccess (GET any, POST owner)"
   ```

### Task 4.6: Migrate `/api/summary/[sessionId]`

**Files:**
- Modify: `src/app/api/summary/[sessionId]/route.ts`

**Steps:**

1. Import `requireCampaignAccess`.
2. `POST` → `'owner'`.
3. `GET` → `'any'`.
4. `PUT` → `'owner'`.
5. Run `npm run lint` + `npx tsc --noEmit`. Expected: **no errors remain.**
6. Run `npm run build`. Expected: success.
7. **Commit:**
   ```bash
   git add src/app/api/summary
   git commit -m "refactor(api/summary): use requireCampaignAccess (GET any, POST/PUT owner)"
   ```

---

## Phase 5 — New routes: invite-link

### Task 5.1: Token helper

**Files:**
- Create: `src/lib/inviteTokens.ts`

**Steps:**

1. Create:
   ```ts
   import { randomBytes, createHash } from 'node:crypto';

   /** 32 random bytes, base64url-encoded (43 chars). */
   export function generateInviteToken(): string {
     return randomBytes(32).toString('base64url');
   }

   /** Stable hash for DB lookup; never store the raw token. */
   export function hashInviteToken(rawToken: string): string {
     return createHash('sha256').update(rawToken).digest('hex');
   }
   ```

2. **Commit:**
   ```bash
   git add src/lib/inviteTokens.ts
   git commit -m "feat(invite): add token generate + hash helpers"
   ```

### Task 5.2: `/api/campaigns/[id]/invite-link` route

**Files:**
- Create: `src/app/api/campaigns/[id]/invite-link/route.ts`

**Steps:**

1. Create the route:
   ```ts
   import { NextRequest, NextResponse } from 'next/server';
   import { z } from 'zod';
   import { prisma } from '@/lib/prisma';
   import { requireCampaignAccess } from '@/lib/permissions';
   import { generateInviteToken, hashInviteToken } from '@/lib/inviteTokens';

   const createSchema = z.object({
     expiresInDays: z.union([z.literal(7), z.literal(30), z.null()]).optional(),
   });

   function buildInviteUrl(request: NextRequest, rawToken: string): string {
     const origin = request.headers.get('origin') ?? new URL(request.url).origin;
     return `${origin}/campaigns/invite/${rawToken}`;
   }

   // GET — return current active link metadata (no token).
   export async function GET(
     _request: NextRequest,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     const link = await prisma.inviteLink.findFirst({
       where: { campaignId: id, revokedAt: null },
       orderBy: { createdAt: 'desc' },
     });
     if (!link) return NextResponse.json({ link: null });

     const expired = link.expiresAt !== null && link.expiresAt <= new Date();
     return NextResponse.json({
       link: {
         id: link.id,
         createdAt: link.createdAt,
         expiresAt: link.expiresAt,
         expired,
       },
     });
   }

   // POST — revoke previous active link(s) and issue a new one. Returns the
   // raw URL once. Owner must copy it; we can't reconstruct it after this.
   export async function POST(
     request: NextRequest,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     let parsed: z.infer<typeof createSchema>;
     try {
       parsed = createSchema.parse(await request.json());
     } catch (e) {
       if (e instanceof z.ZodError) {
         return NextResponse.json(
           { error: 'Validation error', details: e.issues },
           { status: 400 },
         );
       }
       throw e;
     }

     const expiresAt =
       parsed.expiresInDays && parsed.expiresInDays > 0
         ? new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000)
         : null;

     const rawToken = generateInviteToken();
     const tokenHash = hashInviteToken(rawToken);

     const link = await prisma.$transaction(async (tx) => {
       await tx.inviteLink.updateMany({
         where: { campaignId: id, revokedAt: null },
         data: { revokedAt: new Date() },
       });
       return tx.inviteLink.create({
         data: {
           campaignId: id,
           tokenHash,
           createdBy: access.userId,
           expiresAt,
         },
       });
     });

     return NextResponse.json(
       {
         link: {
           id: link.id,
           url: buildInviteUrl(request, rawToken),
           createdAt: link.createdAt,
           expiresAt: link.expiresAt,
         },
       },
       { status: 201 },
     );
   }

   // DELETE — revoke any active link(s).
   export async function DELETE(
     _request: NextRequest,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     await prisma.inviteLink.updateMany({
       where: { campaignId: id, revokedAt: null },
       data: { revokedAt: new Date() },
     });
     return new NextResponse(null, { status: 204 });
   }
   ```

2. Run `npm run lint` + `npx tsc --noEmit`.
3. **Commit:**
   ```bash
   git add src/app/api/campaigns/[id]/invite-link
   git commit -m "feat(invite-link): owner GET/POST/DELETE; POST issues hashed token + URL once"
   ```

### Task 5.3: `/api/invite/[token]` route (redemption)

**Files:**
- Create: `src/app/api/invite/[token]/route.ts`

**Steps:**

1. Create:
   ```ts
   import { NextRequest, NextResponse } from 'next/server';
   import { getServerSession } from 'next-auth';
   import { authOptions } from '@/lib/auth';
   import { prisma } from '@/lib/prisma';
   import { hashInviteToken } from '@/lib/inviteTokens';

   async function lookupLink(token: string) {
     const tokenHash = hashInviteToken(token);
     const link = await prisma.inviteLink.findUnique({
       where: { tokenHash },
       include: {
         campaign: {
           select: {
             id: true,
             name: true,
             creator: { select: { name: true, email: true } },
           },
         },
       },
     });
     if (!link) return null;
     if (link.revokedAt !== null) return null;
     if (link.expiresAt !== null && link.expiresAt <= new Date()) return null;
     return link;
   }

   // GET — preview the invitation. Returns 404 for invalid/expired/revoked
   // tokens to avoid information leakage.
   export async function GET(
     _request: NextRequest,
     { params }: { params: Promise<{ token: string }> },
   ) {
     const { token } = await params;
     const session = await getServerSession(authOptions);
     if (!session?.user?.id) {
       return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
     }

     const link = await lookupLink(token);
     if (!link) {
       return NextResponse.json({ error: 'Not found' }, { status: 404 });
     }

     const existing = await prisma.member.findUnique({
       where: {
         campaignId_userId: {
           campaignId: link.campaignId,
           userId: session.user.id,
         },
       },
       select: { role: true },
     });

     return NextResponse.json({
       campaign: {
         id: link.campaign.id,
         name: link.campaign.name,
       },
       inviter: {
         name: link.campaign.creator.name,
       },
       alreadyMember: Boolean(existing),
       role: existing?.role ?? null,
     });
   }

   // POST — accept the invitation. Idempotent: if you're already a member,
   // succeeds with `alreadyMember: true`.
   export async function POST(
     _request: NextRequest,
     { params }: { params: Promise<{ token: string }> },
   ) {
     const { token } = await params;
     const session = await getServerSession(authOptions);
     if (!session?.user?.id) {
       return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
     }

     const link = await lookupLink(token);
     if (!link) {
       return NextResponse.json({ error: 'Not found' }, { status: 404 });
     }

     const existing = await prisma.member.findUnique({
       where: {
         campaignId_userId: {
           campaignId: link.campaignId,
           userId: session.user.id,
         },
       },
     });

     if (existing) {
       return NextResponse.json({
         campaignId: link.campaignId,
         alreadyMember: true,
       });
     }

     await prisma.member.create({
       data: {
         campaignId: link.campaignId,
         userId: session.user.id,
         role: 'player',
         invitedBy: link.createdBy,
       },
     });

     return NextResponse.json({
       campaignId: link.campaignId,
       alreadyMember: false,
     });
   }
   ```

2. Run `npm run lint` + `npx tsc --noEmit`.
3. **Commit:**
   ```bash
   git add src/app/api/invite
   git commit -m "feat(invite): redemption API — GET preview, POST accept (idempotent)"
   ```

---

## Phase 6 — New routes: members + email invitations

### Task 6.1: `/api/campaigns/[id]/members` route

**Files:**
- Create: `src/app/api/campaigns/[id]/members/route.ts`

**Steps:**

1. Create:
   ```ts
   import { NextRequest, NextResponse } from 'next/server';
   import { z } from 'zod';
   import { prisma } from '@/lib/prisma';
   import { requireCampaignAccess } from '@/lib/permissions';

   const addByEmailSchema = z.object({
     email: z.string().email(),
   });

   // GET — list members. Players see name + role + joinedAt only.
   // Owners additionally see email and pending invitations.
   export async function GET(
     _request: NextRequest,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     const access = await requireCampaignAccess(id, 'any');
     if (!access.ok) return access.response;

     const members = await prisma.member.findMany({
       where: { campaignId: id },
       include: {
         user: { select: { id: true, name: true, email: true } },
       },
       orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
     });

     const isOwner = access.role === 'owner';
     const payload = members.map((m) => ({
       userId: m.userId,
       name: m.user.name,
       email: isOwner ? m.user.email : null,
       role: m.role,
       joinedAt: m.joinedAt,
       isSelf: m.userId === access.userId,
     }));

     const pending = isOwner
       ? await prisma.invitation.findMany({
           where: { campaignId: id, acceptedAt: null },
           orderBy: { createdAt: 'asc' },
         })
       : [];

     return NextResponse.json({
       members: payload,
       pendingInvitations: pending.map((p) => ({
         id: p.id,
         email: p.email,
         createdAt: p.createdAt,
       })),
       viewerRole: access.role,
     });
   }

   // POST — owner adds a player by email. Three outcomes:
   //   - added: user exists, new Member row created
   //   - already_member: user exists and was already a Member
   //   - pending: user does not exist, Invitation pre-staged
   export async function POST(
     request: NextRequest,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     let parsed: { email: string };
     try {
       parsed = addByEmailSchema.parse(await request.json());
     } catch (e) {
       if (e instanceof z.ZodError) {
         return NextResponse.json(
           { error: 'Validation error', details: e.issues },
           { status: 400 },
         );
       }
       throw e;
     }
     const normalized = parsed.email.trim().toLowerCase();

     const user = await prisma.user.findUnique({ where: { email: normalized } });

     if (user) {
       if (user.id === access.userId) {
         return NextResponse.json(
           { status: 'self', message: "You're the owner of this campaign." },
           { status: 400 },
         );
       }

       const existing = await prisma.member.findUnique({
         where: { campaignId_userId: { campaignId: id, userId: user.id } },
       });
       if (existing) {
         return NextResponse.json({
           status: 'already_member',
           member: { userId: user.id, name: user.name, email: user.email, role: existing.role },
         });
       }

       const member = await prisma.member.create({
         data: {
           campaignId: id,
           userId: user.id,
           role: 'player',
           invitedBy: access.userId,
         },
       });

       return NextResponse.json(
         {
           status: 'added',
           member: { userId: user.id, name: user.name, email: user.email, role: member.role },
         },
         { status: 201 },
       );
     }

     const invitation = await prisma.invitation.upsert({
       where: { campaignId_email: { campaignId: id, email: normalized } },
       create: { campaignId: id, email: normalized, invitedBy: access.userId },
       update: {},
     });

     return NextResponse.json(
       {
         status: 'pending',
         invitation: { id: invitation.id, email: normalized, createdAt: invitation.createdAt },
       },
       { status: 201 },
     );
   }
   ```

2. Run `npm run lint` + `npx tsc --noEmit`.
3. **Commit:**
   ```bash
   git add src/app/api/campaigns/[id]/members
   git commit -m "feat(members): GET list (role-gated payload), POST add-by-email"
   ```

### Task 6.2: `/api/campaigns/[id]/members/[userId]` (DELETE)

**Files:**
- Create: `src/app/api/campaigns/[id]/members/[userId]/route.ts`

**Steps:**

1. Create:
   ```ts
   import { NextRequest, NextResponse } from 'next/server';
   import { prisma } from '@/lib/prisma';
   import { requireCampaignAccess } from '@/lib/permissions';

   export async function DELETE(
     _request: NextRequest,
     { params }: { params: Promise<{ id: string; userId: string }> },
   ) {
     const { id, userId } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     const target = await prisma.member.findUnique({
       where: { campaignId_userId: { campaignId: id, userId } },
     });
     if (!target) {
       return NextResponse.json({ error: 'Member not found' }, { status: 404 });
     }

     // Refuse to leave a campaign ownerless.
     if (target.role === 'owner') {
       const ownerCount = await prisma.member.count({
         where: { campaignId: id, role: 'owner' },
       });
       if (ownerCount <= 1) {
         return NextResponse.json(
           { error: 'Cannot remove the sole owner of a campaign.' },
           { status: 400 },
         );
       }
     }

     await prisma.member.delete({
       where: { campaignId_userId: { campaignId: id, userId } },
     });

     return new NextResponse(null, { status: 204 });
   }
   ```

2. Run `npm run lint` + `npx tsc --noEmit`.
3. **Commit:**
   ```bash
   git add src/app/api/campaigns/[id]/members
   git commit -m "feat(members): owner can remove a member; refuses to remove sole owner"
   ```

### Task 6.3: `/api/campaigns/[id]/invitations/[invitationId]` (DELETE)

**Files:**
- Create: `src/app/api/campaigns/[id]/invitations/[invitationId]/route.ts`

**Steps:**

1. Create:
   ```ts
   import { NextRequest, NextResponse } from 'next/server';
   import { prisma } from '@/lib/prisma';
   import { requireCampaignAccess } from '@/lib/permissions';

   export async function DELETE(
     _request: NextRequest,
     { params }: { params: Promise<{ id: string; invitationId: string }> },
   ) {
     const { id, invitationId } = await params;
     const access = await requireCampaignAccess(id, 'owner');
     if (!access.ok) return access.response;

     const invitation = await prisma.invitation.findUnique({
       where: { id: invitationId },
     });
     if (!invitation || invitation.campaignId !== id) {
       return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
     }

     await prisma.invitation.delete({ where: { id: invitationId } });
     return new NextResponse(null, { status: 204 });
   }
   ```

2. Run `npm run lint` + `npx tsc --noEmit`.
3. **Commit:**
   ```bash
   git add src/app/api/campaigns/[id]/invitations
   git commit -m "feat(invitations): owner can cancel a pending email invitation"
   ```

---

## Phase 7 — Middleware update

### Task 7.1: Verify (and adjust if needed) middleware matcher

**Files:**
- (Possibly) modify: `src/middleware.ts`

**Steps:**

1. Read `src/middleware.ts`. The current matcher is `'/sessions/:path*', '/campaigns/:path*'`. The redemption page lives at `/campaigns/invite/[token]` so it IS already covered.
2. Confirm by reading the matcher behavior: `/campaigns/invite/abc123` matches `/campaigns/:path*` (path = `invite/abc123`). ✓ No change needed.
3. No commit.

---

## Phase 8 — UI

### Task 8.1: Campaign list — group by role + badge

**Files:**
- Modify: `src/app/campaigns/page.tsx`

**Steps:**

1. Extend the `Campaign` interface to include `role?: 'owner' | 'player'`.
2. Hide "New campaign" + edit + delete affordances on cards where `role === 'player'`.
3. Group the rendered list: render owner-role campaigns under heading "My campaigns" and player-role campaigns under "Shared with me" (only when non-empty).
4. Add a small badge next to each card showing `Owner` or `Player`.
5. Run `npm run lint`. Expected: exit 0.
6. **Commit:**
   ```bash
   git add src/app/campaigns/page.tsx
   git commit -m "feat(ui): group campaigns by role; hide write affordances for players"
   ```

### Task 8.2: Members card component

**Files:**
- Create: `src/components/MembersCard.tsx`

**Steps:**

1. Create a client component that:
   - Takes `campaignId` prop.
   - `useQuery(['members', campaignId])` against `GET /api/campaigns/[id]/members`.
   - Renders the member list (name + role + joinedAt; email only if owner viewer).
   - For owners only, also renders the pending invitations list with cancel buttons.
   - For owners only, also renders an "Add by email" input + button (mutation against `POST /api/campaigns/[id]/members`); shows toast or inline status for the three response shapes (`added`, `already_member`, `pending`, `self`).
   - For owners only, shows `[Remove]` button per non-owner row (mutation against `DELETE /api/campaigns/[id]/members/[userId]`).
   - Invalidate `['members', campaignId]` after any successful mutation.

2. Use existing UI primitives (`@/components/ui/Button`) and `lucide-react` icons consistent with the rest of the app.

3. **Commit:**
   ```bash
   git add src/components/MembersCard.tsx
   git commit -m "feat(ui): MembersCard component (role-gated payload + add/remove)"
   ```

### Task 8.3: Invite link card component

**Files:**
- Create: `src/components/InviteLinkCard.tsx`

**Steps:**

1. Create a client component:
   - Takes `campaignId` prop.
   - `useQuery(['invite-link', campaignId])` against `GET /api/campaigns/[id]/invite-link`.
   - **No active link**: shows expiry select (7 days / 30 days / Never) + `[Generate invite link]` button. On submit POSTs and caches the returned URL in local component state.
   - **Has active link (from GET response or local cache)**:
     - If we have the raw URL in local state, show it in a read-only input with a `[Copy]` button (uses `navigator.clipboard.writeText`).
     - If we only have metadata (page reload), show "Invite link is active" plus expiry text.
     - `[Generate new]` and `[Revoke]` buttons. Both require a confirm dialog (`window.confirm`). Both invalidate the query.
   - Owner-only — don't render anything to players (the parent already gates this).

2. **Commit:**
   ```bash
   git add src/components/InviteLinkCard.tsx
   git commit -m "feat(ui): InviteLinkCard (generate/copy/revoke; raw URL shown once)"
   ```

### Task 8.4: Campaign detail page — wire up members + invite cards, gate by role

**Files:**
- Modify: `src/app/campaigns/[id]/page.tsx`

**Steps:**

1. Update the `Campaign` interface to include `role: 'owner' | 'player'`.
2. After the campaign loads, store `const isOwner = campaign?.role === 'owner'`.
3. Hide:
   - System prompt edit panel for non-owners.
   - "New session" button for non-owners.
   - "Edit campaign" / "Delete campaign" buttons for non-owners.
4. Insert the `<MembersCard campaignId={campaignId} />` component below the existing sessions list.
5. Insert `{isOwner && <InviteLinkCard campaignId={campaignId} />}` above the members card.
6. Run `npm run lint` + `npm run build`. Both must pass.
7. **Commit:**
   ```bash
   git add src/app/campaigns/[id]/page.tsx
   git commit -m "feat(ui): campaign detail gates write affordances by role; adds members + invite UI"
   ```

### Task 8.5: Session detail page — gate write affordances

**Files:**
- Modify: `src/app/sessions/[id]/page.tsx`
- Modify (only if needed): `src/app/api/sessions/[id]/route.ts` — confirm the GET response already includes campaign info; if not, add a `role` field.

**Steps:**

1. In `[id]/page.tsx`, add a second `useQuery` for `['campaign', session.campaignId]` (or — simpler — call `GET /api/campaigns/[id]` once `session` resolves), use it to read `role`.
2. Compute `const isOwner = campaignRole === 'owner'`.
3. Hide for non-owners:
   - The upload box (both modes — "new" and "existing").
   - The "Transcribe" / "Generate Summary" / "Regenerate Summary" buttons.
   - The "Edit summary" pencil button.
   - The "Delete session" button (if there is one on this page).
4. Players still see the transcript and summary (the API allows GET for `any`).
5. Run `npm run lint` + `npm run build`.
6. **Commit:**
   ```bash
   git add src/app/sessions/[id]/page.tsx
   git commit -m "feat(ui): session detail hides write affordances for players"
   ```

### Task 8.6: Redemption page `/campaigns/invite/[token]`

**Files:**
- Create: `src/app/campaigns/invite/[token]/page.tsx`

**Steps:**

1. Server component (auth required, but middleware already gates `/campaigns/*` so unauth users get bounced to signin with `callbackUrl=/campaigns/invite/...`):
   - `await params` to get `token`.
   - Server-side fetch `GET /api/invite/[token]` with cookies forwarded (Next 15 server components automatically include cookies for same-origin fetches via `headers()` workaround; simplest is to import `getServerSession`, then read `prisma` directly via the same logic as the API route). For simplicity, call into a server helper that does the same `lookupLink` work as the API route — extract `lookupLink` into a shared module if you wish, or just duplicate (DRY trade-off: tiny duplication).
   - If the link is not found → render the "invite no longer valid" page.
   - If `alreadyMember` → `redirect('/campaigns/<id>')` (use `next/navigation` `redirect`).
   - Otherwise render a small client island with campaign name + inviter + `[Accept]` / `[Not now]` buttons.

2. The accept button POSTs to `/api/invite/[token]` and on success calls `router.push('/campaigns/<id>')`.

3. Run `npm run lint` + `npm run build`.

4. **Commit:**
   ```bash
   git add src/app/campaigns/invite
   git commit -m "feat(ui): invite redemption page (/campaigns/invite/[token])"
   ```

---

## Phase 9 — Smoke test

### Task 9.1: Extend smoke test with sharing scenario

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`

**Steps:**

1. Add a new top-level `test('campaign sharing — invite link + email invite + permission gating', ...)` that:
   - Registers two users (owner, player) via the `/api/auth/register` API; signs each in via its own browser context.
   - Owner creates a campaign + uploads + transcribes + summarizes one fixture audio (re-use the existing flow but in a helper function or inline).
   - Owner POSTs `/api/campaigns/[id]/invite-link` → captures `url`.
   - Player visits the URL → clicks `[Accept invitation]` → asserts redirect to `/campaigns/[id]`.
   - Player `GET`s `/api/campaigns` → includes the campaign with `role: 'player'`.
   - Player `GET`s `/api/transcription/[sessionId]` and `/api/summary/[sessionId]` → both 200, content matches owner's view.
   - Player `POST`s every owner-only route with that sessionId/campaignId → 404 each:
     - `POST /api/sessions/[id]/upload`
     - `POST /api/transcription/[sessionId]`
     - `POST /api/summary/[sessionId]`
     - `DELETE /api/sessions/[id]`
     - `PUT /api/campaigns/[id]`
     - `POST /api/campaigns/[id]/invite-link`
   - Owner adds the player by email → `status: 'already_member'`.
   - Owner adds a brand-new email (never registered) → `status: 'pending'`.
   - Register that brand-new email → assert that user's `GET /api/campaigns` includes the campaign.
   - Owner removes the original player via `DELETE /api/campaigns/[id]/members/[userId]` → 204.
   - Player's next `GET /api/transcription/[sessionId]` → 404.
   - Owner revokes the invite link → fresh context fetch of `GET /api/invite/[token]` → 401 if not logged in, or once logged in → 404.

2. **Do NOT add new dependencies.** Use the existing Playwright API.

3. **Commit:**
   ```bash
   git add tests/e2e/smoke.spec.ts
   git commit -m "test(smoke): full campaign sharing scenario (invite link, email, removal, revoke)"
   ```

### Task 9.2: Run the smoke test end-to-end

**Steps:**

1. Run `npm run smoke`. Expected: all tests pass.
2. If anything fails:
   - Inspect the failure with `SMOKE_NO_TEARDOWN=1 npm run smoke` to keep the stack up.
   - Use `docker compose -p smoke-test logs app` to inspect server logs.
   - Iterate on the offending route or component, commit per fix.

3. After the full smoke test passes, no commit needed (verification only).

---

## Phase 10 — Wrap up

### Task 10.1: Final build + manual sanity

**Steps:**

1. Run `npm run lint` (must exit 0; warnings OK).
2. Run `npm run build` (must succeed).
3. Run `npx tsc --noEmit` (must exit 0).
4. `git log --oneline main..HEAD` — verify commits read as a coherent story.
5. No commit.

### Task 10.2: Push the branch and open PR

**Steps:**

1. `git push -u origin feat/campaign-sharing`
2. Open a PR via `gh`:
   ```bash
   gh pr create --base main --head feat/campaign-sharing \
     --title "Campaign sharing: read-only player role via invite link + email" \
     --body "$(cat <<'EOF'
   ## Summary
   Add read-only player role to campaigns. Owners share via a revocable
   invite link or by adding an email directly. Unregistered invitees are
   pre-staged and auto-attached on signup.

   ## Design
   See `docs/plans/2026-05-26-campaign-sharing-design.md` (already on main).

   ## Notable
   - New `Member` table — everyone is a member with a role. `Campaign.userId`
     renamed to `createdBy` (audit only).
   - Invite link tokens are SHA-256 hashed in the DB; the raw URL is shown
     once on generate.
   - New `requireCampaignAccess` helper is the single source of truth for
     campaign access; every existing route migrated.
   - `attachPendingInvitations` runs on register + every signin.

   ## Test plan
   - Smoke test extended with a full sharing scenario (invite, email,
     removal, revoke, permission gating). Passes via `npm run smoke`.
   EOF
   )"
   ```
3. Report PR URL to the user.

---

## Done.

After PR merge:
- Follow the manual QA checklist from the design doc against staging.
- If everything looks good, image will roll out via existing Azure deploy pipeline (see `Domo929/dnd-recorder-deploy`).
