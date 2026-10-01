"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { HEX_MARK, withHex } from "@/components/agents/hex";
import { UseMark } from "@/components/consent/Marks";
import { SUMMARY_TONES, USE_TONES } from "@/components/consent/tones";
import { fractionOf } from "@/components/consent/ledger";
import type { BeatName, BeatTable } from "@/components/story/beats";
import type { StoryData } from "@/components/story/data";
import { bitsApart, degradeSteps, measurement } from "@/components/story/measurements";
import { pairAnchors } from "@/components/story/scene/field";
import { InlineLedger, type LedgerView } from "@/components/story/StatedLedger";
import { progress } from "@/components/story/signals";
import { USE_FIELDS } from "@/lib/chain/consent";
import { shortHex } from "@/lib/chain/client";
import { withoutDoubleStop } from "@/lib/i18n/sentence";

export interface StoryBeat {
  /** The beat in the table these words belong to. The table owns the timing and the side. */
  key: BeatName;
  body: ReactNode;
}

/**
 * The captions, written once and laid out twice: pinned over the scene, or
 * stacked down a still page for anyone who has asked for less motion. Every
 * figure in them comes out of the one record data.ts chose, and a beat the cut
 * left out has no words here either.
 */
export function useBeats(data: StoryData, table: BeatTable, ledger: LedgerView | null, still: boolean): StoryBeat[] {
  const t = useTranslations("story");
  // The five plain summaries belong to the passport card. The film borrows them
  // rather than keeping a second set, so the beat and the card a judge opens
  // next say the same words in the same language.
  const says = useTranslations("passport.consent.summary");
  const format = useFormatter();
  const locale = useLocale();

  const focal = data.focal;
  const block = focal?.block ?? "";
  const registered = focal === null ? "" : format.dateTime(new Date(focal.registeredAt * 1000), { dateStyle: "long" });
  const measuredOn = format.dateTime(new Date(measurement.measuredAt), { dateStyle: "long" });
  const has = (name: BeatName) => table.beat[name] !== undefined;
  const beats: StoryBeat[] = [];

  if (has("imagined") && focal !== null) {
    const credit = focal.credit ?? (focal.agentId === null ? { case: "photo" as const } : { case: "studio" as const });
    const tag =
      credit.case === "studio" || credit.case === "cosigned"
        ? t("imagined.tag", { creator: shortHex(focal.creator, 6, 4) })
        : null;
    beats.push({
      key: "imagined",
      body: (
        <>
          <Eyebrow>{t("imagined.kicker")}</Eyebrow>
          <Title>{credit.case === "photo" ? t("imagined.titlePhoto") : t("imagined.title")}</Title>
          <Body>
            {credit.case === "photo"
              ? t("imagined.bodyPhoto")
              : credit.case === "studio"
                ? t("imagined.body", { agent: focal.agentId ?? "" })
                : t("imagined.bodyPlatform", { platform: credit.platform })}
          </Body>
          {tag === null ? null : (
            <Typed
              text={tag}
              still={still}
              table={table}
              beat="imagined"
              from={0.55}
              to={0.85}
              className="mt-5 inline-block border-b border-accent pb-1 font-mono text-[13px] tracking-[0.06em] text-accent"
            />
          )}
        </>
      ),
    });
  }

  beats.push({
    key: "sealed",
    body: (
      <>
        <Eyebrow>{t("sealed.kicker")}</Eyebrow>
        <Title>{t("sealed.title")}</Title>
        <Body>{block === "" ? t("sealed.bodyNoBlock") : t("sealed.body", { block })}</Body>
        <Readout>
          {focal === null
            ? t("sealed.unread")
            : withHex(t("sealed.readout", { passport: HEX_MARK, date: registered }), shortHex(focal.id, 10, 8))}
        </Readout>
        {focal?.sworn === true ? <Readout className="mt-2">{t("sealed.readoutSworn")}</Readout> : null}
      </>
    ),
  });

  if (has("stated") && ledger !== null && data.statement !== null) {
    beats.push({
      key: "stated",
      body: (
        // The rule lies across the lower quarter of the frame, so the words
        // stand above it rather than through it, and the column is held to
        // the right 38 percent of the frame, which is what the shot leaves
        // beside the tilted print: a long summary (the German one) wraps there
        // rather than running its first letter under the picture. The still
        // page has no rule on the ground and no shot to clear, so nothing is
        // pulled up or held in there.
        <div className={still ? "" : "sm:-translate-y-[9vh] sm:ms-auto sm:max-w-[38vw]"}>
          <Eyebrow className="sm:justify-end">{t("stated.kicker")}</Eyebrow>
          {/* Balanced because this line is one short sentence the chain wrote,
              and in Japanese or Tamil the browser's own break left a single
              character alone on the second line. */}
          <Title className="text-balance sm:ms-auto sm:text-end">
            {t("stated.title", { summary: says(data.statement.summary) })}
          </Title>
          <Body className="sm:ms-auto sm:text-end">{t("stated.body")}</Body>
          {/* On a phone the drawing stacks here with the words, under the shot;
              from 640 px up the pinned one lies along the print's lower edge
              instead and this one is not drawn. On the still page it is simply
              here, finished. */}
          <InlineLedger view={ledger} driven={!still} className={still ? "mt-8 ms-auto" : "mt-6 sm:hidden"} />
          <Readout className="sm:ms-auto sm:text-end">
            {t("stated.readout", {
              written: format.dateTime(new Date(data.statement.at * 1000), { dateStyle: "long" }),
            })}
          </Readout>
        </div>
      ),
    });
  }

  if (has("asked") && data.statement !== null) {
    const statement = data.statement;
    beats.push({
      key: "asked",
      body: (
        <>
          <Eyebrow className="sm:justify-end">{t("asked.kicker")}</Eyebrow>
          <AskedExchange
            question={t("asked.question")}
            answer={says(statement.summary)}
            tone={SUMMARY_TONES[statement.summary].ink}
            marks={USE_FIELDS.map((field) => statement.consent[field])}
            still={still}
          />
          <Title className="sm:ms-auto sm:text-end">{t("asked.title")}</Title>
          <Body className="sm:ms-auto sm:text-end">{t("asked.body")}</Body>
          <Readout className="sm:ms-auto sm:text-end">{t("asked.readout")}</Readout>
        </>
      ),
    });
  }

  beats.push({
    key: "shared",
    body: (
      <>
        <Eyebrow className="sm:justify-end">{t("shared.kicker")}</Eyebrow>
        <Title className="sm:ms-auto sm:text-end">{t("shared.title")}</Title>
        <Body className="sm:ms-auto sm:text-end">{t("shared.body")}</Body>
      </>
    ),
  });

  beats.push({
    key: "verified",
    body: (
      <>
        <Eyebrow>{t("verified.kicker")}</Eyebrow>
        {/* Held narrower than the other titles: the print takes the right of
            this shot from the snap on, and the line must end before it. */}
        <Title className="sm:max-w-[13ch]">{t("verified.title")}</Title>
        <Ladder label={t("verified.match")} still={still} />
        <Readout>
          {focal?.measured === true
            ? t("verified.provenanceSelf", { date: measuredOn })
            : withHex(
                t("verified.provenance", { passport: HEX_MARK, date: measuredOn }),
                shortHex(measurement.passportId, 8, 6),
              )}
        </Readout>
      </>
    ),
  });

  const check = data.check ?? null;
  if (has("checked") && check !== null) {
    const result = check.matched ? t("verified.matched") : t("verified.notMatched");
    const score =
      data.agent === null || data.agent.score === null
        ? null
        : t("checked.score", { agent: data.agent.id, score: data.agent.score });
    beats.push({
      key: "checked",
      body: (
        <>
          <Eyebrow className="sm:justify-end">{t("checked.kicker")}</Eyebrow>
          <Title className="sm:ms-auto sm:text-end">
            {check.form === "network" ? t("checked.title") : t("checked.testTitle")}
          </Title>
          <Body className="sm:ms-auto sm:text-end">
            {check.form === "network"
              ? t("checked.body")
              : check.form === "test"
                ? t("checked.testBody", { result, distance: check.distance })
                : t("verified.attestation", { result, distance: check.distance })}
          </Body>
          {check.form === "network" ? (
            <Readout className="sm:ms-auto sm:text-end">
              {t("checked.readout", {
                date: format.dateTime(new Date(check.at * 1000), { dateStyle: "long" }),
                result,
                distance: check.distance,
              })}
            </Readout>
          ) : null}
          {score === null ? null : <Readout className="mt-2 sm:ms-auto sm:text-end">{score}</Readout>}
        </>
      ),
    });
  }

  const lookalike = data.lookalike ?? null;
  if (has("lookalike") && lookalike !== null) {
    const name = (print: { title: string | null; id: string }) => print.title ?? shortHex(print.id, 6, 4);
    beats.push({
      key: "lookalike",
      body: (
        <>
          <Eyebrow>{t("lookalike.kicker")}</Eyebrow>
          <Title>{t("lookalike.title")}</Title>
          <Body>{t("lookalike.body")}</Body>
          <Readout>
            {t("lookalike.readout", {
              later: name(lookalike.later),
              earlier: name(lookalike.earlier),
              gap: gapIn(locale, lookalike.later.registeredAt - lookalike.earlier.registeredAt),
              bits: lookalike.bits,
              date: format.dateTime(new Date(lookalike.at * 1000), { dateStyle: "long" }),
            })}
          </Readout>
          <Readout className="mt-2">{t("lookalike.aside")}</Readout>
        </>
      ),
    });
  }

  const yourself = data.yourself ?? null;
  if (has("yourself") && yourself !== null) {
    beats.push({
      key: "yourself",
      body: (
        <>
          <Eyebrow>{t("yourself.kicker")}</Eyebrow>
          <Title>{t("yourself.title")}</Title>
          <Body>{t("yourself.body")}</Body>
          {/* The title carries its own full stop ("...alone in the moon."), so the template's is dropped after it. */}
          <Readout>
            {withoutDoubleStop(
              t("yourself.readout", { count: yourself.count, platforms: yourself.platforms, title: yourself.print.title }),
              yourself.print.title,
            )}
          </Readout>
        </>
      ),
    });
  }

  if (has("waiting")) {
    beats.push({
      key: "waiting",
      body: (
        <>
          <Eyebrow>{t("waiting.kicker")}</Eyebrow>
          <WaitingTag label={t("waiting.tag")} still={still} />
          <Title>{t("waiting.title")}</Title>
          <Body>{t("waiting.body")}</Body>
          <Readout>{t("waiting.readout")}</Readout>
        </>
      ),
    });
  }

  return beats;
}

/** A gap between two registrations in the largest whole unit, in the reader's language. */
export function gapIn(locale: string, seconds: number): string {
  const gap = Math.max(0, Math.floor(seconds));
  const units: [number, "day" | "hour" | "minute" | "second"][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const [size, unit] = units.find(([step]) => gap >= step) ?? [1, "second" as const];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(Math.floor(gap / size));
}

/** How far the scroll is through one beat's own share, 0 to 1, from the published scroll. */
function shareOf(table: BeatTable, beat: BeatName, from: number, to: number): number {
  const entry = table.beat[beat];
  if (entry === undefined) {
    return 1;
  }
  const local = (progress.scroll - entry.start) / Math.max(1e-6, entry.end - entry.start);
  return Math.min(1, Math.max(0, (local - from) / Math.max(1e-6, to - from)));
}

/**
 * A line that types itself on as its beat plays, written straight to the node
 * from an animation frame. The whole line is in the markup from the start, so
 * a screen reader and the still page read it whole.
 */
function Typed({
  text,
  still,
  table,
  beat,
  from,
  to,
  className,
}: {
  text: string;
  still: boolean;
  table: BeatTable;
  beat: BeatName;
  from: number;
  to: number;
  className: string;
}) {
  const shown = useRef<HTMLSpanElement>(null);
  const rest = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (still) {
      return;
    }
    let frame = 0;
    let last = -1;
    const letters = [...text];
    const loop = () => {
      const count = Math.round(letters.length * shareOf(table, beat, from, to));
      if (count !== last && shown.current !== null && rest.current !== null) {
        last = count;
        shown.current.textContent = letters.slice(0, count).join("");
        rest.current.textContent = letters.slice(count).join("");
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [beat, from, still, table, text, to]);

  return (
    <p data-story-line="readout" className={className}>
      <span ref={shown}>{text}</span>
      {/* The letters still to come keep their room, so nothing moves as it types. */}
      <span ref={rest} aria-hidden className="invisible" />
    </p>
  );
}

/**
 * The asked beat's exchange: a machine's question in mono, a beat of stillness,
 * then the answer in the terms' own colour with the four marks echoed small.
 */
function AskedExchange({
  question,
  answer,
  tone,
  marks,
  still,
}: {
  question: string;
  answer: string;
  tone: string;
  marks: Parameters<typeof UseMark>[0]["state"][];
  still: boolean;
}) {
  const asked = useRef<HTMLSpanElement>(null);
  const reply = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (still) {
      return;
    }
    let frame = 0;
    let last = "";
    const letters = [...question];
    const loop = () => {
      const share = progress.asked;
      const typed = letters.slice(0, Math.round(letters.length * Math.min(1, share / 0.5))).join("");
      if (typed !== last && asked.current !== null) {
        last = typed;
        asked.current.textContent = typed;
      }
      if (reply.current !== null) {
        const landed = Math.min(1, Math.max(0, (share - 0.62) / 0.2));
        reply.current.style.opacity = String(landed);
        reply.current.style.transform = `translate3d(0, ${((1 - landed) * 8).toFixed(1)}px, 0)`;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [question, still]);

  return (
    <div data-asked className="mt-5 w-full max-w-[24rem] border-s-2 border-line-strong ps-4 text-start sm:ms-auto">
      <p className="font-mono text-[13px] tracking-[0.04em] text-text">
        <span aria-hidden className="me-2 text-text-faint">&gt;</span>
        <span ref={asked}>{question}</span>
      </p>
      <div ref={reply} className="mt-3 flex items-center gap-3" style={still ? undefined : { opacity: 0 }}>
        <span className={`font-mono text-[13px] font-semibold tracking-[0.04em] ${tone}`}>{answer}</span>
        <span aria-hidden className="flex items-center gap-1.5">
          {marks.map((state, index) => (
            <span key={index} className={USE_TONES[state]}>
              <UseMark state={state} className="h-3 w-3" />
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

/** The waiting beat's drawing: a tag in a paper tray that turns over to say who it waits for. */
function WaitingTag({ label, still }: { label: string; still: boolean }) {
  const tag = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (still) {
      return;
    }
    let frame = 0;
    const loop = () => {
      if (tag.current !== null) {
        tag.current.style.transform = `rotateX(${((1 - progress.waiting) * 90).toFixed(1)}deg)`;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return (
    <div aria-hidden className="mt-6 flex h-16 w-56 items-end justify-center rounded-b-[10px] border border-t-0 border-line-strong bg-bg-raised [perspective:600px]">
      <span
        ref={tag}
        className="mb-3 inline-block origin-bottom border border-accent bg-bg px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-accent"
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The look-alike beat's dated rail: the earlier date on the left, the later on
 * the right, the gap written between. It hangs from where the scene says the
 * prints' feet are and draws left to right.
 */
export function PairRail({ data, table }: { data: StoryData; table: BeatTable }) {
  const format = useFormatter();
  const locale = useLocale();
  const node = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const lookalike = data.lookalike ?? null;
  const beat = table.beat.lookalike;

  useEffect(() => {
    if (beat === undefined) {
      return;
    }
    let frame = 0;
    const loop = () => {
      const el = node.current;
      const parent = el?.parentElement;
      if (el !== null && el !== undefined && parent !== null && parent !== undefined) {
        const box = parent.getBoundingClientRect();
        const left = ((pairAnchors.earlierX + 1) / 2) * box.width;
        const right = ((pairAnchors.laterX + 1) / 2) * box.width;
        const top = ((1 - pairAnchors.footY) / 2) * box.height + 18;
        const drawn = progress.lookalike;
        el.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
        el.style.width = `${Math.max(0, right - left).toFixed(1)}px`;
        el.style.opacity = String(pairAnchors.shown > 0.98 && drawn > 0 ? Math.min(1, drawn * 3) : 0);
        if (line.current !== null) {
          line.current.style.transform = `scaleX(${drawn.toFixed(3)})`;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [beat]);

  if (lookalike === null || beat === undefined) {
    return null;
  }
  const short = (seconds: number) =>
    format.dateTime(new Date(seconds * 1000), { day: "numeric", month: "short", year: "numeric" });

  return (
    <div ref={node} data-lookalike-rail aria-hidden className="pointer-events-none absolute left-0 top-0 z-[15] opacity-0">
      <span ref={line} className="absolute inset-x-0 top-0 block h-[2px] origin-left bg-text rtl:origin-right" style={{ transform: "scaleX(0)" }} />
      <span className="absolute -left-px -top-[7px] block h-4 w-[2px] bg-text" />
      <span className="absolute -right-px -top-[7px] block h-4 w-[2px] bg-text" />
      <span className="absolute left-0 top-4 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em] text-text">
        {short(lookalike.earlier.registeredAt)}
      </span>
      <span className="absolute right-0 top-4 translate-x-1/2 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em] text-text">
        {short(lookalike.later.registeredAt)}
      </span>
      <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-bg/80 px-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-lookalike">
        {gapIn(locale, lookalike.later.registeredAt - lookalike.earlier.registeredAt)}
      </span>
    </div>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      data-story-line="kicker"
      className={`flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-accent ${className}`}
    >
      <span className="motif h-[9px] w-[9px]" />
      {children}
    </p>
  );
}

export function Title({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      data-story-line="title"
      className={`mt-5 max-w-[17ch] font-display text-[clamp(2rem,5.4vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.04em] ${className}`}
    >
      {children}
    </h2>
  );
}

export function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p data-story-line="body" className={`mt-4 max-w-[38ch] text-base leading-relaxed text-text-muted ${className}`}>
      {children}
    </p>
  );
}

export function Readout({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      data-story-line="readout"
      className={`mt-5 max-w-[46ch] font-mono text-[11px] uppercase tracking-[0.14em] text-text-faint ${className}`}
    >
      {children}
    </p>
  );
}

/**
 * The verifier's own figures, ticking through the six copies as the traveller
 * crosses the wall and landing, at the largest size in the film, the moment it
 * snaps home.
 *
 * The six transforms and their fingerprint distances were measured by posting
 * the real files to the running verifier, and the numbers are written straight
 * onto the nodes from an animation frame so the scene never shares a render
 * with them. The figure is bits apart on the 64 bit fingerprint, the same unit
 * the verify page and the passport card use.
 */
function Ladder({ label, still }: { label: string; still: boolean }) {
  const t = useTranslations("story.verified");
  const box = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const said = useRef<HTMLSpanElement>(null);
  const steps = useMemo(() => degradeSteps(), []);
  const last = steps[steps.length - 1];

  const spoken = useCallback(
    (transform: string) => (t.has(`copies.${transform}`) ? t(`copies.${transform}`) : transform),
    [t],
  );
  const measured = useCallback((bits: string) => t("similarity", { value: bits, result: label }), [label, t]);

  useEffect(() => {
    if (still) {
      return;
    }
    let frame = 0;
    let shownIndex = -1;
    let landed = false;

    const loop = () => {
      const at = Math.min(steps.length - 1, Math.floor(progress.verified * steps.length));
      if (at !== shownIndex) {
        shownIndex = at;
        if (name.current !== null) {
          name.current.textContent = spoken(steps[at].transform);
        }
        if (value.current !== null) {
          value.current.textContent = bitsApart(steps[at]);
        }
        if (said.current !== null) {
          said.current.textContent = measured(bitsApart(steps[at]));
        }
      }
      const home = progress.verified >= 1;
      if (home !== landed && box.current !== null) {
        landed = home;
        box.current.dataset.landed = home ? "true" : "false";
      }
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [measured, spoken, steps, still]);

  const shown = still ? last : steps[0];

  return (
    <div ref={box} data-found-number className="mt-6 flex items-end gap-5">
      <span
        ref={value}
        className="font-display text-[clamp(4.5rem,13vw,11rem)] font-semibold leading-[0.78] tracking-[-0.06em] tabular-nums text-text [html.dark_&]:text-accent"
      >
        {bitsApart(shown)}
      </span>
      <span className="pb-2 sm:pb-4">
        <span ref={name} className="block max-w-[24ch] font-mono text-[12px] uppercase tracking-[0.14em] text-text">
          {spoken(shown.transform)}
        </span>
        <span ref={said} className="mt-1 block max-w-[24ch] font-mono text-[12px] uppercase tracking-[0.14em] text-verified">
          {measured(bitsApart(shown))}
        </span>
      </span>
    </div>
  );
}

/** How long one reading of the browser's clock is kept still, in seconds. */
const CLOCK_HELD = 60;

let clockAt = 0;

/**
 * The reader's own clock in whole seconds, held still between readings.
 *
 * A snapshot that answered a new number every time React asked would put React
 * in a loop, and a rule whose smallest step is a day does not need a second
 * hand.
 */
function readClock(): number {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds - clockAt >= CLOCK_HELD) {
    clockAt = seconds;
  }
  return clockAt;
}

const noClockWatch = () => () => undefined;

const atRender = () => 0;

/**
 * The statement in the shape the drawing wants it: where it sits on the rule,
 * and the two dates in the reader's own language.
 *
 * The end of the rule is this reader's own today, the same rule the passport
 * card's ledger follows, read through a store so it is held still between
 * renders. Only the two parts the clock really owns, where the notch falls and
 * the word at the far end of the rule, wait for a browser to ask.
 */
export function useLedgerView(data: StoryData): LedgerView | null {
  const format = useFormatter();
  const now = useSyncExternalStore(noClockWatch, readClock, atRender);

  return useMemo(() => {
    if (data.focal === null || data.statement === null) {
      return null;
    }
    const short = (seconds: number) =>
      format.dateTime(new Date(seconds * 1000), { day: "numeric", month: "short", year: "numeric" });
    const dated = now !== 0;

    return {
      consent: data.statement.consent,
      dated,
      // Without a clock the rule runs to the statement's own day and the notch
      // is at its end, which is the one place it cannot be wrong.
      notch: dated ? fractionOf(data.statement.at, data.focal.registeredAt, Math.max(now, data.statement.at)) : 1,
      registered: short(data.focal.registeredAt),
      writtenShort: short(data.statement.at),
    };
  }, [data.focal, data.statement, format, now]);
}
