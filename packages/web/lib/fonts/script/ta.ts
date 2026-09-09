import { Noto_Sans_Tamil } from "next/font/google";

export const face = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-script",
  display: "swap",
  preload: false,
});
