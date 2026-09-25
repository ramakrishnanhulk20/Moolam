import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { StatedBench } from "@/components/lab/story/StatedBench";
import { storyData } from "@/components/story/data";
import { Link } from "@/lib/i18n/routing";

// Every plate, every figure and both counts are read on the request. A
// prerendered copy would show whatever was true when the build ran, which is
// not what live means to anyone looking at it.
export const dynamic = "force-dynamic";

/**
 * The hidden bench. Visual pieces are built and looked at here first, and only
 * roll into a real screen once Ram has seen them. Nothing links to this page.
 */
export default async function LabPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    // The bench is a working surface, not a page anyone should land on. It
    // exists on this machine, where the flag is set in .env.local, and nowhere
    // else: the deployment never sets it, so the route is a 404 in production.
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const data = await storyData();

  // The story owns the whole window. The app header floats over its first
  // screen rather than pushing it down, which is what makes the opening frame
  // read as a shot rather than as a section under a navigation bar. The bench
  // holds that pull-up itself, because the one line it prints when there is no
  // statement to show has to sit above the film rather than under the bar.
  return (
    <>
      <StatedBench data={data} />
      <p className="px-5 py-6 font-mono text-[11px] uppercase tracking-[0.2em] sm:px-8 lg:px-14">
        <Link href="/lab/first-screen" className="inline-flex h-11 items-center text-accent underline underline-offset-4 hover:opacity-70">
          First screen bench: the poster and the evidence board
        </Link>
      </p>
    </>
  );
}
