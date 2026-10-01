"use client";

import { motion } from "framer-motion";
import { OutArrow } from "./bits";
import { mineLabel, mineLink } from "./moolam-links";
import type { PictureView } from "./picture-api";

export interface DeliveryWords {
  lead: string;
  /** The words before the address, the masked address, and the words between it and the link. */
  before: string;
  masked: string | null;
  between: string;
  href: string;
  label: string;
}

/**
 * What the ticket says. The address is the mask Dreamloom's server kept (first letter, stars, the
 * domain); the page never has the address itself.
 */
export function deliveryWords(delivery: NonNullable<PictureView["delivery"]>, moolamSite: string): DeliveryWords {
  const href = mineLink(moolamSite);
  const label = mineLabel(moolamSite);
  if (delivery.kind === "straight") {
    return { lead: "Your passport went straight to your Moolam account.", before: "", masked: null, between: "See it at ", href, label };
  }
  return { lead: "Your passport is waiting at Moolam.", before: "Claim it with ", masked: delivery.to, between: " at ", href, label };
}

function hostAndPath(label: string): [string, string] {
  const at = label.indexOf("/");
  return at === -1 ? [label, ""] : [label.slice(0, at), label.slice(at)];
}

/**
 * A ticket stub on the passport plate: where the passport went for a visitor who was signed in with
 * Google. The perforation and the stub repeat the passport-and-ticket idea Moolam's claim runs on.
 */
export function DeliveryTicket({ delivery, moolamSite }: { delivery: NonNullable<PictureView["delivery"]>; moolamSite: string }) {
  const words = deliveryWords(delivery, moolamSite);
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, rotate: -1.2 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ type: "spring", stiffness: 120, damping: 17, delay: 0.35 }}
      className="relative mt-6 flex overflow-hidden rounded-2xl bg-white/[0.07] ring-1 ring-sun/35"
    >
      <div aria-hidden className="bg-daybreak relative flex w-14 shrink-0 items-center justify-center sm:w-20">
        <svg viewBox="0 0 24 24" className="size-6 text-white sm:size-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {delivery.kind === "straight" ? (
            <path d="M4 12.5l5 5L20 6.5" />
          ) : (
            <>
              <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
              <path d="M3.5 7l8.5 6.5L20.5 7" />
            </>
          )}
        </svg>
        <span className="absolute -top-2 -right-2 size-4 rounded-full bg-[#14121c]" />
        <span className="absolute -right-2 -bottom-2 size-4 rounded-full bg-[#14121c]" />
      </div>
      <div className="min-w-0 border-l-2 border-dashed border-white/20 px-4 py-4 sm:px-5">
        <p className="font-display text-lg leading-tight font-bold text-white sm:text-xl">{words.lead}</p>
        <p className="mt-1.5 text-base text-white/75">
          {words.before}
          {words.masked !== null && <span className="font-mono text-[0.95rem] font-semibold whitespace-nowrap text-sun">{words.masked}</span>}
          {words.between}
          <a
            href={words.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline font-semibold [overflow-wrap:anywhere] text-white underline decoration-white/35 underline-offset-4 transition hover:text-sun hover:decoration-sun"
          >
            {/* A narrow phone breaks the address after the host, never inside a word. */}
            {hostAndPath(words.label)[0]}
            <wbr />
            {hostAndPath(words.label)[1]}
            <OutArrow className="ml-1 inline size-3.5 align-[-0.1em]" />
          </a>
        </p>
      </div>
    </motion.div>
  );
}
