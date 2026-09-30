import { MoolamPlatformError, type PlatformErrorCode } from "@moolam/platform";
import type { Hex } from "viem";
import { callerAddress } from "./address";
import { startServer } from "./boot";
import { followCosign } from "./cosign-worker";
import { env } from "./env";
import { giveBack, isClosed, take, type Action, type TakeResult, type Ticket } from "./caps";
import { guarded, image, json, logLine, originAllowed, readJsonObject, refuse } from "./http";
import { PromptRefused, billedOrUnknown, drawPicture } from "./image-model";
import { kitReady, movePassport, openCosign, registerPicture } from "./kit";
import { newSession, ownsHash, readSession, sessionCookie, sessionHash } from "./session";
import {
  advancePicture,
  claimPicture,
  createPicture,
  readImage,
  readPicture,
  releasePicture,
  type Busy,
  type PictureRecord,
} from "./store";
import { isTermsPreset, termsFor } from "./terms";
import { titleFor } from "./title";

/**
 * The handlers behind Dreamloom's API routes. Every picture route checks, in this order: that the
 * session owns the picture (404 otherwise, the same answer as a picture that does not exist, so an
 * id is never confirmed), the state it expects, and its daily cap.
 */

const PROMPT_MIN = 8;
const PROMPT_MAX = 600;
const HEX32 = /^0x[0-9a-f]{64}$/;

function capRefusal(result: Exclude<TakeResult, { ok: true }>): Response {
  switch (result.refusal) {
    case "closed":
      return refuse(503, "closed");
    case "busy":
      return refuse(503, "busy");
    case "limit":
      return refuse(429, "limit", { scope: result.scope });
  }
}

/** The picture when this request's session wove it, else null. */
function owned(request: Request, id: string): PictureRecord | null {
  const record = readPicture(id);
  return record !== null && ownsHash(readSession(request), record.sessionHash) ? record : null;
}

const notFound = () => refuse(404, "not-found");

/**
 * Every route runs through here. A POST from any origin but Dreamloom's own is refused before
 * anything else. The start work runs again on the first request, which does nothing when
 * instrumentation.ts already ran it.
 */
function route(request: Request, run: () => Promise<Response>): Promise<Response> {
  return guarded(async () => {
    startServer();
    if (request.method !== "GET" && request.method !== "HEAD" && !originAllowed(request)) {
      return refuse(403, "origin");
    }
    return await run();
  });
}

/** What the owning session sees of its picture. The co-sign link shows only while it is the next step. */
function view(record: PictureRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { state: record.state, prompt: record.prompt, createdAt: record.createdAt };
  if (record.title !== undefined) out.title = record.title;
  if (record.mode !== undefined) out.mode = record.mode;
  if (record.cosign !== undefined && (record.state === "cosign-open" || record.state === "cosign-signed")) {
    out.cosignUrl = record.cosign.cosignUrl;
  }
  for (const key of ["passportId", "registerTx", "consentTx", "moveTx", "movedTo", "failure"] as const) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/**
 * Takes a cap for an action on a claimed picture. On a refusal the claim is let go, so the visitor
 * can try again once the action opens.
 */
function takeFor(id: string, busy: Busy, action: Action): { ticket: Ticket } | { refusal: Response } {
  if (isClosed(action) || !kitReady()) {
    releasePicture(id, busy);
    return { refusal: refuse(503, "closed") };
  }
  const taken = take(action);
  if (!taken.ok) {
    releasePicture(id, busy);
    return { refusal: capRefusal(taken) };
  }
  return { ticket: taken.ticket };
}

/** POST /api/weave: draws the prompt and keeps the picture for this session, which it creates if needed. */
export function weave(request: Request): Promise<Response> {
  return route(request, async () => {
    const body = await readJsonObject(request);
    const prompt = body?.prompt;
    if (typeof prompt !== "string" || prompt.trim().length < PROMPT_MIN || prompt.length > PROMPT_MAX) {
      return refuse(400, "prompt");
    }
    if (isClosed("weave") || env().OPENAI_API_KEY === undefined) {
      return refuse(503, "closed");
    }
    const taken = take("weave", callerAddress(request));
    if (!taken.ok) return capRefusal(taken);

    let drawn;
    try {
      drawn = await drawPicture(prompt);
    } catch (error) {
      if (error instanceof PromptRefused) {
        giveBack(taken.ticket);
        return json(422, { error: "refused", reason: error.message });
      }
      if (!billedOrUnknown(error)) giveBack(taken.ticket);
      logLine("weave", "the image model failed");
      return refuse(503, "busy");
    }

    const existing = readSession(request);
    const session = existing ?? newSession();
    const record = createPicture({ sessionHash: sessionHash(session), prompt, bytes: drawn.bytes });
    const headers: Record<string, string> = existing === null ? { "set-cookie": sessionCookie(session, request) } : {};
    return json(200, { pictureId: record.id }, headers);
  });
}

/** GET /api/pictures/:id */
export function getPicture(request: Request, id: string): Promise<Response> {
  return route(request, async () => {
    const record = owned(request, id);
    return record === null ? notFound() : json(200, view(record));
  });
}

/** GET /api/pictures/:id/image */
export function getPictureImage(request: Request, id: string): Promise<Response> {
  return route(request, async () => {
    const record = owned(request, id);
    const bytes = record === null ? null : readImage(record);
    return record === null || bytes === null ? notFound() : image(bytes, record.contentType);
  });
}

/** POST /api/pictures/:id/cosign: opens Moolam's co-sign page for this picture and answers its link. */
export function cosignPicture(request: Request, id: string): Promise<Response> {
  return route(request, async () => {
    const record = owned(request, id);
    if (record === null) return notFound();
    const body = await readJsonObject(request);
    const preset = body?.terms;
    if (!isTermsPreset(preset)) return refuse(400, "terms");
    const title = titleFor(body, record.prompt);
    if (title === null) return refuse(400, "title");
    if (claimPicture(id, ["woven"], "cosign") === null) return refuse(409, "state");
    const cap = takeFor(id, "cosign", "cosign");
    if ("refusal" in cap) return cap.refusal;

    const bytes = readImage(record);
    if (bytes === null) {
      releasePicture(id, "cosign");
      giveBack(cap.ticket);
      return notFound();
    }
    let handle;
    try {
      handle = await openCosign(bytes, title, termsFor(preset));
    } catch (error) {
      releasePicture(id, "cosign");
      // Without a handle nobody can open the page, so no co-sign Moolam would pay for can follow.
      if (error instanceof MoolamPlatformError) giveBack(cap.ticket);
      logLine("cosign", error instanceof MoolamPlatformError ? error.code : "unexpected failure");
      return refuse(502, "upstream");
    }
    const opened = advancePicture(id, "cosign-open", {
      title,
      mode: "cosign",
      cosign: { handle: handle.handle, cosignUrl: handle.cosignUrl, openBy: handle.openBy },
    });
    if (opened === null) return refuse(409, "state");
    followCosign(id, handle);
    return json(200, { cosignUrl: handle.cosignUrl, title });
  });
}

/**
 * The kit's codes that are thrown before register is sent on chain. registerAsPlatform checks
 * everything first and sends last, so only a transaction or consent failure can follow a send.
 */
const REGISTER_SENT: readonly PlatformErrorCode[] = ["transaction-failed", "consent-failed"];

/** POST /api/pictures/:id/register: Dreamloom registers the picture under its own name, in platform mode. */
export function registerOwnPicture(request: Request, id: string): Promise<Response> {
  return route(request, async () => {
    const record = owned(request, id);
    if (record === null) return notFound();
    const body = await readJsonObject(request);
    const preset = body?.terms;
    if (!isTermsPreset(preset)) return refuse(400, "terms");
    const title = titleFor(body, record.prompt);
    if (title === null) return refuse(400, "title");
    if (claimPicture(id, ["woven"], "register") === null) return refuse(409, "state");
    const cap = takeFor(id, "register", "register");
    if ("refusal" in cap) return cap.refusal;

    const bytes = readImage(record);
    if (bytes === null) {
      releasePicture(id, "register");
      giveBack(cap.ticket);
      return notFound();
    }
    try {
      const result = await registerPicture(bytes, title, termsFor(preset));
      const passportId = result.passportId.toLowerCase();
      const registerTx = result.registerTx.toLowerCase();
      const consentTx = result.consentTx?.toLowerCase();
      advancePicture(
        id,
        "registered",
        { title, mode: "platform", passportId, registerTx, ...(consentTx === undefined ? {} : { consentTx }) },
        result.signedFile,
      );
      return json(200, { passportId, registerTx, consentTx: consentTx ?? null, title });
    } catch (error) {
      if (error instanceof MoolamPlatformError && !REGISTER_SENT.includes(error.code)) {
        releasePicture(id, "register");
        giveBack(cap.ticket);
        logLine("register", error.code);
        return refuse(502, "upstream");
      }
      if (error instanceof MoolamPlatformError && error.code === "consent-failed") {
        // The kit puts the ids from the register receipt in the error, so the passport is a fact;
        // the terms are not, and the record says so.
        const passportId = String(error.details.passportId ?? "").toLowerCase();
        const registerTx = String(error.details.registerTx ?? "").toLowerCase();
        if (HEX32.test(passportId) && HEX32.test(registerTx)) {
          advancePicture(id, "registered", { title, mode: "platform", passportId, registerTx, failure: "terms" });
          logLine("register", error.code);
          return json(200, { passportId, registerTx, consentTx: null, title });
        }
      }
      // Something may have been sent, so the picture is never offered for a second register.
      advancePicture(id, "failed", { mode: "platform", failure: "register" });
      logLine("register", error instanceof MoolamPlatformError ? error.code : "unexpected failure");
      return refuse(502, "upstream");
    }
  });
}

/** The kit's refusals of a move, all thrown before anything is sent, and the word each becomes (P22). */
const MOVE_REFUSALS: Partial<Record<PlatformErrorCode, { status: number; word: "address" | "recipient" | "not-holder" | "upstream" }>> = {
  "invalid-input": { status: 400, word: "address" },
  "refused-recipient": { status: 400, word: "recipient" },
  "not-holder": { status: 409, word: "not-holder" },
  "wrong-chain": { status: 502, word: "upstream" },
};

/** POST /api/pictures/:id/move: hands a passport Dreamloom registered for this session to the visitor's address. */
export function movePicture(request: Request, id: string): Promise<Response> {
  return route(request, async () => {
    const record = owned(request, id);
    if (record === null) return notFound();
    const address = (await readJsonObject(request))?.address;
    if (typeof address !== "string" || address.length > 100) return refuse(400, "address");
    if (record.mode !== "platform" || record.passportId === undefined) return refuse(409, "state");
    if (claimPicture(id, ["registered"], "move") === null) return refuse(409, "state");
    const cap = takeFor(id, "move", "move");
    if ("refusal" in cap) return cap.refusal;

    try {
      const moved = await movePassport(record.passportId as Hex, address);
      const moveTx = moved.txHash.toLowerCase();
      advancePicture(id, "moved", { moveTx, movedTo: moved.to });
      return json(200, { moveTx, movedTo: moved.to });
    } catch (error) {
      // transferPassport reads the holder before it sends, so trying again after an unclear failure
      // cannot move the passport twice: a second try finds Dreamloom no longer holds it.
      releasePicture(id, "move");
      const known = error instanceof MoolamPlatformError ? MOVE_REFUSALS[error.code] : undefined;
      logLine("move", error instanceof MoolamPlatformError ? error.code : "unexpected failure");
      if (known !== undefined) {
        giveBack(cap.ticket);
        return refuse(known.status, known.word);
      }
      return refuse(502, "upstream");
    }
  });
}
