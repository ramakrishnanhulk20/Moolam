import { getFormatter, getTranslations } from "next-intl/server";
import type { ConsentRecord } from "@/components/consent/ConsentSection";
import { readCard } from "@/components/agent/card";
import { heldAgent, heldPassportRecord } from "@/lib/chain/registry";
import { creditFor } from "@/lib/data/platform-label";
import type { Attestation, Passport } from "@/lib/chain/registry";
import { Link } from "@/lib/i18n/routing";
import type { Art } from "./art";
import { FactJumpLink } from "./FactJump";
import { TOP_FACT_WORD_KEYS, topFacts, type TopFact, type TopFactTone, type TopFactWords } from "./top-facts";

const TONES: Record<TopFactTone, string> = {
  text: "text-text",
  verified: "text-verified",
  failed: "text-failed",
  pending: "text-pending",
  disputed: "text-disputed",
  faint: "text-text-muted",
};

/**
 * The facts strip along the poster's foot: who made the picture, what drew it,
 * what the holder allows, and whether anybody checked, each one a link down to
 * the part of the page that proves it.
 *
 * Everything here is read from what the page already holds. The one read of
 * its own is the agent's card, for its name, which is the same held read the
 * agent's page makes; a card that will not answer leaves the number, which is
 * still true. The credit's holder is the page's own held record, asked for
 * only when the list names the creator's wallet.
 */
export async function TopFacts({
  passport,
  art,
  consent,
  attestations,
  locale,
}: {
  passport: Passport;
  art: Art;
  consent: ConsentRecord | null;
  attestations: readonly Attestation[];
  locale: string;
}) {
  const t = await getTranslations("passport");
  const kinds = await getTranslations("kind");
  const format = await getFormatter({ locale });
  const credit = await creditFor(passport, async () => (await heldPassportRecord(passport.id)).owner).catch(() => null);

  const facts = topFacts(
    {
      creator: passport.creator,
      agentId: passport.generatorAgentId,
      agentName: passport.generatorAgentId === 0n ? null : await agentName(passport.generatorAgentId),
      kind: passport.kind,
      consent: consent === null ? null : consent.reading,
      attestations,
      phash: passport.phash,
      sealed: art.sealed === true,
      privateRecheck: art.privateRecheck === true,
      credit,
    },
    {
      kind: (kind) => kinds(String(kind)),
      agentNumber: (id) => t("agentNumber", { id }),
      cardNamed: (agent) => t("facts.cardNamed", { agent }),
      statement: (statement) => t(`consent.summary.${statement}`),
      bits: (count) => t("attestations.distance", { distance: count }),
      privateRecheck: t("attestations.private.badge"),
      sealed: t("sealed.label"),
      date: (seconds) => format.dateTime(new Date(Number(seconds) * 1000), { dateStyle: "medium" }),
      heldBy: (platform) => t("facts.heldBy", { platform }),
      via: (platform) => t("facts.via", { platform }),
      handedBy: (platform) => t("facts.handedBy", { platform }),
      words: Object.fromEntries(TOP_FACT_WORD_KEYS.map((key) => [key, t(`facts.${key}`)])) as TopFactWords,
    },
  );

  return <FactStrip facts={facts} />;
}

/** The strip itself, apart from its reads, so a test can draw it from a fixture. */
export function FactStrip({ facts }: { facts: TopFact[] }) {
  return (
    <ul data-top-facts className="grid grid-cols-2 border-t border-line-strong/70 lg:grid-cols-4">
      {facts.map((fact, index) => (
        <li
          key={fact.key}
          data-fact={fact.key}
          className={`rise min-w-0 ${cellEdges(index)}`}
          style={{ animationDelay: `${180 + index * 60}ms` }}
        >
          <Cell fact={fact} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Hairlines between the cells in both layouts: two by two on a phone, one row
 * of four on a laptop. A rule only ever sits between two cells.
 */
function cellEdges(index: number): string {
  const second = index % 2 === 1 ? "border-s border-line-strong/70 ps-4 sm:ps-6" : "";
  const lower = index >= 2 ? "border-t border-line-strong/70 lg:border-t-0" : "";
  const laptop = index === 2 ? "lg:border-s lg:border-line-strong/70 lg:ps-6" : "";
  return `${second} ${lower} ${laptop} pe-3 sm:pe-6`;
}

function Cell({ fact }: { fact: TopFact }) {
  const leaves = !fact.href.startsWith("#");
  const body = (
    <>
      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted transition-colors duration-200 group-hover:text-accent">
        <span aria-hidden className="motif h-[7px] w-[7px] opacity-70 transition-opacity duration-200 group-hover:opacity-100" />
        {fact.label}
        <Arrow leaves={leaves} />
      </span>
      <span
        data-fact-value
        data-unread={fact.unread === true ? "true" : undefined}
        className={`mt-2 block break-words leading-snug ${TONES[fact.tone]} ${
          fact.mono === true
            ? "font-mono text-[13px] sm:text-sm"
            : "font-display text-[15px] font-semibold tracking-[-0.01em] sm:text-[17px]"
        }`}
      >
        {fact.value}
      </span>
      {fact.detail === undefined ? null : (
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">{fact.detail}</span>
      )}
      {/* The underline draws in from the start edge on hover, the same move the
          sealed plates make. */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-accent transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-x-100 rtl:origin-right"
      />
    </>
  );

  const className = "group relative block h-full py-2.5 sm:py-4";
  return leaves ? (
    <Link href={fact.href} className={className}>
      {body}
    </Link>
  ) : (
    <FactJumpLink href={fact.href} className={className}>
      {body}
    </FactJumpLink>
  );
}

/** Down for a fact that lives lower on this page, across for one that opens another page. */
function Arrow({ leaves }: { leaves: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 10 10"
      className={`h-[9px] w-[9px] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        leaves ? "group-hover:translate-x-0.5 rtl:-scale-x-100" : "group-hover:translate-y-0.5"
      }`}
    >
      <path
        d={leaves ? "M1 5h8M5.5 1.5 9 5 5.5 8.5" : "M5 1v8M1.5 5.5 5 9l3.5-3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

async function agentName(agentId: bigint): Promise<string | null> {
  try {
    return readCard((await heldAgent(agentId.toString())).card)?.name ?? null;
  } catch {
    return null;
  }
}
