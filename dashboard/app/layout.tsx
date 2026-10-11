import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Lockkeeper",
  description: "Many coding agents, one repository.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b1020", color: "#e6edf7", fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
