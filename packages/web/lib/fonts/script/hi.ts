import { Noto_Sans_Devanagari } from "next/font/google";

export const face = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-script",
  display: "swap",
  preload: false,
});
