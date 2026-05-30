import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/layout/Navbar";
import ReactQueryProvider from "@/components/providers/ReactQueryProvider";
import SessionProvider from "@/components/providers/SessionProvider";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "StoryScribe",
  description: "AI-powered transcription and summarization for D&D sessions",
};

// Runs before paint to apply the persisted theme and avoid a flash of the
// default theme. Mirrors the logic in ThemeProvider but executes synchronously
// during HTML parsing.
const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='daylight'||t==='midnight'||t==='tome'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} antialiased`}>
        <SessionProvider>
          <ReactQueryProvider>
            <ThemeProvider>
              <div className="min-h-screen">
                <Navbar />
                <main className="max-w-[1280px] mx-auto px-8 py-8">
                  {children}
                </main>
              </div>
            </ThemeProvider>
          </ReactQueryProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
