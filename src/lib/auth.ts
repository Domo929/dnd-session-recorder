import { NextAuthOptions } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { attachPendingInvitations } from '@/lib/invitations';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user || !user.password) {
          return null;
        }

        const isPasswordValid = await compare(credentials.password, user.password);

        if (!isPasswordValid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  session: {
    // CredentialsProvider requires the JWT strategy. Using `database`
    // strategy alongside CredentialsProvider triggers a NextAuth
    // `Configuration` error at sign-in time.
    strategy: 'jwt',
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      try {
        console.log('SignIn callback - User:', user);
        console.log('SignIn callback - Account:', account);
        console.log('SignIn callback - Profile:', profile);

        if (account?.provider === 'google') {
          console.log('Google OAuth sign in attempt');
          return true;
        }

        return true;
      } catch (error) {
        console.error('SignIn callback error:', error);
        return false;
      }
    },
    async jwt({ token, user }) {
      // On initial sign-in `user` is populated; persist the DB id onto the
      // token so the session callback can expose it.
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      try {
        if (token?.id && session.user) {
          session.user.id = token.id as string;
        }
        return session;
      } catch (error) {
        console.error('Session callback error:', error);
        return session;
      }
    },
  },
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
    async signOut({ session, token }) {
      console.log('SignOut event:', { session, token });
    },
    async createUser({ user }) {
      console.log('CreateUser event:', user);
    },
    async linkAccount({ user, account, profile }) {
      console.log('LinkAccount event:', { user, account, profile });
    },
    async session({ session, token }) {
      console.log('Session event:', { session, token });
    },
  },
  debug: process.env.NODE_ENV === 'development',
};