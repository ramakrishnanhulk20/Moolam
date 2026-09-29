"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { SealedSketch } from "./Sketch";
import { sealedFieldsFor, type SealedPublicField } from "./fields";

/**
 * Every word this control says. They are props for the same reason the plate's
 * are: the studio will hand it the ten languages, and a default English string
 * hidden inside a component is how one of those ten quietly ships in English.
 */
export interface SealSwitchWords {
  label: string;
  note: string;
  panelHeading: string;
  panelLine: string;
  sketchCaption: string;
  /** What the right hand tag says about where a value lands. */
  inFile: string;
  onChain: string;
  /** The tag on a row the creator is leaving out. */
  leftOut: string;
  promptLabel: string;
  promptNote: string;
  /**
   * The private re-check's three lines. Optional so a screen that does not
   * offer the choice need not carry them; the choice is not drawn without them.
   */
  privateLabel?: string;
  privateNote?: string;
  /** Who can open the private copy. It names them, because "nobody" would be untrue. */
  privateWho?: string;
}

/**
 * What each row of the list is called, keyed by the field's own key.
 *
 * The list itself stays in fields.ts, held against the verify service's schema
 * by a test. Only the words are passed in, so the studio can hand it ten
 * languages without a second copy of the list existing anywhere.
 */
export type SealedFieldWords = Record<string, { label: string; line: string }>;

/**
 * The studio's one switch, and the panel that says what signing will publish.
 *
 * This is invariant 8 of the sealed threat model: the fingerprint sketch and
 * the list of public fields are on screen before the passkey prompt, never
 * after. The list is not written here. It comes from fields.ts, which is held
 * against the verify service's own schema by a test, so a field added to the
 * pinned document cannot appear without appearing here too.
 *
 * The control owns nothing. Whoever mounts it holds both answers.
 */
export function SealSwitch({
  on,
  onChange,
  bits,
  generated = false,
  includePrompt = false,
  onIncludePrompt,
  privateRecheck = false,
  onPrivateRecheck,
  words,
  fieldWords,
  disabled = false,
  className = "",
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The picture's block hash bits, once it has been fingerprinted. */
  bits: boolean[] | null;
  /** True when an agent drew this picture, which is what puts a prompt in the room. */
  generated?: boolean;
  includePrompt?: boolean;
  onIncludePrompt?: (include: boolean) => void;
  /** Whether one small private copy is kept for a Chainlink re-check. Only asked while sealed is on. */
  privateRecheck?: boolean;
  onPrivateRecheck?: (on: boolean) => void;
  words: SealSwitchWords;
  /** The rows in the reader's language. Without it each row keeps the English in fields.ts. */
  fieldWords?: SealedFieldWords;
  disabled?: boolean;
  className?: string;
}) {
  const reduced = useIsReducedMotion();
  const offersPrivate = onPrivateRecheck !== undefined && words.privateLabel !== undefined;
  const fields = sealedFieldsFor({ generated, privateRecheck: offersPrivate && privateRecheck });
  // The rows that come and go with the private re-check are drawn apart from
  // the rest, so they can arrive and leave without the list redrawing.
  const steady = fields.filter((field) => field.when !== "privateRecheck");
  const asked = fields.filter((field) => field.when === "privateRecheck");

  return (
    <div className={`relative border-t border-line pt-8 ${className}`}>
      <span aria-hidden className="pointer-events-none absolute -top-px start-0 h-px w-20 bg-accent" />

      <Switch on={on} onChange={onChange} disabled={disabled} label={words.label} reduced={reduced} />
      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-text-muted">{words.note}</p>

      <AnimatePresence initial={false}>
        {on ? (
          <motion.div
            key="public"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reduced ? { duration: 0.15 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {/* Straight under the switch it depends on, and above the list it
                adds a row to, so the row arrives below the thumb and the
                switch itself never moves when it is pressed. */}
            {offersPrivate ? (
              <div data-private-recheck className="mt-7 border-s-2 border-accent/50 ps-5">
                <Switch
                  on={privateRecheck}
                  onChange={onPrivateRecheck}
                  disabled={disabled}
                  label={words.privateLabel ?? ""}
                  reduced={reduced}
                  small
                />
                <p className="mt-3 max-w-[52ch] text-xs leading-relaxed text-text-faint">{words.privateNote}</p>
                <p className="mt-2 max-w-[52ch] text-xs leading-relaxed text-text-muted">{words.privateWho}</p>
              </div>
            ) : null}

            <div className="mt-7 border border-line bg-bg-raised p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-6">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-accent">{words.panelHeading}</p>
                  <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-text-muted">{words.panelLine}</p>
                </div>

                <figure className="shrink-0">
                  {bits === null ? (
                    <div className="grid h-[6.5rem] w-[6.5rem] place-items-center border border-dashed border-line-strong">
                      <span className="motif h-3 w-3 opacity-60" />
                    </div>
                  ) : (
                    <SealedSketch bits={bits} size="small" className="h-[6.5rem] w-[6.5rem]" />
                  )}
                  <figcaption className="mt-2.5 max-w-[16ch] font-mono text-[10px] leading-snug text-text-faint">
                    {words.sketchCaption}
                  </figcaption>
                </figure>
              </div>

              <ul className="mt-7">
                {steady.map((field) => (
                  <li key={field.key} className={ROW}>
                    <RowWords
                      field={field}
                      said={fieldWords?.[field.key]}
                      tag={field.source === "chain" ? words.onChain : words.inFile}
                      leftOut={field.optional === true && !includePrompt ? words.leftOut : null}
                    />
                  </li>
                ))}
                <AnimatePresence initial={false}>
                  {asked.map((field) => (
                    <motion.li
                      key={field.key}
                      initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={reduced ? { duration: 0.15 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className={ROW}>
                        <RowWords field={field} said={fieldWords?.[field.key]} tag={words.inFile} leftOut={null} />
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>

              {generated && onIncludePrompt !== undefined ? (
                <div className="mt-7 border-s-2 border-accent/50 ps-5">
                  <Switch
                    on={includePrompt}
                    onChange={onIncludePrompt}
                    disabled={disabled}
                    label={words.promptLabel}
                    reduced={reduced}
                    small
                  />
                  <p className="mt-3 max-w-[52ch] text-xs leading-relaxed text-text-faint">{words.promptNote}</p>
                </div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const ROW =
  "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 border-t border-line py-3.5 sm:flex-nowrap";

/** One row of the list: the key as the document writes it, what it is, and why it is there. */
function RowWords({
  field,
  said,
  tag,
  leftOut,
}: {
  field: SealedPublicField;
  said?: { label: string; line: string };
  tag: string;
  leftOut: string | null;
}) {
  const label = said?.label ?? field.label;
  const line = said?.line ?? field.line;

  return (
    <>
      <span className="min-w-0">
        <span className={`block text-sm font-medium leading-snug ${leftOut === null ? "text-text" : "text-text-faint"}`}>
          {label}
        </span>
        <span className="mt-1 block max-w-[52ch] text-xs leading-relaxed text-text-faint">{line}</span>
      </span>
      {/* Wraps on a phone: a long key and its tag are wider than the row at 375. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] sm:shrink-0 sm:flex-nowrap">
        {leftOut === null ? null : <span className="text-text-faint">{leftOut}</span>}
        {/* The file's real field name, so it keeps the file's own case and is
            never translated: it is what a reader will find if they open it. */}
        <code data-field-key dir="ltr" className="text-[11px] normal-case tracking-normal text-text-faint/80">
          {field.key}
        </code>
        <span className="text-accent">{tag}</span>
      </span>
    </>
  );
}

/**
 * The switch itself: a real one, so a screen reader hears "switch, off" rather
 * than a button whose state it has to guess from the words around it.
 */
function Switch({
  on,
  onChange,
  disabled,
  label,
  reduced,
  small = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled: boolean;
  label: string;
  reduced: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="tap group flex items-center gap-4 text-start disabled:opacity-60"
    >
      <span
        aria-hidden
        className={`relative flex shrink-0 items-center rounded-full border transition-colors duration-200 ${
          small ? "h-[22px] w-[40px]" : "h-[26px] w-[48px]"
        } ${on ? "border-accent bg-accent-soft" : "border-line-strong bg-bg group-hover:border-accent"}`}
      >
        <motion.span
          className={`absolute rounded-full ${small ? "h-3.5 w-3.5" : "h-4 w-4"} ${
            on ? "bg-accent" : "bg-text-faint group-hover:bg-accent"
          }`}
          animate={{ x: on ? (small ? 21 : 26) : 4 }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 36 }}
        />
      </span>
      <span
        className={`font-display font-semibold uppercase tracking-[-0.01em] transition-colors duration-200 group-hover:text-accent ${
          small ? "text-[0.95rem] leading-tight" : "text-[clamp(1.05rem,2vw,1.35rem)] leading-[1.1]"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
