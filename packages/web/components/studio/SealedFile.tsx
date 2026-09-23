"use client";

import { motion } from "framer-motion";
import { useFormatter, useTranslations } from "next-intl";
import { sketchBits } from "@/components/sealed/bits";
import { SEALED_PUBLIC_FIELDS } from "@/components/sealed/fields";
import { SealSwitch, type SealedFieldWords } from "@/components/sealed/SealSwitch";
import { SealedPlate } from "@/components/sealed/SealedPlate";
import { SealedSketch } from "@/components/sealed/Sketch";
import { useSealedSave } from "@/lib/sealed/save";
import type { SealedHandback } from "@/lib/sealed/handback";

/**
 * The studio's half of the sealed pieces: the switch with its words, the card
 * that hands the file back before the passkey prompt, and the band the done
 * screen shows where a published picture would be.
 *
 * The drawing and the list itself live in components/sealed, which the lab
 * bench also mounts. What is here is only the ten languages and the one control
 * that writes a file to the creator's disk.
 */

/** The 256 bits of a block hash, or null when there is no fingerprint yet or it is not a whole word. */
export function sketchOf(blockhash: string | undefined | null): boolean[] | null {
  if (blockhash === undefined || blockhash === null) {
    return null;
  }
  try {
    return sketchBits(blockhash);
  } catch {
    return null;
  }
}

/** The switch and the "what becomes public" panel, in the reader's language. */
export function SealedChoice({
  on,
  onChange,
  bits,
  generated = false,
  includePrompt = false,
  onIncludePrompt,
  privateRecheck = false,
  onPrivateRecheck,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  bits: boolean[] | null;
  generated?: boolean;
  includePrompt?: boolean;
  onIncludePrompt?: (include: boolean) => void;
  /** The private re-check under the switch. Not offered unless a handler is passed. */
  privateRecheck?: boolean;
  onPrivateRecheck?: (on: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("studio.sealed.switch");
  const rows = useTranslations("studio.sealed.fields");

  const fieldWords: SealedFieldWords = Object.fromEntries(
    SEALED_PUBLIC_FIELDS.map((field) => [
      field.key,
      { label: rows(`${field.key}.label`), line: rows(`${field.key}.line`) },
    ]),
  );

  return (
    <SealSwitch
      on={on}
      onChange={onChange}
      bits={bits}
      generated={generated}
      includePrompt={includePrompt}
      onIncludePrompt={onIncludePrompt}
      privateRecheck={privateRecheck}
      onPrivateRecheck={onPrivateRecheck}
      disabled={disabled}
      className="mt-10"
      words={{
        label: t("label"),
        note: t("note"),
        panelHeading: t("panelHeading"),
        panelLine: t("panelLine"),
        sketchCaption: t("sketchCaption"),
        inFile: t("inFile"),
        onChain: t("onChain"),
        leftOut: t("leftOut"),
        promptLabel: t("promptLabel"),
        promptNote: t("promptNote"),
        privateLabel: t("privateLabel"),
        privateNote: t("privateNote"),
        privateWho: t("privateWho"),
      }}
      fieldWords={fieldWords}
    />
  );
}

/**
 * The one copy of the picture, on screen before the passkey prompt opens.
 *
 * This is the creator's last chance to take the file before they commit to its
 * hash, and the flow waits for a frame so the card is actually drawn under the
 * prompt rather than found behind it afterwards. The plate beside it is the
 * fingerprint from the same answer: what the public will see of this picture,
 * and nothing more.
 */
export function SealedFileCard({
  file,
  bits,
  title,
  saved,
  onSaved,
  privateCopy = false,
}: {
  file: SealedHandback;
  bits: boolean[] | null;
  title: string;
  saved: boolean;
  onSaved: () => void;
  /** True only when the service's own answer says it kept the small private copy. */
  privateCopy?: boolean;
}) {
  const t = useTranslations("studio.sealed.handback");

  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      data-sealed-file={saved ? "saved" : "held"}
      className="relative mt-9 border border-accent/40 bg-bg-sunken p-5 sm:p-7"
    >
      <span aria-hidden className="pointer-events-none absolute -top-px start-0 h-px w-24 bg-accent" />

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
        <div className="w-[min(11rem,45%)] shrink-0">
          <Plate bits={bits} title={title} privateCopy={privateCopy} />
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-accent">{t("kicker")}</p>
          <h3 className="mt-3 max-w-[22ch] font-display text-[clamp(1.2rem,2.4vw,1.7rem)] font-semibold uppercase leading-[1.05] tracking-[-0.02em]">
            {t("heading")}
          </h3>
          <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-text-muted">
            {privateCopy ? t("bodyPrivate") : t("body")}
          </p>
          <SaveControl file={file} saved={saved} onSaved={onSaved} />
        </div>
      </div>
    </motion.section>
  );
}

/**
 * Where the picture would be on a done screen, for a passport that has none.
 *
 * It says sealed in words rather than showing an empty frame: invariant 7 of
 * the threat model is that a sealed passport never reads as a picture that
 * failed to load.
 */
export function SealedDoneBand({
  file,
  bits,
  title,
  registeredAt,
  saved,
  onSaved,
  privateCopy = false,
}: {
  /** Null when this browser no longer holds the file, which a reload leaves behind. */
  file: SealedHandback | null;
  bits: boolean[] | null;
  title: string;
  registeredAt: number | null;
  saved: boolean;
  onSaved: () => void;
  /** True only when the service's own answer says it kept the small private copy. */
  privateCopy?: boolean;
}) {
  const t = useTranslations("studio.sealed.done");

  return (
    <div className="relative grid gap-7 border-b border-line bg-bg-sunken p-6 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:p-9">
      <span
        aria-hidden
        className="pointer-events-none absolute end-[6%] top-[-18%] h-[70%] w-[46%] rounded-full bg-accent-soft blur-[70px]"
      />
      <div className="relative w-[min(13rem,60%)] sm:w-full">
        <Plate bits={bits} title={title} registeredAt={registeredAt} privateCopy={privateCopy} />
      </div>

      <div className="relative min-w-0">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-verified">
          <span className="motif h-[9px] w-[9px]" />
          {t("label")}
        </p>
        <p className="mt-4 max-w-[44ch] text-sm leading-relaxed text-text-muted">
          {privateCopy ? t("bodyPrivate") : t("body")}
        </p>
        {file === null ? null : <SaveControl file={file} saved={saved} onSaved={onSaved} />}
      </div>
    </div>
  );
}

/**
 * The agent's plate once it has drawn a picture that will not be published.
 *
 * The frame is the one a published drawing lands in, so the screen does not
 * jump when the answer arrives. What fills it is the fingerprint, which is the
 * only part of this picture anyone else will ever see.
 */
export function SealedDrawing({ bits, label, model }: { bits: boolean[] | null; label: string; model: string }) {
  return (
    <div className="relative flex min-h-[14rem] flex-col items-center justify-center gap-5 p-8 sm:flex-row sm:items-end sm:justify-between sm:p-10">
      <span
        aria-hidden
        className="pointer-events-none absolute start-[8%] top-[-20%] h-[80%] w-[52%] rounded-full bg-accent-soft blur-[70px]"
      />
      {bits === null ? null : (
        <SealedSketch bits={bits} size="plate" className="relative h-[9rem] w-[9rem] sm:h-[11rem] sm:w-[11rem]" />
      )}
      <div className="relative text-center sm:text-end">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent">{label}</p>
        <p className="mt-2 font-mono text-[11px] text-text-faint">{model}</p>
      </div>
    </div>
  );
}

/** The button that writes the file, the warning beside it, and what it says once it has been used. */
function SaveControl({ file, saved, onSaved }: { file: SealedHandback; saved: boolean; onSaved: () => void }) {
  const t = useTranslations("studio.sealed.handback");
  const save = useSealedSave(file, onSaved);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={save}
          data-save-sealed
          className="rounded-[8px] bg-accent px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
        >
          {t("save")}
        </button>
        <p className="break-all font-mono text-[11px] text-text-faint">
          {file.name} <span className="ms-1">{megabytes(file.size)}</span>
        </p>
      </div>
      <p className={`mt-4 max-w-[46ch] text-xs leading-relaxed ${saved ? "text-text-faint" : "text-accent"}`}>
        {t("only")}
      </p>
      {saved ? <p className="mt-2 max-w-[46ch] text-xs leading-relaxed text-verified">{t("saved")}</p> : null}
    </div>
  );
}

/**
 * The sealed plate, or the frame it will fill once the fingerprint is in.
 *
 * With a private copy kept the creator no longer holds the only copy, only the
 * only full one, and the plate has to say so rather than the older sentence.
 */
function Plate({
  bits,
  title,
  registeredAt,
  privateCopy,
}: {
  bits: boolean[] | null;
  title: string;
  registeredAt?: number | null;
  privateCopy: boolean;
}) {
  const t = useTranslations("studio.sealed.plate");
  const format = useFormatter();

  if (bits === null) {
    return <div className="aspect-[4/5] w-full border border-dashed border-line-strong bg-bg" />;
  }

  const line =
    registeredAt === undefined || registeredAt === null
      ? t(privateCopy ? "linePrivate" : "line")
      : t("registered", { date: format.dateTime(new Date(registeredAt), { dateStyle: "medium" }) });

  return (
    <SealedPlate
      bits={bits}
      title={title.trim().length === 0 ? null : title}
      words={{ sealed: t("sealed"), untitled: t("untitled"), line }}
    />
  );
}

function megabytes(size: number): string {
  return `${(size / 1_000_000).toFixed(1)} MB`;
}
