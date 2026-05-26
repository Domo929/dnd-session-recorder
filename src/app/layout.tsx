import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { getServerSession } from "next-auth";
import "./globals.css";
import { authOptions } from "@/lib/auth";
import Navbar from "@/components/layout/Navbar";
import ReactQueryProvider from "@/components/providers/ReactQueryProvider";
import SessionProvider from "@/components/providers/SessionProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "D&D Session Recorder",
  description: "AI-powered transcription and summarization for D&D sessions",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve the session server-side so the client SessionProvider can
  // hydrate with the user's auth state instead of briefly flashing
  // "unauthenticated" while it fetches /api/auth/session.
  const session = await getServerSession(authOptions);

  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased bg-gray-50`}>
        <SessionProvider session={session}>
          <ReactQueryProvider>
            <div className="min-h-screen">
              <Navbar />
              <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {children}
              </main>
            </div>
          </ReactQueryProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
