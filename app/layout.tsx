import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GuardianAI Deterministic Contract Lab",
  description: "Web interface for deterministic contract enforcement experiments."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
