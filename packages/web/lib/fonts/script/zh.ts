import { Noto_Sans_SC } from "next/font/google";

// Google splits the CJK families into about a hundred unnamed ranges each, so
// there is no subset to ask for. The @font-face rules carry the unicode ranges
// and the browser fetches only the handful of ranges the page draws.
export const face = Noto_Sans_SC({
  variable: "--font-script",
  display: "swap",
  preload: false,
});
