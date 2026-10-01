import type { Hex } from "viem";
import { publicEnv } from "@/lib/env";
import { answerReadSchema, refusalOf, type AnswerDocument, type AnswerRefusal } from "./answer";

/**
 * The verify service's two answer routes, POST and GET /challenges/:passportId/answer,
 * as docs/api/verifier-endpoints.md describes them.
 */

const READ_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 30_000;

function answerUrl(passportId: Hex): string {
  return `${publicEnv.verifierUrl.replace(/\/+$/, "")}/challenges/${passportId.toLowerCase()}/answer`;
}

/** What the service holds for the dispute the chain holds now. "failed" is a read that did not come back, said in words. */
export type AnswerRead =
  | { kind: "found"; answerURI: string; answer: AnswerDocument }
  | { kind: "none" }
  | { kind: "failed" };

export async function readAnswer(passportId: Hex, options: { signal?: AbortSignal } = {}): Promise<AnswerRead> {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(answerUrl(passportId), { method: "GET", signal, cache: "no-store" });
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 404) {
    return { kind: "none" };
  }
  if (!response.ok) {
    return { kind: "failed" };
  }
  try {
    const parsed = answerReadSchema.safeParse(await response.json());
    return parsed.success ? { kind: "found", ...parsed.data } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export type AnswerSent = { ok: true; answerURI: string } | { ok: false; refusal: AnswerRefusal };

/**
 * Sends one signed answer. A send that never got an answer back is "unknown"
 * rather than "nothing was sent": the service may have pinned it, and the
 * page's next read says which.
 */
export async function sendAnswer(input: {
  passportId: Hex;
  text: string;
  deadline: number;
  signature: Hex;
}): Promise<AnswerSent> {
  let response: Response;
  try {
    response = await fetch(answerUrl(input.passportId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text, deadline: input.deadline, signature: input.signature }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, refusal: "unknown" };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const said = (body ?? {}) as { answerURI?: unknown; error?: unknown };
  if (response.ok && typeof said.answerURI === "string" && /^ipfs:\/\/[A-Za-z0-9]+$/.test(said.answerURI)) {
    return { ok: true, answerURI: said.answerURI };
  }
  return { ok: false, refusal: response.ok ? "unknown" : refusalOf(response.status, said.error) };
}
