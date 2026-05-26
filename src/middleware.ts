// Page-level auth gate. NextAuth's `withAuth` middleware short-circuits any
// request to a matched path that doesn't carry a valid session token and
// redirects to `pages.signIn` (configured to `/auth/signin` in
// src/lib/auth.ts). It runs at the edge before the App Router renders, so
// unauthenticated users never see the protected UI shell — no flicker,
// no API calls fired with no cookie.
//
// We intentionally do NOT gate `/api/*` here. API routes carry their own
// `getServerSession` + ownership checks (see e.g.
// src/app/api/sessions/[id]/upload/route.ts) so that the protection
// applies even to programmatic callers and isn't dependent on middleware
// matchers staying in sync. The middleware here is purely a UX layer for
// the page routes.
export { default } from 'next-auth/middleware';

export const config = {
  matcher: [
    '/sessions/:path*',
    '/campaigns/:path*',
  ],
};
