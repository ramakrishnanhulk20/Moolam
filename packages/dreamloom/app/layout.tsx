import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Bricolage's optical size axis is what lets the same face read chunky and
// playful at 8rem and still clean on a chip label.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz", "wdth"],
  variable: "--font-bricolage",
  display: "swap",
});

const body = Figtree({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-figtree",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Dreamloom: describe a dream, get the picture",
  description:
    "Dreamloom turns a few words into a picture, and every picture can carry a Moolam passport that credits the person who imagined it and says how AI may use it.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#F6F4FF",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
