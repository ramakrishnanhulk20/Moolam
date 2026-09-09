"use client";

import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";

type Surface = "dark" | "light";

type Candidate = {
  id: "seal-o" | "frame" | "stamp";
  index: string;
  name: string;
  idea: string;
  /** Measured off the drawn files. `ratio` is width over height for the whole
   *  box; `ink` and `mark` say how much of that height the artwork takes, since
   *  every lockup carries clear space equal to the seal's width on all sides.
   *  Sizing by those fractions is what makes 28 px really mean 28 px of logo. */
  horizontal: { ratio: number; ink: number };
  stacked: { ratio: number; mark: number };
};

const CANDIDATES: Candidate[] = [
  {
    id: "seal-o",
    index: "01",
    name: "Seal-O",
    idea: "The word carries the mark. The first o is the seal itself, cut to the size a round letter would hold.",
    horizontal: { ratio: 2.5268, ink: 0.4059 },
    stacked: { ratio: 1.4984, mark: 0.2947 },
  },
  {
    id: "frame",
    index: "02",
    name: "Frame",
    idea: "The picture and the stamp. A hollow square with the seal pressed over its top right corner, a gap knocked out so both read.",
    horizontal: { ratio: 3.8335, ink: 0.5489 },
    stacked: { ratio: 1.5495, mark: 0.3249 },
  },
  {
    id: "stamp",
    index: "03",
    name: "Stamp",
    idea: "One pink stamp. The seal over the word inside a rounded box, the way a passport gets marked at a desk.",
    horizontal: { ratio: 2.4499, ink: 0.4697 },
    stacked: { ratio: 1.361, mark: 0.2076 },
  },
];

const SURFACE: Record<Surface, { bg: string; text: string; faint: string; line: string }> = {
  dark: { bg: "#0B0B0C", text: "#F5F1EA", faint: "rgb(245 243 239 / 0.46)", line: "rgb(255 255 255 / 0.14)" },
  light: { bg: "#F2EFE9", text: "#0B0B0C", faint: "rgb(11 11 12 / 0.5)", line: "rgb(11 11 12 / 0.14)" },
};

const HEADER_INK = 28;
const HERO_MARK = 160;
const MARK_SIZES = [64, 32, 16];

const src = (id: Candidate["id"], file: string) => `/brand/${id}/${file}.svg`;

function fit(height: number, ratio: number) {
  return { height, width: Math.round(height * ratio) };
}

function Caption({ children, surface }: { children: string; surface: Surface }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: SURFACE[surface].faint }}>
      {children}
    </p>
  );
}

function Marks({ candidate, surface, file }: { candidate: Candidate; surface: Surface; file: string }) {
  return (
    <div className="flex items-end gap-6">
      {MARK_SIZES.map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <div className="flex h-16 items-center">
            <Image
              src={src(candidate.id, file)}
              alt={`${candidate.name} mark at ${size} pixels`}
              width={size}
              height={size}
              unoptimized
              className="transition-transform duration-300 hover:scale-110"
            />
          </div>
          <span className="font-mono text-[10px]" style={{ color: SURFACE[surface].faint }}>
            {size}
          </span>
        </div>
      ))}
    </div>
  );
}

function Panel({ candidate, surface }: { candidate: Candidate; surface: Surface }) {
  const skin = SURFACE[surface];
  const header = fit(Math.round(HEADER_INK / candidate.horizontal.ink), candidate.horizontal.ratio);
  const hero = fit(Math.round(HERO_MARK / candidate.stacked.mark), candidate.stacked.ratio);

  return (
    <div className="relative grain overflow-hidden" style={{ background: skin.bg, color: skin.text }}>
      <div className="grid gap-10 px-6 py-12 sm:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-16 lg:py-16">
        <div className="flex flex-col gap-3">
          <Caption surface={surface}>Hero, mark 160 px</Caption>
          <Image
            src={src(candidate.id, `lockup-stacked-${surface}`)}
            alt={`${candidate.name} stacked lockup`}
            width={hero.width}
            height={hero.height}
            unoptimized
            priority
            className="h-auto max-w-full"
          />
        </div>

        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-3">
            <Caption surface={surface}>Header, 28 px of logo</Caption>
            <Image
              src={src(candidate.id, `lockup-horizontal-${surface}`)}
              alt={`${candidate.name} horizontal lockup`}
              width={header.width}
              height={header.height}
              unoptimized
              className="h-auto max-w-full"
            />
          </div>

          <div className="flex flex-col gap-4">
            <Caption surface={surface}>Mark, drawn file</Caption>
            <Marks candidate={candidate} surface={surface} file={`mark-${surface}`} />
          </div>

          <div className="flex flex-col gap-4">
            <Caption surface={surface}>The 16 px file, shown at 64, 32 and 16</Caption>
            <Marks candidate={candidate} surface={surface} file="mark-16" />
          </div>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-px" style={{ background: skin.line }} />
    </div>
  );
}

function HeaderStrip({ candidate }: { candidate: Candidate }) {
  const header = fit(Math.round(HEADER_INK / candidate.horizontal.ink), candidate.horizontal.ratio);

  return (
    <div className="relative grain overflow-hidden rounded-[8px] bg-[#0B0B0C]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[12%] h-80 w-80 rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(circle, #FFB7C5 0%, transparent 68%)" }}
      />
      <div className="relative flex w-full flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 sm:px-8">
        <Image
          src={src(candidate.id, "lockup-horizontal-dark")}
          alt={`${candidate.name} in the header`}
          width={header.width}
          height={header.height}
          unoptimized
          className="h-auto max-w-full"
        />
        <span className="hidden font-mono text-[11px] uppercase tracking-[0.24em] text-[rgb(245_243_239_/_0.5)] md:inline">
          Proof of origin
        </span>
        <nav className="ml-auto flex items-center gap-5 text-sm text-[rgb(245_243_239_/_0.72)]">
          {["Home", "Verify", "Studio"].map((item) => (
            <span key={item} className="cursor-default transition-colors duration-200 hover:text-[#FFB7C5]">
              {item}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <span className="h-8 w-12 rounded-[8px] border border-[rgb(255_255_255_/_0.16)]" />
          <span className="h-8 w-8 rounded-[8px] border border-[rgb(255_255_255_/_0.16)]" />
        </div>
      </div>
      <div className="h-32 bg-[linear-gradient(180deg,transparent,rgb(255_183_197_/_0.07))] sm:h-44" />
    </div>
  );
}

export function LogoBench() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<Candidate["id"]>("seal-o");
  const current = CANDIDATES.find((c) => c.id === active) ?? CANDIDATES[0];
  const rise = reduce ? {} : { initial: { opacity: 0, y: 28 }, animate: { opacity: 1, y: 0 } };

  return (
    <div className="bg-[#08080A] text-[#F5F1EA]">
      <section className="mx-auto w-full max-w-[1400px] px-5 pb-16 pt-14 sm:px-8 sm:pt-20">
        <motion.p
          {...rise}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#FFB7C5]"
        >
          Lab / logo
        </motion.p>
        <motion.h1
          {...rise}
          transition={{ duration: 0.8, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          className="mt-4 max-w-[16ch] font-display font-bold uppercase leading-[0.9] tracking-[-0.04em]"
          style={{ fontSize: "clamp(3rem, 10vw, 9rem)" }}
        >
          Three marks
        </motion.h1>
        <motion.p
          {...rise}
          transition={{ duration: 0.7, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
          className="mt-6 max-w-[52ch] text-base text-[rgb(245_243_239_/_0.62)] lg:ml-[38%]"
        >
          One seal, one face, three ways to lock them together. Every file below is a real SVG with the
          geometry in it, so the one you pick is the one a designer could hand on.
        </motion.p>
      </section>

      <section className="mx-auto w-full max-w-[1400px] px-5 pb-20 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {CANDIDATES.map((candidate) => {
            const on = candidate.id === active;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setActive(candidate.id)}
                className="relative rounded-[8px] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors duration-200"
                style={{ color: on ? "#0B0B0C" : "rgb(245 243 239 / 0.62)" }}
              >
                {on ? (
                  <motion.span
                    layoutId="bench-switch"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-0 rounded-[8px] bg-[#FFB7C5]"
                  />
                ) : (
                  <span className="absolute inset-0 rounded-[8px] border border-[rgb(255_255_255_/_0.14)]" />
                )}
                <span className="relative">{candidate.name}</span>
              </button>
            );
          })}
          <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.22em] text-[rgb(245_243_239_/_0.4)]">
            In the header
          </span>
        </div>
        <HeaderStrip candidate={current} />
      </section>

      {CANDIDATES.map((candidate) => (
        <section key={candidate.id} className="border-t border-[rgb(255_255_255_/_0.1)]">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="mx-auto w-full max-w-[1400px] px-5 py-12 sm:px-8"
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-baseline md:gap-10">
              <span className="font-mono text-[11px] tracking-[0.28em] text-[#FFB7C5]">{candidate.index}</span>
              <h2 className="font-display text-4xl font-bold uppercase leading-[0.95] tracking-[-0.03em] sm:text-6xl">
                {candidate.name}
              </h2>
              <p className="max-w-[46ch] text-base text-[rgb(245_243_239_/_0.62)] md:ml-auto">{candidate.idea}</p>
            </div>
          </motion.div>
          <Panel candidate={candidate} surface="dark" />
          <Panel candidate={candidate} surface="light" />
        </section>
      ))}

      <footer className="mx-auto w-full max-w-[1400px] px-5 py-16 font-mono text-[11px] uppercase tracking-[0.22em] text-[rgb(245_243_239_/_0.4)] sm:px-8">
        Pink #FFB7C5, ink #0B0B0C, paper text #F5F1EA. Clear space on every lockup equals the seal width.
      </footer>
    </div>
  );
}
