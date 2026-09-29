"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { Picture } from "@/components/passport/Picture";
import { pictureSources } from "@/lib/images";
import { Link } from "@/lib/i18n/routing";
import { Marks, type MarkWords } from "./Marks";
import type { AgentStrip, StripTile } from "./strip";

/**
 * The agent's newest real pictures, under its name: what it actually drew,
 * before the numbers about how it has held up.
 *
 * Only real pictures are drawn, never a row of empty places. An agent whose
 * every passport is a test image says that in a line instead, because five
 * seal plates read as five pictures that failed to load.
 *
 * It sits above the row's own link, so each tile opens its passport and the
 * rest of the row still opens the agent.
 */
export function PictureStrip({ strip }: { strip: AgentStrip }) {
  const t = useTranslations("agents");
  const works = useTranslations("agent.works");
  const explore = useTranslations("explore");
  const reduced = useIsReducedMotion();

  if (strip.onlyTest) {
    return (
      <p data-agent-strip="test" className="relative mt-5 max-w-[46ch] text-base leading-relaxed text-text-muted">
        {works("onlyTest")}
      </p>
    );
  }
  if (strip.tiles.length === 0) {
    return null;
  }

  const words: MarkWords = {
    manifest: explore("marks.manifest"),
    rechecked: explore("marks.rechecked"),
    chainlink: explore("marks.chainlink"),
    disputed: explore("marks.disputed"),
    sealed: explore("sealed.mark"),
  };

  return (
    <ul
      data-agent-strip="pictures"
      aria-label={t("strip.label")}
      className="relative z-10 mt-6 grid max-w-[33rem] grid-cols-5 gap-1.5 sm:gap-2"
    >
      {strip.tiles.map((tile, place) => (
        <motion.li
          key={tile.id}
          initial={reduced ? false : { opacity: 0, y: 14 }}
          whileInView={reduced ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.15 + place * 0.06 }}
          className="min-w-0"
        >
          <Tile tile={tile} words={words} missing={explore("noPicture")} />
        </motion.li>
      ))}
    </ul>
  );
}

/**
 * One square of the strip in the Explore plate's language: the same picture
 * through the same optimizer, the same grain and scrim, the same lit marks and
 * the same seal and words when the gateway will not serve it.
 */
function Tile({ tile, words, missing }: { tile: StripTile; words: MarkWords; missing: string }) {
  const common = useTranslations("common");
  const seal = (
    <span data-plate-seal className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-1.5 text-center">
      <span className="motif h-4 w-4 shrink-0 opacity-70 transition-opacity duration-500 group-hover/tile:opacity-100" />
      <span className="hidden font-mono text-[8px] uppercase leading-tight tracking-[0.16em] text-text-faint @[6.5rem]:block">
        {missing}
      </span>
    </span>
  );

  return (
    <Link
      href={`/passport/${tile.id}`}
      title={tile.title ?? undefined}
      data-strip-tile
      className="group/tile @container relative block aspect-square overflow-hidden bg-bg-sunken outline-offset-[-2px]"
    >
      {tile.thumbnailUrl === null ? (
        seal
      ) : (
        <Picture
          sources={pictureSources(tile.thumbnailUrl)}
          alt={tile.title ?? common("registeredPicture")}
          // Five across a column that is at most 33rem wide on a laptop, and
          // a fifth of a phone's width.
          sizes="(min-width: 640px) 104px, 20vw"
          className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/tile:scale-[1.07]"
          fallback={seal}
        />
      )}
      <span className="grain pointer-events-none absolute inset-0" />
      <span
        aria-hidden
        data-scrim="dark"
        className="pointer-events-none absolute inset-x-0 top-0 h-[45%] bg-[linear-gradient(to_bottom,var(--scrim-from),var(--scrim-to))] opacity-80 [.light_&]:hidden"
      />
      <Marks marks={tile} words={words} litOnly className="absolute end-1 top-1 gap-0.5" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-500 group-hover/tile:border-accent/70"
      />
    </Link>
  );
}
