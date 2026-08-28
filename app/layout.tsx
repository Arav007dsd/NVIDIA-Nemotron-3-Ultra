import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nemotron Code AI",
  description: "AI coding assistant powered by NVIDIA Nemotron 3 Ultra",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
