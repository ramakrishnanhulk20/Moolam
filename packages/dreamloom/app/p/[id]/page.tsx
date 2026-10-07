import type { Metadata } from "next";
import { connection } from "next/server";
import { Footer } from "@/components/footer";
import { MotionRoot } from "@/components/motion-root";
import { ResultScreen } from "@/components/result/result-screen";
import { canonicalOrigin } from "@/lib/server/env";

export const metadata: Metadata = {
  title: "Your picture | Dreamloom",
  robots: { index: false, follow: false },
};

/** Where Dreamloom answers when DREAMLOOM_ORIGIN is unset, the same fallback the server's Origin check uses. */
const LOCAL_ORIGIN = "http://localhost:3300";
const MOOLAM_SITE = "https://moolam.site";

/**
 * Both values are public: Moolam's site is where the passport lives, and Dreamloom's origin is what
 * Moolam's connect page is told to answer. They are read on each request, so one built image serves
 * whatever the host's settings say.
 */
function siteSettings(): { moolamSite: string; ownOrigin: string } {
  const configured = process.env.MOOLAM_SITE_URL?.trim();
  let moolamSite = MOOLAM_SITE;
  if (configured) {
    try {
      moolamSite = new URL(configured).href.replace(/\/+$/, "");
    } catch {
      moolamSite = MOOLAM_SITE;
    }
  }
  const ownOrigin = canonicalOrigin(process.env.DREAMLOOM_ORIGIN?.trim() || LOCAL_ORIGIN) ?? LOCAL_ORIGIN;
  return { moolamSite, ownOrigin };
}

export default async function PicturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const { moolamSite, ownOrigin } = siteSettings();

  return (
    <MotionRoot>
      <ResultScreen id={id.toLowerCase()} moolamSite={moolamSite} ownOrigin={ownOrigin} />
      <Footer />
    </MotionRoot>
  );
}
