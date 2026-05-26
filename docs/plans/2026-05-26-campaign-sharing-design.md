# Campaign sharing — design

**Date:** 2026-05-26
**Status:** Approved, ready for implementation
**Author:** brainstormed with Copilot CLI

## Goal

Let a campaign owner (the DM) share a campaign with their players so the players can read session transcripts and summaries, but cannot upload audio, edit, or trigger AI work. Two share mechanisms:

1. A revocable invite link the owner can paste into a group chat.
2. Add-by-email (works for both registered and unregistered users).

Privacy constraint: the owner must never see a directory of every user in the system.

## Decisions

| Question | Decision |
| --- | --- |
| Permission scope for shared users | Strict read-only ("player" role). No uploads, no edits, no AI triggers, no invites. |
| Invite link semantics | Multi-use, optional expiry, revocable. |
| Add-by-email when email is unregistered | Pre-stage the invitation; auto-attach on signup/signin. No email sending. |
| Add-by-email privacy posture | Distinct outcomes ("Added Alice Smith" vs "Invitation pending"). |
| Membership model | Everyone (including owner) is a `Member` row with a `role` column. `Campaign.createdBy` kept for audit only, not permissions. |
| Table naming | `Member`, `InviteLink`, `Invitation` (campaign prefix dropped — "the campaign is implied"). |
| Invite link tokens | 32 random bytes, base64url. Stored as SHA-256 hash, never as raw value. |

## Section 1 — Data model

```prisma
model Campaign {
  id           String   @id @default(cuid())
  name         String
  description  String?
  systemPrompt String?  @map("system_prompt")
  createdBy    String   @map("created_by")   // audit only — NOT permissions
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  creator        User           @relation("CampaignCreatedBy", fields: [createdBy], references: [id], onDelete: Restrict)
  members        Member[]
  gamingSessions GamingSession[]
  inviteLinks    InviteLink[]
  invitations    Invitation[]

  @@unique([createdBy, name])
  @@map("campaigns")
}

model Member {
  id         String   @id @default(cuid())
  campaignId String   @map("campaign_id")
  userId     String   @map("user_id")
  role       String                            // 'owner' | 'player'
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
  tokenHash  String    @unique @map("token_hash")  // sha256(rawToken), 64 hex chars
  createdBy  String    @map("created_by")
  createdAt  DateTime  @default(now()) @map("created_at")
  expiresAt  DateTime? @map("expires_at")          // null = no expiry
  revokedAt  DateTime? @map("revoked_at")          // null = still active

  campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  @@index([campaignId])
  @@map("invite_links")
}

model Invitation {
  id         String    @id @default(cuid())
  campaignId String    @map("campaign_id")
  email      String                                // normalized lowercase
  invitedBy  String    @map("invited_by")
  createdAt  DateTime  @default(now()) @map("created_at")
  acceptedAt DateTime? @map("accepted_at")

  campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  @@unique([campaignId, email])
  @@index([email])
  @@map("invitations")
}
```

### Migration

Single migration:

1. Rename `Campaign.userId` → `createdBy`.
2. Change FK on creator to `onDelete: Restrict`.
3. Create `members`, `invite_links`, `invitations` tables.
4. Seed: for every existing `Campaign`, insert one `Member` row with `userId = createdBy`, `role = 'owner'`, `invitedBy = NULL`, `joinedAt = Campaign.createdAt`.

Acceptable because only one test campaign exists in prod.

### Rationale

- **One source of truth for permissions**: every access check joins `Member`. Owner queries and player queries use the same code path.
- **Ownership transfer is one UPDATE** to a `Member.role` (future feature, but the model supports it for free).
- **Account deletion** of a non-creator cascades cleanly (Member rows go away, campaign stays).
- **Account deletion** of the creator is blocked (Restrict) — must transfer ownership first. We'll wire that into a future account-deletion flow.

## Section 2 — Permission helper + route audit

### Helper (`src/lib/permissions.ts`)

```ts
export type CampaignRole = 'owner' | 'player';

export async function getCampaignAccess(
  userId: string,
  campaignId: string,
): Promise<CampaignRole | null>;

// Returns either { userId, role } or a NextResponse the caller should return.
// 401 if no session.
// 404 if no membership.
// 404 if level='owner' and role='player' (do not leak existence).
export async function requireCampaignAccess(
  campaignId: string,
  level: 'any' | 'owner',
): Promise<{ userId: string; role: CampaignRole } | NextResponse>;
```

Middleware (`src/middleware.ts`) keeps only "is logged in?" gating. Role checks are per-route because they require a DB lookup.

### Existing routes — required access

| Route | Method | Required access | Notes |
| --- | --- | --- | --- |
| `/api/campaigns` | GET | logged-in | List campaigns where user is a Member; include `role`. |
| `/api/campaigns` | POST | logged-in | Transaction: create Campaign + owner Member. |
| `/api/campaigns/[id]` | GET | any | Redact `systemPrompt` for players (DM notes). |
| `/api/campaigns/[id]` | PUT/DELETE | owner | |
| `/api/sessions` | GET | logged-in | Join via Member to filter to user's campaigns. |
| `/api/sessions` | POST | owner of `body.campaign_id` | |
| `/api/sessions/[id]` | GET | any | |
| `/api/sessions/[id]` | PATCH/DELETE | owner | |
| `/api/sessions/[id]/upload` | POST/PUT/DELETE | owner | |
| `/api/transcription/[sessionId]` | GET | any | |
| `/api/transcription/[sessionId]` | POST | owner | |
| `/api/summary/[sessionId]` | GET | any | |
| `/api/summary/[sessionId]` | POST/PUT | owner | |
| `/api/uploads` | GET/POST | logged-in | Per-user; unchanged. |

### New routes

| Route | Method | Access | Behavior |
| --- | --- | --- | --- |
| `/api/campaigns/[id]/invite-link` | GET | owner | Returns current active link metadata (no token). |
| `/api/campaigns/[id]/invite-link` | POST | owner | Body `{ expiresInDays?: number \| null }`. Revokes existing, inserts new. Returns `{ url, expiresAt }` once. |
| `/api/campaigns/[id]/invite-link` | DELETE | owner | Revokes current. |
| `/api/campaigns/[id]/members` | GET | any | Player sees names + roles; owner additionally sees emails + joinedAt. |
| `/api/campaigns/[id]/members` | POST | owner | Body `{ email }`. Response `{ status: 'added' \| 'already_member' \| 'pending', ... }`. |
| `/api/campaigns/[id]/members/[userId]` | DELETE | owner | Refuses removing the sole owner. |
| `/api/campaigns/[id]/invitations/[invitationId]` | DELETE | owner | Cancel a pending email invitation. |
| `/api/invite/[token]` | GET | logged-in | Returns `{ campaignName, inviterName, alreadyMember }` or 404. |
| `/api/invite/[token]` | POST | logged-in | Idempotent join as player; returns campaign id for redirect. |

### `attachPendingInvitations(userId, email)`

Called from `/api/auth/register` after user creation AND from NextAuth `events.signIn` on every signin (Credentials + Google). Sweeps `Invitation where email = ? AND acceptedAt IS NULL`, upserts Member rows (`role: 'player'`, `invitedBy = invitation.invitedBy`), stamps `acceptedAt`. Transaction-safe and idempotent.

## Section 3 — Invite link flow

### Token format

- 32 random bytes via `crypto.randomBytes(32).toString('base64url')` → 43-char string.
- DB stores `sha256(rawToken)` as hex. Raw token only exists in the URL and the one-time POST response.
- Lookup hashes the URL token and queries `tokenHash` (unique index → O(1)).
- DB read alone does not yield working invites.

### Owner UX

Campaign detail page → owner-only "Invite players" card:

- **No active link**: "Generate invite link" button + expiry select (`7 days`, `30 days`, `Never`).
- **Active link**:
  ```
  https://app.example.com/campaigns/invite/abc123…    [Copy]
  Expires: in 5 days   ·   Created by you, 2 days ago
  [Generate new]  [Revoke]
  ```
- `[Generate new]` confirms first ("This will invalidate the previous link") then POSTs.
- After page reload the URL is no longer shown (we can't reconstruct it from the hash). Card shows "Invite link is active — [Regenerate] [Revoke]".

### Recipient flow

1. Click link → `/campaigns/invite/[token]`.
2. **Not signed in**: middleware bounces to `/auth/signin?callbackUrl=/campaigns/invite/{token}`. After sign-in (or signup), NextAuth returns them to the invite page.
3. **Signed in**: page calls `GET /api/invite/[token]` and renders "Alice invited you to join **Curse of the Pirate King**." with `[Accept invitation]` and `[Not now]`.
4. **Accept**: POST `/api/invite/[token]`:
   - Validate `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())`.
   - If user is already a `Member`: 200 with `{ alreadyMember: true }`; client redirects with toast.
   - Otherwise insert `Member(role: 'player', invitedBy: link.createdBy)`; redirect to `/campaigns/[id]`.
5. **Not now**: navigate to `/`. No server state to clean up.

### Error states

Token unknown, revoked, or expired → `GET /api/invite/[token]` 404; page renders the same generic "This invite link is no longer valid. Ask your DM to send you a new one." (No leakage between cases.)

### What the URL does not reveal

Only the opaque token — no campaign id or campaign name. A leaked URL exposes nothing until a logged-in user clicks it.

## Section 4 — Email invite flow

### `POST /api/campaigns/[id]/members`

Body: `{ email: string }`. Owner-only.

```ts
const normalized = email.trim().toLowerCase();
// validate with zod email

const user = await prisma.user.findUnique({ where: { email: normalized } });

if (user) {
  const existing = await prisma.member.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (existing) {
    return { status: 'already_member', name: user.name };
  }
  await prisma.member.create({
    data: { campaignId, userId: user.id, role: 'player', invitedBy: ownerId },
  });
  return { status: 'added', name: user.name, email: user.email };
}

// no user with that email — pre-stage
const invitation = await prisma.invitation.upsert({
  where: { campaignId_email: { campaignId, email: normalized } },
  create: { campaignId, email: normalized, invitedBy: ownerId },
  update: {},
});
return { status: 'pending', email: normalized };
```

### Toasts (matches the "distinct outcomes" decision)

- `added` → "Added **Alice Smith** to the campaign."
- `already_member` → "**Alice Smith** is already a member."
- `pending` → "**alice@example.com** isn't registered yet — they'll be added automatically when they sign up."

### `attachPendingInvitations`

```ts
export async function attachPendingInvitations(userId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  const pending = await prisma.invitation.findMany({
    where: { email: normalized, acceptedAt: null },
  });
  if (pending.length === 0) return 0;

  await prisma.$transaction([
    ...pending.map(inv => prisma.member.upsert({
      where: { campaignId_userId: { campaignId: inv.campaignId, userId } },
      create: { campaignId: inv.campaignId, userId, role: 'player', invitedBy: inv.invitedBy },
      update: {},
    })),
    prisma.invitation.updateMany({
      where: { id: { in: pending.map(i => i.id) } },
      data: { acceptedAt: new Date() },
    }),
  ]);
  return pending.length;
}
```

Called from:

1. `src/app/api/auth/register/route.ts` after user creation, before returning success.
2. `src/lib/auth.ts` `events.signIn` on every signin (Credentials + Google).

### Pending invitations UI (owner-only)

```
Pending invitations
  alice@example.com    invited 2 days ago    [Cancel]
  bob@example.com      invited 1 hour ago    [Cancel]
```

`[Cancel]` → `DELETE /api/campaigns/[id]/invitations/[invitationId]`.

### Edge cases

- Email matches the owner's own user → "You're the owner of this campaign" toast, no DB write.
- Email passes validation but is garbage → pre-staged forever or until cancelled.
- User changes their email later → pending invitations keyed on old email stay pending until matched.
- Race between add-by-email and signup → idempotent via unique constraint + upsert; one wins, the other no-ops.

## Section 5 — UI surfaces

### Campaign list page (`/campaigns`)

`GET /api/campaigns` includes `role` per campaign. Two groups:

```
My campaigns
  • Curse of the Pirate King        Owner    12 sessions
  • Salt & Steel                    Owner     3 sessions

Shared with me
  • Embers of the Aetherwild        Player    8 sessions   (shared by Bob)
```

"Shared with me" hidden when empty. Card click → `/campaigns/[id]` regardless of role.

### Campaign detail page (`/campaigns/[id]`)

Three changes:

1. **Conditionally render write affordances by role.** Top-of-page actions (`[Edit]`, `[Delete]`, `[New session]`) hidden for players. System prompt hidden for players. Page-load API returns `role`.
2. **New "Members" card** (visible to all members):
   ```
   Members
     Alice Smith (you)         Owner       added 2 weeks ago
     Bob Jones                 Player      added 3 days ago
     Carol Lee                 Player      added 1 day ago
   ```
   Players see name + role + joinedAt only. Owners additionally see emails and `[Remove]` buttons on player rows. Owner row has no remove button.
3. **New "Invite players" card** (owner-only):
   - Sub-card A: invite link (Section 3).
   - Sub-card B: add by email + pending list (Section 4).

### Session detail page (`/sessions/[id]`)

Role passed from `GET /api/sessions/[id]`:

- **Player**: transcript ✓, summary ✓, metadata ✓. Hide: upload box, replace-audio, regenerate-transcript, regenerate-summary, edit-summary, delete-session, rename.
- **Player attempting writes via direct API call** is still blocked server-side by the permission helper.

### Audio file

Not exposed to players. The path is server-side only during transcription. No download button planned.

### New page: `/campaigns/invite/[token]/page.tsx`

Server component:

1. Read token from params; call `GET /api/invite/[token]` server-side (with cookies).
2. If `alreadyMember`: server-redirect to `/campaigns/[id]`.
3. Otherwise render a client island with `[Accept]` / `[Not now]` → POST → redirect on success.
4. On 404: render the generic "invite no longer valid" page.

### Middleware

The existing `/campaigns/:path*` matcher already covers `/campaigns/invite/*`. Confirm at implementation time; if a regex change is needed, add `/campaigns/invite/:token*` explicitly.

### Empty / loading / error states

- Owner with no members but link generated: "Share the link in your group chat to invite players."
- Owner with no link and no members: just show the invite UI.
- Player viewing campaign with no sessions: "Your DM hasn't recorded any sessions yet."
- Standard skeletons on the members card. Members fetch is separate from the campaign fetch so primary content paints first.

## Section 6 — Testing

### Smoke test extension (`tests/e2e/smoke.spec.ts`)

New `test()` block: `'campaign sharing — invite link + email invite + permission gating'`. Two/three Playwright browser contexts so cookies stay isolated.

1. **Owner setup**: register owner, create campaign, upload + transcribe + summarize one short fixture audio.
2. **Invite link redemption**: register player in second context; owner POSTs to `/api/campaigns/[id]/invite-link`; player visits URL, clicks Accept, lands on `/campaigns/[id]`. Assert `GET /api/campaigns` returns the campaign with `role: 'player'`.
3. **Read permissions work**: player `GET`s transcript + summary → 200, content matches owner's. Player visits `/sessions/[id]` page; transcript visible, upload/regenerate/delete not in DOM.
4. **Write permissions blocked**: player attempts every owner-only API (upload, transcribe, summarize, delete, rename, invite-link generate) → 404.
5. **Email invite, pre-staged**: owner POSTs members with a not-yet-registered email; expect `status: 'pending'`. Register that email in a third context. Assert their `GET /api/campaigns` includes the campaign with `role: 'player'`.
6. **Email invite, existing user**: owner adds the player from step 2 by email → `status: 'already_member'`. Fourth user registers first, then owner adds → `status: 'added'`.
7. **Removal**: owner `DELETE`s the player from step 2; player's next read → 404.
8. **Invite link revocation**: owner `DELETE`s the invite link; fresh context navigating to the captured URL sees the "invite no longer valid" page.

### Out of scope for the smoke test

- Google OAuth sharing flow (Credentials provider is sufficient to verify `attachPendingInvitations` runs in `events.signIn`; we still wire it up for both providers).
- UI styling / responsive layout.
- Token entropy verification (covered implicitly: URL works → hash matches in DB).

### Optional unit tests (only if Vitest is already wired)

`tests/permissions.test.ts`:

- `getCampaignAccess` returns owner / player / null correctly.
- `attachPendingInvitations` is idempotent.
- Token hash matches between generate and verify.

If Vitest is not already configured, defer — adding a new test framework is out of scope.

### Manual QA checklist (post-deploy)

1. Generate invite link, paste into incognito → sign up → land on campaign as player.
2. Same flow with an already-registered user.
3. Add-by-email for known user → "Added" toast.
4. Add-by-email for unknown user → "pending" toast; sign up that email; confirm auto-attach.
5. Revoke link, try old URL → 404 page.
6. Remove a player → confirm they lose access on refresh.

## Implementation order (for the writing-plans phase)

1. Schema migration + `attachPendingInvitations` + permission helper (no UI yet, no routes wired to helper).
2. Migrate every existing route to the permission helper. Run smoke test — should still pass.
3. New routes: invite-link, members, invitations, redemption.
4. UI: members card, invite card, role-gated affordances on campaign + session pages, redemption page.
5. Extend smoke test with the sharing scenario.
6. Manual QA in staging.
