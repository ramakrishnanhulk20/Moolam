import { getFormatter, getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import type { Art } from "@/components/passport/art";
import { DEMO_AGENT_ID, shortHex } from "@/lib/chain/client";
import { Link } from "@/lib/i18n/routing";
import { claimOf, registeredOutside, seenEarlierLink } from "./strength";

/** The words of the claim block, made once on the server so the drawing needs no reads. */
export interface ClaimCopy {
  label: string;
  /** Where the claim comes from: the strength line. */
  strength: string;
  /** Said only for a document read with no sworn line and no platform statement (L25). */
  outside: string | null;
  /** The registrant's own statements, each drawn as theirs and never as a chain fact (L21). */
  sworn: string | null;
  platformStatement: { label: string | null; text: string } | null;
  seenOnline: { line: string; pages: string[]; more: string | null } | null;
  /** The earlier passport the registrant was shown: a link only for a passport id, plain text otherwise. */
  seenEarlier: { line: string; href: string | null; text: string; label: string } | null;
}

export async function claimCopy({
  passport,
  art,
  platform,
  now = Math.floor(Date.now() / 1000),
}: {
  passport: { creator: Hex; generatorAgentId: bigint; registeredAt: bigint };
  art: Art;
  platform: { status: "kit" | "outsideKit"; name: string } | null;
  now?: number;
}): Promise<ClaimCopy> {
  // The request's own language, which the page has already set.
  const t = await getTranslations();
  const format = await getFormatter();
  const day = (seconds: number): string => format.dateTime(new Date(seconds * 1000), { dateStyle: "medium" });

  const claim = claimOf({
    generatorAgentId: passport.generatorAgentId,
    studioAgentId: DEMO_AGENT_ID,
    platform,
    creator: passport.creator,
    registeredAt: Number(passport.registeredAt),
    now,
  });
  const strength =
    claim.key === "studio"
      ? t("claim.studio")
      : claim.key === "platform"
        ? t("claim.platform", { platform: claim.platform })
        : claim.key === "self"
          ? t("claim.self", { address: shortHex(claim.address), date: day(claim.date), until: day(claim.until) })
          : t("claim.selfLater", { address: shortHex(claim.address), date: day(claim.date) });

  const statements = art.statements;
  const seen = statements?.seenOnline;
  const earlier = statements?.seenEarlier;
  const earlierHref = seenEarlierLink(earlier);

  return {
    label: t("claim.label"),
    strength,
    outside: registeredOutside(statements) === true ? t("claim.outside") : null,
    sworn: statements?.sworn === true ? t("story.sealed.readoutSworn") : null,
    // Named after the platform only where Moolam's list names it; otherwise the words stand alone.
    platformStatement:
      statements?.platformStatement === undefined
        ? null
        : {
            label: platform === null ? null : t("claim.platformStatement", { platform: platform.name }),
            text: statements.platformStatement,
          },
    seenOnline:
      seen === undefined
        ? null
        : {
            line: t("studio.webCheck.passport", { count: seen.count }),
            pages: seen.pages,
            more: seen.count > seen.pages.length ? t("studio.webCheck.found.more", { count: seen.count - seen.pages.length }) : null,
          },
    seenEarlier:
      earlier === undefined
        ? null
        : {
            line: t("claim.seenEarlier"),
            href: earlierHref === null ? null : `/passport/${earlierHref}`,
            text: earlierHref === null ? earlier : shortHex(earlierHref, 10, 8),
            label: t("mark.openEarlier"),
          },
  };
}

/**
 * Where the claim comes from, and what the registrant said in their own
 * words. The strength line is Moolam's reading of the chain's fields; every
 * line under the rule is the registrant's statement, set in their voice, and
 * the web pages they listed are text a reader can copy, never links.
 */
export function ClaimLines({ copy }: { copy: ClaimCopy }) {
  return (
    <>
      <p data-claim-strength className="max-w-[58ch] text-base leading-relaxed text-text">
        {copy.strength}
      </p>
      {copy.outside === null ? null : (
        <p data-claim-outside className="mt-3 max-w-[58ch] border-s-2 border-failed/60 ps-4 text-base leading-relaxed text-text-muted">
          {copy.outside}
        </p>
      )}
      {copy.sworn === null &&
      copy.platformStatement === null &&
      copy.seenOnline === null &&
      copy.seenEarlier === null ? null : (
        <div data-claim-statements className="mt-5 max-w-[60ch] space-y-4 border-s-2 border-line-strong ps-5">
          {copy.sworn === null ? null : (
            <p data-claim-sworn className="font-display text-[17px] font-semibold leading-snug tracking-[-0.01em] text-text">
              {copy.sworn}
            </p>
          )}
          {copy.platformStatement === null ? null : (
            <figure data-claim-platform-statement>
              {copy.platformStatement.label === null ? null : (
                <figcaption className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">
                  {copy.platformStatement.label}
                </figcaption>
              )}
              <blockquote className="mt-1.5 text-base leading-relaxed text-text">{copy.platformStatement.text}</blockquote>
            </figure>
          )}
          {copy.seenEarlier === null ? null : (
            <div data-claim-seen-earlier>
              <p className="text-base leading-relaxed text-text-muted">{copy.seenEarlier.line}</p>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                {copy.seenEarlier.href === null ? (
                  <span className="break-all font-mono text-xs text-text-muted">{copy.seenEarlier.text}</span>
                ) : (
                  <Link
                    href={copy.seenEarlier.href}
                    className="tap group inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:text-accent"
                  >
                    {copy.seenEarlier.label}
                    <span className="normal-case tracking-normal text-text-faint transition-colors duration-200 group-hover:text-accent">
                      {copy.seenEarlier.text}
                    </span>
                  </Link>
                )}
              </p>
            </div>
          )}
          {copy.seenOnline === null ? null : (
            <div data-claim-seen-online>
              <p className="text-base leading-relaxed text-text-muted">{copy.seenOnline.line}</p>
              <ul className="mt-2 space-y-1">
                {copy.seenOnline.pages.map((page) => (
                  <li key={page} className="break-all font-mono text-xs leading-relaxed text-text-faint">
                    {page}
                  </li>
                ))}
              </ul>
              {copy.seenOnline.more === null ? null : (
                <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">{copy.seenOnline.more}</p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
