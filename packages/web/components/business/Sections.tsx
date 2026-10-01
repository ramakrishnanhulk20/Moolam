"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BUILD_STEPS, DREAMLOOM_NAME, PERSON_STEPS, PLANS, REASONS, WAY_ROWS, WAYS } from "./content";
import type { AttackTally, DemoPicture as DemoPictureData, LiveFigures, Snippets } from "./data";
import { Code, Figure, Kicker, Lead, Proof, Quiet, Reveal } from "./Kit";
import { DemoPicture } from "./DemoPicture";

const WRAP = "mx-auto w-full max-w-[90rem] px-5 sm:px-8 lg:px-14";

export function SectionHead({
  number,
  kicker,
  title,
  aside,
}: {
  number: string;
  kicker: string;
  title: string;
  aside?: ReactNode;
}) {
  // One column no wider than the page on a phone: Japanese headings break only
  // between phrases, and an open column grew to the heading's 20ch cap (386 px
  // on a 375 px phone) rather than wrapping it.
  return (
    <Reveal className="mb-10 grid grid-cols-1 items-end gap-6 lg:mb-14 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <Kicker number={number}>{kicker}</Kicker>
        <h2 className="mt-4 max-w-[20ch] font-display text-[clamp(2.1rem,4.4vw,4rem)] font-semibold uppercase leading-[0.95] tracking-[-0.04em]">
          {title}
        </h2>
      </div>
      {aside === undefined ? null : <div className="justify-self-start lg:justify-self-end">{aside}</div>}
    </Reveal>
  );
}

/** The three reasons as a ledger: a hairline between each, the number standing out to the left. Never a row of cards. */
export function Why({ number }: { number: string }) {
  const t = useTranslations("business.why");
  return (
    <section data-section="why" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <ol className="border-t border-line">
        {REASONS.map((item, at) => (
          <Reveal
            as="li"
            key={item.key}
            delay={at * 0.08}
            className="grid gap-x-10 gap-y-3 border-b border-line py-8 lg:grid-cols-[6rem_minmax(0,0.9fr)_minmax(0,1.1fr)] lg:py-10"
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">{String(at + 1).padStart(2, "0")}</span>
            <h3 className="font-display text-[clamp(1.6rem,2.6vw,2.4rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
              {t(`reasons.${item.key}.title`)}
            </h3>
            <div>
              <p className="max-w-[60ch] text-base leading-relaxed text-text-muted">{t(`reasons.${item.key}.body`)}</p>
              <div className="mt-2">
                <Proof to={item.link}>{t(`reasons.${item.key}.proof`)}</Proof>
              </div>
            </div>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

/**
 * The three ways side by side, the recommended one lifted out of the row with
 * the accent on its edge. On a phone each way is its own block with its rows
 * labelled, since a four column table does not fit 375 px.
 */
export function Ways({ number }: { number: string }) {
  const t = useTranslations("business.ways");
  return (
    <section data-section="ways" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <div className="grid gap-5 lg:grid-cols-[11rem_repeat(3,minmax(0,1fr))] lg:gap-0">
        <div aria-hidden className="hidden lg:grid lg:grid-rows-[7rem_repeat(4,minmax(6.5rem,auto))]">
          <span />
          {WAY_ROWS.map((row) => (
            <span key={row} className="border-t border-line pe-4 pt-5 font-mono text-[11px] uppercase leading-snug tracking-[0.16em] text-text-faint">
              {t(`rows.${row}`)}
            </span>
          ))}
        </div>
        {WAYS.map((way, at) => {
          const lead = way.tag === "recommended";
          return (
            <Reveal
              as="article"
              key={way.key}
              delay={at * 0.08}
              // The lifted card keeps all four edges and its corners on a
              // laptop; the other two give up theirs to sit in the table.
              className={`relative grid rounded-[10px] border lg:grid-rows-[7rem_repeat(4,minmax(6.5rem,auto))] ${
                lead
                  ? "z-10 border-accent bg-bg-raised shadow-[0_30px_90px_rgb(0_0_0/0.35)] lg:-my-6 lg:py-6 [.light_&]:shadow-[0_28px_70px_rgb(90_60_50/0.16)]"
                  : "border-line lg:rounded-none lg:border-y-0 lg:border-e-0"
              }`}
            >
              <header className="flex flex-col justify-end gap-2 px-5 pb-5 pt-6 lg:px-6">
                {way.tag === null ? null : (
                  <span
                    className={`self-start rounded-[4px] px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.16em] ${
                      lead ? "bg-accent text-accent-ink" : "border border-pending/60 text-pending"
                    }`}
                  >
                    {t(way.tag)}
                  </span>
                )}
                <h3 className="font-display text-[clamp(1.4rem,2vw,1.9rem)] font-semibold uppercase leading-none tracking-[-0.03em]">
                  {t(`items.${way.key}.name`)}
                </h3>
              </header>
              {WAY_ROWS.map((row) => (
                <div key={row} className="border-t border-line px-5 py-4 lg:px-6 lg:pt-5">
                  <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint lg:sr-only">{t(`rows.${row}`)}</p>
                  <p className={`mt-1 text-base leading-relaxed lg:mt-0 ${lead ? "text-text" : "text-text-muted"}`}>
                    {t(`items.${way.key}.${row}`)}
                  </p>
                </div>
              ))}
            </Reveal>
          );
        })}
      </div>
      <Reveal className="mt-14 grid gap-6 border-s-2 border-accent ps-6 lg:ms-[11rem] lg:max-w-[52rem]">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">{t("whyTitle")}</p>
        <p className="text-[clamp(1.1rem,1.6vw,1.4rem)] leading-relaxed text-text">{t("why")}</p>
        <div>
          <Proof to="ways">{t("proof")}</Proof>
        </div>
      </Reveal>
    </section>
  );
}

/** Every step the person takes, numbered, on one track. */
export function Person({ number }: { number: string }) {
  const t = useTranslations("business.person");
  return (
    <section data-section="person" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <ol className="relative grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {PERSON_STEPS.map((step, at) => (
          <Reveal as="li" key={step} delay={(at % 3) * 0.08} className="relative border-t border-line-strong pt-6">
            <span aria-hidden className="absolute -top-px left-0 h-px w-12 bg-accent" />
            <span className="font-display text-[clamp(2.6rem,4vw,3.6rem)] font-semibold leading-none tracking-[-0.05em] text-accent tabular-nums">
              {String(at + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-4 font-display text-xl font-semibold leading-tight tracking-[-0.02em]">{t(`steps.${step}.title`)}</h3>
            <p className="mt-2 max-w-[44ch] text-base leading-relaxed text-text-muted">{t(`steps.${step}.body`)}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

/** The three calls, each beside its own code, and the MCP line under them. */
export function Build({ number, snippets }: { number: string; snippets: Snippets }) {
  const t = useTranslations("business.build");
  return (
    <section data-section="build" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead
        number={number}
        kicker={t("kicker")}
        title={t("title")}
        aside={
          <div className="max-w-[34rem]">
            <p className="text-base leading-relaxed text-text-muted">{t("before")}</p>
            <Proof to="join">{t("beforeLink")}</Proof>
          </div>
        }
      />
      <ol className="grid gap-12 lg:gap-16">
        {BUILD_STEPS.map((step, at) => (
          <Reveal as="li" key={step} className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-12">
            <div className="min-w-0 lg:pt-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">{t("step", { number: at + 1 })}</p>
              <h3 className="mt-3 font-display text-[clamp(1.5rem,2.4vw,2.2rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
                {t(`steps.${step}.title`)}
              </h3>
              <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-text-muted">{t(`steps.${step}.body`)}</p>
            </div>
            <Code lines={snippets.steps[at]} label={t("codeLabel", { number: at + 1, title: t(`steps.${step}.title`) })} />
          </Reveal>
        ))}
      </ol>
      <Reveal className="mt-16 grid min-w-0 gap-6 border-t border-line pt-10 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-12">
        <div className="min-w-0">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            <span className="motif h-[10px] w-[10px]" />
            {t("mcp.title")}
          </p>
          <p className="mt-3 max-w-[48ch] text-base leading-relaxed text-text-muted">{t("mcp.body")}</p>
        </div>
        <Code lines={snippets.mcp} label={t("mcp.codeLabel")} />
      </Reveal>
      <Reveal className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-2">
        <Proof to="guide">{t("guide")}</Proof>
        <p className="text-base text-text-faint">{t("package")}</p>
      </Reveal>
    </section>
  );
}

/** Dreamloom as the working example, and the figures read live beside it. */
export function Live({ number, live, picture }: { number: string; live: LiveFigures; picture: DemoPictureData | null }) {
  const t = useTranslations("business.live");
  const name = live.platform?.name ?? DREAMLOOM_NAME;
  const figures: { value: number | null; label: string; key: string }[] = [
    { key: "platform-passports", value: live.platformPassports, label: t("figures.platformPassports", { platform: name }) },
    { key: "total-passports", value: live.totalPassports, label: t("figures.totalPassports") },
    { key: "stated", value: live.stated, label: t("figures.stated") },
    { key: "platforms", value: live.platforms, label: t("figures.platforms", { count: live.platforms ?? 0 }) },
  ];
  return (
    <section data-section="live" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <Reveal className="relative">
          <div className="relative mx-auto max-w-[26rem] -rotate-[1.5deg] transition-transform duration-500 hover:rotate-0 lg:mx-0">
            <span aria-hidden className="absolute -top-2.5 left-1/2 z-10 h-5 w-16 -translate-x-1/2 rotate-[-3deg] bg-accent/25 backdrop-blur-sm" />
            <DemoPicture
              picture={picture}
              sizes="(min-width: 1024px) 26rem, 92vw"
              alt={
                picture?.title == null
                  ? t("pictureAltUntitled", { platform: name })
                  : t("pictureAlt", { title: picture.title, platform: name })
              }
              className="aspect-[4/3] w-full border border-line-strong shadow-[0_24px_60px_rgb(0_0_0/0.4)] [.light_&]:shadow-[0_22px_50px_rgb(90_60_50/0.2)]"
            />
            <span className="scrim pointer-events-none absolute inset-0 opacity-60" />
            <span className="absolute bottom-3 left-3 bg-bg/85 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
              {name}
              {live.platform === null ? null : (
                <span className="text-text-faint">
                  {" · "}
                  {t("agent", { id: live.platform.agentId })}
                </span>
              )}
            </span>
          </div>
          <p className="mt-8 max-w-[52ch] text-base leading-relaxed text-text-muted">{t("body")}</p>
          <div className="mt-6">
            <Lead to="dreamloom">{t("open")}</Lead>
          </div>
        </Reveal>
        <div>
          <dl className="grid grid-cols-2 border-t border-line">
            {figures.map((figure, at) => (
              <Reveal
                key={figure.key}
                delay={at * 0.06}
                className={`flex flex-col-reverse justify-end border-b border-line py-6 ${at % 2 === 0 ? "pe-4" : "border-s ps-4 sm:ps-6"}`}
              >
                {/* The label comes first for a screen reader, the figure first for the eye. */}
                <dt className="mt-3 max-w-[22ch] text-base leading-snug text-text-muted">{figure.label}</dt>
                <dd
                  data-live-figure={figure.key}
                  className="font-display text-[clamp(2.4rem,5.4vw,5rem)] font-semibold leading-[0.9] tracking-[-0.05em] tabular-nums"
                >
                  <Figure value={figure.value} unread={t("unread")} />
                </dd>
              </Reveal>
            ))}
          </dl>
          <p className="mt-4 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
            <span aria-hidden className="relative flex h-2 w-2">
              <span className="motif h-2 w-2 bg-verified" />
            </span>
            {t("source")}
          </p>
          <ul className="mt-8 space-y-3">
            <li className="text-base leading-relaxed text-text">{t("now")}</li>
            <li className="text-base leading-relaxed text-text-muted">{t("next")}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/** The plans, under the early-access promise, with the fee line under them. */
export function Pricing({ number }: { number: string }) {
  const t = useTranslations("business.pricing");
  return (
    <section id="pricing" data-section="pricing" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <Reveal className="grain relative overflow-hidden rounded-[10px] border border-accent/50 bg-accent-soft px-5 py-5 sm:px-8">
        <p className="text-[clamp(1.05rem,1.5vw,1.3rem)] leading-snug text-text">{t("banner")}</p>
      </Reveal>
      <div className="mt-6 grid border-y border-line sm:grid-cols-3">
        {PLANS.map((plan, at) => (
          <Reveal
            key={plan}
            delay={at * 0.08}
            className={`group @container relative px-1 py-8 transition-colors duration-300 hover:bg-bg-raised sm:px-6 lg:px-8 ${at > 0 ? "border-t border-line sm:border-s sm:border-t-0" : ""}`}
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-accent transition-transform duration-500 group-hover:scale-x-100" />
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-text-faint">{t(`plans.${plan}.name`)}</p>
            {/* "US$ 0,005" and "0,005 $" are half as long again as "$0.005", and
                beside them "por passaporte" left no room in a third of a tablet.
                So the price never breaks, its size is capped at what the
                longest one needs to fit its own column, and the unit sits
                under it on every card so the three read as one row. */}
            <p data-price-row className="mt-4 flex flex-col items-start gap-2">
              <span className="whitespace-nowrap font-display text-[length:min(clamp(2.8rem,5vw,4.6rem),21cqi)] font-semibold leading-none tracking-[-0.05em] tabular-nums">
                {t(`plans.${plan}.price`)}
              </span>
              <span className="text-base text-text-muted">{t(`plans.${plan}.unit`)}</span>
            </p>
            <p className="mt-4 max-w-[30ch] text-base leading-relaxed text-text-muted">{t(`plans.${plan}.body`)}</p>
          </Reveal>
        ))}
      </div>
      <Reveal className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-2">
        <p className="max-w-[64ch] text-base leading-relaxed text-text">{t("fee")}</p>
        <Proof to="costs">{t("proof")}</Proof>
      </Reveal>
    </section>
  );
}

/** The attack pass, its tally parsed from the transcript, and the honest line about who ran it. */
export function Security({ number, tally }: { number: string; tally: AttackTally | null }) {
  const t = useTranslations("business.security");
  return (
    <section data-section="security" className={`${WRAP} py-20 lg:py-28`}>
      <SectionHead number={number} kicker={t("kicker")} title={t("title")} />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <Reveal>
          {tally === null ? (
            <p data-attack-unread className="text-base text-text-muted">
              {t("unread")}
            </p>
          ) : (
            <div data-attack-tally>
              <p className="font-display text-[clamp(6rem,16vw,14rem)] font-semibold leading-[0.8] tracking-[-0.07em] text-accent tabular-nums">
                {tally.attacks}
              </p>
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.22em] text-text-faint">{t("attacks")}</p>
              {/* Three across from 640 px. On a phone a third of the row is 95 px,
                  narrower than one German or Tamil word ("durchgekommen" is 128 px),
                  so there each figure takes a line of its own with its words beside it. */}
              <dl className="mt-8 grid grid-cols-1 border-t border-line sm:grid-cols-3">
                {[
                  { key: "refused", value: tally.refused, tone: "text-text" },
                  { key: "controls", value: tally.controls, tone: "text-verified" },
                  { key: "findings", value: tally.findings, tone: tally.findings === 0 ? "text-text" : "text-failed" },
                ].map((item, at) => (
                  <div
                    key={item.key}
                    className={`grid grid-cols-[minmax(3.25rem,auto)_minmax(0,1fr)] items-baseline gap-x-4 py-4 sm:flex sm:flex-col-reverse sm:justify-end sm:py-0 sm:pt-5 ${at > 0 ? "border-t border-line sm:border-t-0 sm:border-s sm:ps-4" : ""}`}
                  >
                    <dt className="col-start-2 row-start-1 text-base leading-snug text-text-muted sm:mt-2">{t(item.key as "refused" | "controls" | "findings")}</dt>
                    <dd className={`col-start-1 row-start-1 font-display text-[clamp(2rem,3.6vw,3.2rem)] font-semibold leading-none tracking-[-0.04em] tabular-nums ${item.tone}`}>
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Reveal>
        <Reveal delay={0.1} className="lg:pt-6">
          <p className="max-w-[56ch] text-[clamp(1.1rem,1.6vw,1.35rem)] leading-relaxed text-text">{t("lead")}</p>
          <p className="mt-6 max-w-[60ch] border-s-2 border-pending ps-5 text-base leading-relaxed text-text-muted">{t("honest")}</p>
          <div className="mt-6 flex flex-wrap gap-x-8">
            <Proof to="threat">{t("threat")}</Proof>
            <Proof to="transcript">{t("transcript")}</Proof>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** The closing call, full bleed, the kolam knot standing huge and faint behind it. */
export function Call() {
  const t = useTranslations("business.call");
  return (
    <section data-section="call" className="grain relative overflow-hidden border-t border-line bg-bg-sunken">
      {/* The knot's own rule pins it to position relative, so a wrapper places it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-[12vw] top-1/2 flex h-[min(70vw,46rem)] w-[min(70vw,46rem)] -translate-y-1/2 opacity-[0.07]"
      >
        <span className="motif h-full w-full" />
      </span>
      <div className={`${WRAP} relative py-24 lg:py-36`}>
        <Reveal>
          <Kicker>{t("kicker")}</Kicker>
          <h2 className="mt-5 max-w-[14ch] font-display text-[clamp(2.6rem,6.4vw,6rem)] font-semibold uppercase leading-[0.9] tracking-[-0.05em]">
            {t("title")}
          </h2>
          <p className="mt-6 max-w-[56ch] text-base leading-relaxed text-text-muted sm:text-[1.075rem]">{t("body")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Lead to="join">{t("primary")}</Lead>
            <Quiet to="dreamloom">{t("secondary")}</Quiet>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
