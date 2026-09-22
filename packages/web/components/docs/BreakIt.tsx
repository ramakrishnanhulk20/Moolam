"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { consentRevertCopy, revertCopy } from "@/lib/chain/reverts";
import { shortHex } from "@/lib/chain/client";
import { ATTACKS, savedHref, sourceHref, testHref, type Attack } from "./breakIt/attacks";
import type { Asked } from "./breakIt/ask";

/** Nothing has been asked yet, or the question is in the air. */
type Pending = "ready" | "asking";

type Row = Pending | Asked;

function isAsked(row: Row): row is Asked {
  return row !== "ready" && row !== "asking";
}

/** The word stamped across a row once Monad has answered it. */
function stamp(row: Row): { word: string; tone: string } {
  if (row === "ready") {
    return { word: "ready", tone: "border-line text-text-faint" };
  }
  if (row === "asking") {
    return { word: "asking", tone: "border-line text-text-muted" };
  }
  if (row.kind === "unknown") {
    return { word: "no answer", tone: "border-line text-text-faint" };
  }
  if (row.kind === "passed") {
    return { word: "passed", tone: "border-verified text-verified" };
  }
  return { word: "refused", tone: "border-accent text-accent" };
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** One printable argument. Addresses and hashes stay whole: the box scrolls. */
function printArg(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function headline(attack: Attack, row: Row): string {
  if (!isAsked(row)) {
    return attack.answer === "passes" ? "the control, not asked yet" : "not asked yet";
  }
  if (row.kind === "unknown") {
    return "Could not ask the chain just now";
  }
  if (row.kind === "passed") {
    return "Passed: the holder may write this";
  }
  if (row.kind === "empty") {
    return "Refused: no function takes money here";
  }
  const args = row.args.map(printArg).join(", ");
  return `Refused: ${row.name}${args === "" ? "()" : `(${args})`}`;
}

/**
 * Twelve attacks on the live contracts, sent from the reader's own browser.
 *
 * Every row is an eth_call: the node runs the same bytecode a transaction would
 * run, hands back what it would have done, and throws the result away. That is
 * why the attacker's address can be the burn address, which nobody holds a key
 * for, and why nothing on this page can change anything on Monad.
 *
 * Nothing is sent until a reader presses a button, and the rows are asked one
 * after another rather than all at once, so one press is twelve calls on a
 * public endpoint rather than a burst it would rate limit.
 */
export function BreakIt() {
  const t = useTranslations();
  const calm = useReducedMotion() === true;
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busy, setBusy] = useState(false);

  const say = (attack: Attack, name: string): string | null => {
    if (attack.copyIn === null) {
      return null;
    }
    const copy = attack.reverts === "consent" ? consentRevertCopy(name) : revertCopy(name);
    // "reverted" is the line for an error nobody wrote a sentence for. It says
    // nothing a reader of this page does not already know.
    if (copy.key === "reverted") {
      return null;
    }
    const key = `${attack.copyIn}.${copy.key}`;
    return t.has(key) ? t(key) : null;
  };

  const run = useCallback(async (attack: Attack) => {
    setRows((held) => ({ ...held, [attack.id]: "asking" }));
    const { ask } = await import("./breakIt/ask");
    const answer = await ask(attack);
    setRows((held) => ({ ...held, [attack.id]: answer }));
    return answer;
  }, []);

  const runOne = useCallback(
    (attack: Attack) => {
      if (busy) {
        return;
      }
      setBusy(true);
      void run(attack).finally(() => setBusy(false));
    },
    [busy, run],
  );

  const runAll = useCallback(() => {
    if (busy) {
      return;
    }
    setBusy(true);
    void (async () => {
      for (const attack of ATTACKS) {
        await run(attack);
      }
      setBusy(false);
    })();
  }, [busy, run]);

  const answered = ATTACKS.map((attack) => rows[attack.id] ?? "ready").filter(isAsked);
  const refused = answered.filter((row) => row.kind === "refused" || row.kind === "empty").length;
  const passed = answered.filter((row) => row.kind === "passed").length;
  const silent = answered.filter((row) => row.kind === "unknown").length;

  return (
    <section aria-labelledby="break-it-title" className="not-prose my-10 lg:-mx-6 xl:-mx-10">
      <div className="overflow-hidden rounded-[10px] border border-line bg-bg-sunken">
        <header className="grid gap-6 border-b border-line bg-bg-raised px-5 py-7 sm:grid-cols-[1fr_auto] sm:items-end sm:px-7">
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-[0.22em] text-accent">read only, on Monad mainnet</p>
            <h2
              id="break-it-title"
              className="mt-3 font-display text-[2rem] font-semibold leading-[0.95] tracking-tight sm:text-[2.75rem]"
            >
              Twelve attacks.
              <br />
              Watch them refused.
            </h2>
            <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-text-muted">
              Each row is sent as the attacker, straight from this page to the deployed contracts. An eth_call runs the
              same code a transaction runs and keeps none of it, so there is no wallet, no gas and nothing to sign.
            </p>
          </div>

          <div className="flex items-end justify-between gap-6 sm:flex-col sm:items-end">
            <p className="flex items-end gap-3">
              <span className="font-display text-[3.25rem] leading-[0.8] tabular-nums text-accent">{refused}</span>
              <span className="font-mono text-xs uppercase leading-4 tracking-[0.18em] text-text-faint">
                refused
                <br />
                of twelve
              </span>
            </p>
            <button
              type="button"
              onClick={runAll}
              disabled={busy}
              className="inline-flex min-h-11 items-center rounded-[8px] border border-accent bg-accent px-5 font-mono text-xs uppercase tracking-[0.18em] text-accent-ink transition-colors duration-200 hover:bg-transparent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "asking Monad" : "Run all twelve"}
            </button>
          </div>
        </header>

        {/* The tally is read from the rows, and each row announces its own
            answer, so this line is not a second live region shouting over
            them. */}
        <p className="border-b border-line px-5 py-2 font-mono text-xs text-text-faint sm:px-7">
          {answered.length === 0
            ? "nothing has been sent yet"
            : `${answered.length} asked, ${refused} refused, ${passed} passed${silent === 0 ? "" : `, ${silent} unanswered`}`}
        </p>

        <div>
          {ATTACKS.map((attack, index) => {
            const row = rows[attack.id] ?? "ready";
            const mark = stamp(row);
            const sentence = isAsked(row) && row.kind === "refused" ? say(attack, row.name) : null;

            return (
              <motion.article
                key={attack.id}
                initial={calm ? false : { opacity: 0, y: 18 }}
                whileInView={calm ? undefined : { opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.5, delay: Math.min(index, 6) * 0.04, ease: [0.16, 1, 0.3, 1] }}
                className="grid gap-4 border-b border-line/70 px-5 py-6 last:border-b-0 sm:grid-cols-[1fr_20rem] sm:gap-7 sm:px-7"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-xs tabular-nums text-text-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3 className="font-display text-lg font-semibold leading-snug tracking-tight">
                      {attack.what}
                      {attack.answer === "passes" ? (
                        <span className="ml-2 align-middle font-mono text-xs uppercase tracking-[0.18em] text-verified">
                          control
                        </span>
                      ) : null}
                    </h3>
                  </div>

                  <p className="mt-3 font-mono text-xs leading-6 text-text-muted [overflow-wrap:anywhere]">
                    <a href={sourceHref(attack.address)} target="_blank" rel="noreferrer">
                      {attack.contract}
                    </a>
                    {attack.fn === "" ? " (a plain transfer, no function)" : `.${attack.fn}`}
                    <span className="text-text-faint"> sent as </span>
                    {shortHex(attack.from, 8, 6)}
                  </p>
                  <p className="mt-1 font-mono text-xs leading-6 text-text-faint [overflow-wrap:anywhere]">
                    pinned by{" "}
                    <a href={testHref(attack.test.file)} target="_blank" rel="noreferrer">
                      {fileName(attack.test.file)}::{attack.test.name}
                    </a>
                    {", saved in "}
                    <a href={savedHref(attack.saved)} target="_blank" rel="noreferrer">
                      {fileName(attack.saved)}
                    </a>
                  </p>
                </div>

                <div className="sm:w-[20rem]">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`inline-flex h-7 items-center rounded-[6px] border px-2 font-mono text-xs uppercase tracking-[0.18em] ${mark.tone}`}
                    >
                      {row === "asking" && !calm ? (
                        <motion.span
                          animate={{ opacity: [1, 0.35, 1] }}
                          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                        >
                          {mark.word}
                        </motion.span>
                      ) : (
                        mark.word
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => runOne(attack)}
                      disabled={busy}
                      className="inline-flex min-h-11 items-center rounded-[8px] border border-line px-4 font-mono text-xs uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Run
                    </button>
                  </div>

                  {/* The height is fixed so that twelve answers arriving one by
                      one move nothing else on the page. A long answer scrolls
                      inside this box instead. */}
                  <div
                    tabIndex={0}
                    role="status"
                    aria-live="polite"
                    className="mt-3 h-[12.5rem] overflow-y-auto overflow-x-hidden rounded-[8px] border border-line bg-bg px-3 py-2 font-mono text-xs leading-[1.7] text-text-muted [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:h-[11.5rem]"
                  >
                    <p className={isAsked(row) ? "text-text" : "text-text-faint"}>{headline(attack, row)}</p>
                    {sentence === null ? null : <p className="mt-1 text-text-faint">{sentence}</p>}
                    {isAsked(row) && row.kind !== "unknown" ? (
                      <p className="mt-1 text-text-faint">simulated at block {row.block.toLocaleString("en-US")}</p>
                    ) : null}
                    {isAsked(row) && row.kind === "unknown" ? (
                      <p className="mt-1 text-text-faint">
                        The endpoint did not answer, so there is no result to show. Nothing was sent. Press Run again in
                        a moment.
                      </p>
                    ) : null}
                    {isAsked(row) ? null : (
                      <p className="mt-1 text-text-faint">
                        {attack.expected === null
                          ? attack.answer === "passes"
                            ? "the saved run went through with no revert"
                            : "the saved run got a revert with no data"
                          : `the saved run answered ${attack.expected}`}
                      </p>
                    )}
                  </div>
                </div>
              </motion.article>
            );
          })}
        </div>

        <footer className="border-t border-line bg-bg-raised px-5 py-5 font-mono text-xs leading-6 text-text-faint sm:px-7">
          An eth_call cannot write. The same twelve attacks were also run as real transactions or as cast calls before
          this page existed, and those transcripts are linked on every row.
        </footer>
      </div>
    </section>
  );
}
