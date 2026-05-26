'use client';

import { SessionProvider as NextAuthSessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import { ReactNode } from 'react';

interface SessionProviderProps {
  children: ReactNode;
  // Optional initial session, typically resolved server-side via
  // `getServerSession` in the root layout. Seeding the provider this way
  // prevents the brief `status === 'unauthenticated'` flash on first
  // render after a page refresh — without it, useSession() has to make a
  // round-trip to /api/auth/session before the navbar knows the user is
  // signed in.
  session?: Session | null;
}

export default function SessionProvider({ children, session }: SessionProviderProps) {
  return (
    <NextAuthSessionProvider session={session}>
      {children}
    </NextAuthSessionProvider>
  );
}