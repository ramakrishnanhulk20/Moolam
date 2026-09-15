import { getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import { Picture } from "@/components/passport/Picture";
import { MONAD_EXPLORER, addresses, shortHex } from "@/lib/chain/client";
import { pictureSources } from "@/lib/images";
import type { AgentCard } from "./card";
import type { SignedWork } from "./signed";

/**
 * The agent as a contact sheet: every picture it has signed, tiled behind its
 * name, with the scrim over the lot. An agent that has signed nothing gets the
 * seal on a dark plate instead of an empty grid, which would read as broken.
 */
export async function AgentPoster({
  agentId,
  owner,
  card,
  works,
}: {
  agentId: bigint;
  owner: Hex;
  card: AgentCard | null;
  works: SignedWork[];
}) {
  const t = await getTranslations("agent");
  const pictures = works.filter((work): work is SignedWork & { thumbnailUrl: string } => work.thumbnailUrl !== undefined);
  // The sheet is a fixed twelve cells so it fills the frame at any width. With
  // fewer pictures than cells the agent's own pictures come round again rather
  // than leaving holes in the wall.
  const tiles = pictures.length === 0 ? [] : Array.from({ length: 12 }, (_, cell) => pictures[cell % pictures.length]);

  return (
    <header className="grain relative min-h-[30rem] w-full overflow-hidden border-b border-line bg-bg-sunken sm:min-h-[38rem]">
      {tiles.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="motif h-10 w-10 opacity-60" />
        </div>
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 grid auto-rows-fr grid-cols-3 grid-rows-4 opacity-45 sm:grid-cols-4 sm:grid-rows-3 lg:grid-cols-6 lg:grid-rows-2"
        >
          {tiles.map((work, cell) => (
            // Pinned thumbnails of this agent's own passports. The same few
            // files fill twelve cells, and the optimizer serves all twelve from
            // one read of the gateway.
            <div key={`${work.id}-${cell}`} className="relative">
              <Picture
                sources={pictureSources(work.thumbnailUrl)}
                sizes="(min-width: 1024px) 17vw, (min-width: 640px) 25vw, 34vw"
                className="object-cover"
              />
            </div>
          ))}
        </div>
      )}
      <div className="scrim pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "linear-gradient(to right, var(--scrim-from) 8%, var(--scrim-to) 78%)" }}
      />

      <div className="relative mx-auto flex min-h-[30rem] w-full max-w-[1400px] flex-col justify-end px-5 py-12 sm:min-h-[38rem] sm:px-8 sm:py-16">
        <p className="rise flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent">
          <span className="motif h-[10px] w-[10px]" />
          {t("title")} {agentId.toString()}
        </p>

        <h1
          className="rise mt-6 max-w-[15ch] font-display text-[clamp(2.4rem,7.5vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.04em]"
          style={{ animationDelay: "60ms" }}
        >
          {card?.name ?? t("unnamed")}
        </h1>

        {card?.description === undefined ? null : (
          <p
            className="rise mt-7 max-w-[58ch] text-base leading-relaxed text-text-muted sm:text-lg"
            style={{ animationDelay: "120ms" }}
          >
            {card.description}
          </p>
        )}

        {card === null ? (
          <p className="rise mt-7 max-w-[52ch] text-sm leading-relaxed text-text-muted" style={{ animationDelay: "120ms" }}>
            {t("cardMissing")}
          </p>
        ) : null}

        <div
          className="rise mt-9 flex flex-wrap items-center gap-x-8 gap-y-3 font-mono text-[11px] uppercase tracking-[0.2em]"
          style={{ animationDelay: "180ms" }}
        >
          <span className="text-text-faint">{t("owner")}</span>
          <a
            href={`${MONAD_EXPLORER}/address/${owner}`}
            target="_blank"
            rel="noreferrer"
            className="text-text transition-colors duration-200 hover:text-accent"
          >
            {shortHex(owner)}
          </a>
          <a
            href={`${MONAD_EXPLORER}/address/${addresses.agentIdentity}`}
            target="_blank"
            rel="noreferrer"
            className="text-text-faint transition-colors duration-200 hover:text-accent"
          >
            {t("identityRegistry")}
          </a>
          {card?.active === true ? <span className="text-verified">{t("active")}</span> : null}
        </div>
      </div>
    </header>
  );
}
