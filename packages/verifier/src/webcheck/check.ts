import { env } from "../env.js";
import { Kind } from "../generate/eip712.js";
import type { DayTake } from "../limits/globalDay.js";
import { safeReason } from "../net/errorText.js";
import { MAX_PAGES, visionDetector, type WebDetector, type WebPages } from "./vision.js";

/** How long Vision gets before the web check gives up and says nothing (L22). */
export const WEB_CHECK_TIMEOUT_MS = 10_000;

/**
 * What a prepare answer says about the web check. "found" carries what Google found and what the
 * pinned document records; "silent" is every other outcome, zero hits, a failure, a timeout, the
 * switch off and a picture the rule never sends, so no answer can ever say "not found online" (L23).
 */
export type WebCheckAnswer = { state: "found"; count: number; pages: string[] } | { state: "silent" };

export const SILENT: WebCheckAnswer = { state: "silent" };

/** What the rule needs to know about a picture before any of it may leave for Google. */
export interface WebCheckSubject {
  route: "studio" | "platform" | "generate" | "edit";
  /** The registry's Kind: Generated 0, Captured 1, Edited 2. */
  kind: number;
  /** The sealed flag as readFlag read it: a sealed picture is never published, so never sent. */
  sealed: boolean;
  platform: boolean;
  generated: boolean;
}

/**
 * The one predicate that decides whether a picture goes to Google (L22): a studio upload, of kind
 * Captured, not sealed, not a platform's and not generated. Every condition must hold, so a new
 * route or a new kind is not sent until this line says so.
 *
 * Covers which pictures leave. It does not cover when: the caller asks only after the token, the
 * hourly cap and the day's prepare slot have passed, and outside the decode gate.
 */
export function sendsToWeb(subject: WebCheckSubject): boolean {
  return (
    subject.route === "studio" &&
    subject.kind === Kind.Captured &&
    subject.sealed === false &&
    subject.platform === false &&
    subject.generated === false
  );
}

/** Where the web check reports what happened: a Fastify request logger fits. */
export interface WebCheckLog {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
}

/**
 * The live detector, or undefined when the web check is off on this host: no key, or a test runner,
 * which never reaches Google unless a test hands in its own stand-in.
 */
export function liveWebDetector(): WebDetector | undefined {
  const key = env.GOOGLE_VISION_API_KEY;
  if (env.NODE_ENV === "test" || key === undefined) return undefined;
  return visionDetector(key);
}

/** Runs `work` for at most `ms`, aborting it through the signal it is given when the time is up. */
async function withinTime<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer from Vision in ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The web check for one picture (L22 to L24). Sends `picture` only when `sendsToWeb` says so, a
 * detector is configured, and the day's Vision slot is free; waits at most WEB_CHECK_TIMEOUT_MS.
 * Never throws: every failure is logged through safeReason and answers "silent", which records
 * nothing. A slot taken is spent, since a call that left may have been billed.
 */
export async function webCheck(options: {
  subject: WebCheckSubject;
  /** The bytes to send, undefined when the route made none to publish. */
  picture: Buffer | undefined;
  detector: WebDetector | undefined;
  takeSlot: () => DayTake;
  log: WebCheckLog;
  timeoutMs?: number;
}): Promise<WebCheckAnswer> {
  if (!sendsToWeb(options.subject) || options.detector === undefined || options.picture === undefined) {
    return SILENT;
  }
  const detector = options.detector;
  const picture = options.picture;
  const slot = options.takeSlot();
  if (!slot.ok) {
    options.log.info({ used: slot.use.used, max: slot.use.max }, "web check: today's Vision ceiling is spent, nothing sent");
    return SILENT;
  }
  let found: WebPages;
  try {
    found = await withinTime(async (signal) => await detector(picture, signal), options.timeoutMs ?? WEB_CHECK_TIMEOUT_MS);
  } catch (error) {
    options.log.warn({ reason: safeReason(error) }, "web check: Vision gave no usable answer, nothing recorded");
    return SILENT;
  }
  if (!Number.isSafeInteger(found.count) || found.pages.length === 0 || found.count < found.pages.length) {
    return SILENT;
  }
  return { state: "found", count: found.count, pages: found.pages.slice(0, MAX_PAGES) };
}
