import { notFound } from "next/navigation";
import PassportPage from "../../passport/[id]/page";

// The passport is read on the request, through the same one minute holds the
// real page uses, so the strip always shows today's chain.
export const dynamic = "force-dynamic";

const ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Monsoon Fishing Nets Drying: a published picture with a Chainlink re-check and a statement. */
const DEFAULT_PASSPORT = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";

/** The passports the strip is judged on, for the bench links at the page's foot. */
const BENCH = [
  { id: DEFAULT_PASSPORT, name: "Monsoon" },
  { id: "0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4", name: "Kanchipuram, sealed" },
  { id: "0xf392aad95c4eaec290255eb4015fa2876bc5228d8e72a717a1bf279609522c3d", name: "No re-check" },
  { id: "0xcf7bc9c06bede5b6c3029a1d4f02add73e10b657b0875317096045eb00074a5a", name: "Captured, no picture" },
];

/**
 * The passport page with a facts strip along the foot of its picture, for Ram
 * to judge before it rolls into the real route. ?id= opens any passport. Nothing
 * links here and the flag that opens it is only set on this machine, so the
 * route is a 404 everywhere else.
 */
export default async function PassportTopLabPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    notFound();
  }

  const { locale } = await params;
  const asked = searchParams === undefined ? {} : await searchParams;
  const id = typeof asked.id === "string" && ID_PATTERN.test(asked.id) ? asked.id : DEFAULT_PASSPORT;

  return (
    <>
      <PassportPage params={Promise.resolve({ locale, id })} variant="facts" />
      <nav className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-3 border-t border-line px-5 py-8 sm:px-8">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">Lab: passport top</span>
        {BENCH.map((passport) => (
          <a
            key={passport.id}
            href={`?id=${passport.id}`}
            aria-current={passport.id === id.toLowerCase() ? "page" : undefined}
            className="rounded-[8px] border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent aria-[current=page]:border-accent aria-[current=page]:text-accent"
          >
            {passport.name}
          </a>
        ))}
      </nav>
    </>
  );
}
