import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import { Providers } from "@/components/Providers";

import "./globals.css";

// Inter is the face Cloudflare's dashboard and developer docs are set in.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Lockkeeper",
  description: "Many coding agents, one repository.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="min-h-screen bg-background text-foreground antialiased font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
