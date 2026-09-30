"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { OutArrow } from "./bits";
import { passportLink, shortHash, transactionLink } from "./moolam-links";
import { failureWords, type PictureView } from "./picture-api";

/**
 * The passport, on Moolam's own dark plate so a visitor sees it is kept by Moolam and not by
 * Dreamloom. Every fact on it came back from Dreamloom's server, which writes a fact only from a
 * receipt the kit checked (D7).
 */
export function PassportPanel({
  picture,
  moolamSite,
  children,
}: {
  picture: PictureView;
  moolamSite: string;
  children?: ReactNode;
}) {
  const href = picture.passportId === undefined ? null : passportLink(moolamSite, picture.passportId);
  const registerHref = picture.registerTx === undefined ? null : transactionLink(picture.registerTx);
  const moveHref = picture.moveTx === undefined ? null : transactionLink(picture.moveTx);
  const moved = picture.state === "moved";

  const holder = moved
    ? "Dreamloom registered it, and it is now held by your Moolam account."
    : picture.mode === "cosign"
      ? "You signed it, so Moolam names you as its creator."
      : "Dreamloom registered it under its own name and holds it for now.";

  return (
    <motion.div
      initial={{ opacity: 0, y: 28, rotate: 1.5 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ type: "spring", stiffness: 110, damping: 18, delay: 0.1 }}
      className="relative overflow-hidden rounded-[2rem] bg-[#14121c] p-5 text-white shadow-[0_40px_80px_-40px_rgba(23,18,43,0.8)] sm:p-8"
    >
      <div aria-hidden className="bg-daybreak absolute inset-x-0 top-0 h-1.5" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-violet/30 blur-3xl"
      />

      <div className="relative flex items-center gap-2.5">
        <img src="/moolam-mark.svg" alt="" width={28} height={28} className="size-7" />
        <span className="text-sm font-bold tracking-[0.14em] text-white/80 uppercase">Moolam passport</span>
      </div>

      {picture.title !== undefined && (
        <p className="relative mt-4 font-display text-[clamp(1.35rem,2.2vw,1.85rem)] leading-[1.08] font-extrabold tracking-[-0.03em] break-words">
          {picture.title}
        </p>
      )}
      <p className="relative mt-3 max-w-[34rem] text-base text-white/75">{holder}</p>

      {picture.failure === "terms" && (
        <p className="relative mt-4 rounded-2xl border-2 border-sun/40 bg-sun/10 px-4 py-3 text-sm font-medium text-sun">
          {failureWords("terms")}
        </p>
      )}

      <dl className="relative mt-6 grid gap-3 text-sm sm:grid-cols-2">
        {picture.passportId !== undefined && <Fact label="Passport" value={picture.passportId} full={moved} />}
        {registerHref !== null && picture.registerTx !== undefined && (
          <Fact label="Registered in" value={picture.registerTx} href={registerHref} />
        )}
        {moveHref !== null && picture.moveTx !== undefined && <Fact label="Moved in" value={picture.moveTx} href={moveHref} />}
        {moved && picture.movedTo !== undefined && <Fact label="Moved to" value={picture.movedTo} full />}
      </dl>

      {href !== null && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative mt-7 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-sun px-5 py-3 text-center font-display text-[1.05rem] leading-tight font-bold text-balance text-ink sm:px-7 sm:text-lg transition duration-200 hover:-translate-y-0.5 hover:bg-white focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-sun sm:w-auto"
        >
          Open the passport on Moolam
          <OutArrow className="size-5" />
        </a>
      )}

      {children !== undefined && <div className="relative mt-7 border-t border-white/10 pt-7">{children}</div>}
    </motion.div>
  );
}

function Fact({ label, value, href, full = false }: { label: string; value: string; href?: string; full?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl bg-white/[0.06] px-3.5 py-2.5 ring-1 ring-white/10 ${full ? "sm:col-span-2" : ""}`}>
      <dt className="text-xs font-semibold tracking-[0.12em] text-white/55 uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-[0.85rem] break-all text-white">
        {href === undefined ? (
          <span title={value}>{full ? value : shortHash(value)}</span>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={value}
            className="group inline-flex items-center gap-1 underline decoration-white/30 underline-offset-4 transition hover:text-sun hover:decoration-sun"
          >
            {shortHash(value)}
            <OutArrow className="size-3.5" />
          </a>
        )}
      </dd>
    </div>
  );
}
