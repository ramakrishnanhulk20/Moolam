"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useId, useState } from "react";
import { Spinner } from "./bits";
import { postForget, postRemember } from "./picture-api";

/**
 * After a claim: the offer to send every later picture straight to the address this passport just
 * moved to. The address is the one Moolam's connect page shared and the visitor confirmed, and the
 * move proved it can hold a passport. Dreamloom keeps it for this browser's session only.
 */
export function RememberAddress({
  address,
  remembered,
  onRemembered,
}: {
  address: string;
  remembered: string | null;
  onRemembered: (address: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const boxId = useId();
  const on = remembered !== null && remembered.toLowerCase() === address.toLowerCase();

  async function toggle() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const answer = on ? await postForget() : await postRemember(address);
    setSaving(false);
    if (answer.ok) onRemembered(answer.value.address);
    else setProblem(answer.refusal.words);
  }

  return (
    <RememberAddressView
      boxId={boxId}
      address={address}
      on={on}
      saving={saving}
      problem={problem}
      onToggle={() => void toggle()}
    />
  );
}

/** What the offer draws, apart from its requests, so both of its states can be drawn and checked on their own. */
export function RememberAddressView({
  boxId,
  address,
  on,
  saving,
  problem,
  onToggle,
}: {
  boxId: string;
  address: string;
  on: boolean;
  saving: boolean;
  problem: string | null;
  onToggle: () => void;
}) {
  return (
    <div>
      <label
        htmlFor={boxId}
        className={`group flex cursor-pointer items-start gap-3.5 rounded-2xl p-4 ring-1 transition duration-200 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sun ${on ? "bg-white/[0.08] ring-2 ring-sun/70" : "bg-white/[0.06] ring-white/15 hover:bg-white/10 hover:ring-sun/60"}`}
      >
        <input id={boxId} type="checkbox" checked={on} disabled={saving} onChange={onToggle} className="sr-only" />
        <span
          aria-hidden
          className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg border-2 transition ${on ? "border-sun bg-sun text-ink" : "border-white/40 group-hover:border-sun"}`}
        >
          {saving ? (
            <span className="scale-75 text-white">
              <Spinner />
            </span>
          ) : (
            on && (
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            )
          )}
        </span>
        <span className="min-w-0">
          <span className="block font-display text-lg leading-tight font-bold text-white">
            Send my future pictures straight to my Moolam account
          </span>
          <span className="mt-1 block text-sm text-white/65">
            {on
              ? "Next time, one press gives a picture its passport and hands it to you, with no window to open."
              : "Next time, one press gives a picture its passport and hands it to this address. Dreamloom keeps it for this browser only."}
          </span>
        </span>
      </label>

      <AnimatePresence initial={false}>
        {on && (
          <motion.div
            key="remembered"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pt-3 text-sm text-white/70">
              <span>
                Sending to <span className="font-mono text-[0.85rem] break-all text-sun">{address}</span>
              </span>
              <button
                type="button"
                onClick={onToggle}
                disabled={saving}
                className="cursor-pointer font-semibold text-white underline decoration-white/40 underline-offset-4 transition hover:text-sun hover:decoration-sun disabled:cursor-not-allowed disabled:opacity-60"
              >
                Forget my address
              </button>
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {problem !== null && (
        <p role="alert" className="mt-3 rounded-2xl border-2 border-[#ff8a9a]/40 bg-[#ff8a9a]/10 px-4 py-3 text-sm font-medium text-[#ffc2ca]">
          {problem}
        </p>
      )}
    </div>
  );
}
