import { z } from "zod";

/**
 * The browser's side of Dreamloom's picture routes. Every answer is parsed here, so a field the
 * page draws is always one of the shapes the server promises, and every refusal becomes plain words
 * with a next step before it reaches the page.
 */

export const PICTURE_ID = /^[0-9a-f]{32}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const TERMS_CHOICES = ["noAi", "open", "askFirst"] as const;
export type TermsChoice = (typeof TERMS_CHOICES)[number];

const pictureShape = z.object({
  state: z.enum(["woven", "cosign-open", "cosign-signed", "registered", "moved", "failed"]),
  prompt: z.string(),
  createdAt: z.string(),
  title: z.string().optional(),
  mode: z.enum(["platform", "cosign"]).optional(),
  cosignUrl: z.string().optional(),
  passportId: z.string().regex(HEX32).optional(),
  registerTx: z.string().regex(HEX32).optional(),
  consentTx: z.string().regex(HEX32).optional(),
  moveTx: z.string().regex(HEX32).optional(),
  movedTo: z.string().regex(ADDRESS).optional(),
  failure: z.string().optional(),
  delivery: z.object({ kind: z.enum(["waiting", "straight"]), to: z.string() }).optional(),
});

export type PictureView = z.infer<typeof pictureShape>;

export type PictureRead =
  | { kind: "ready"; picture: PictureView }
  | { kind: "missing" }
  | { kind: "error"; words: string };

export type Action = "read" | "cosign" | "register" | "move" | "claim" | "remember";

export const PAGE_WORDS = {
  unreachable: "Dreamloom's server did not answer. Check your connection and try again.",
  unexpected: "Something went wrong on Dreamloom's side. Try again in a minute.",
} as const;

/**
 * Plain words for every refusal word the server can send, each with what to do next. A limit or a
 * pause reads differently for each action, because the next step differs: when one way to a
 * passport is shut for the day, the other may still be open.
 */
export const REFUSAL_WORDS = {
  "not-found": "This picture is not yours or no longer here. Weave a new one from the home page.",
  prompt: "Describe your dream in 8 to 600 characters, then weave it again from the home page.",
  refused: "The picture model turned that prompt down. Try describing your dream another way on the home page.",
  terms: "Pick one of the three AI-use choices, then try again.",
  title: "The title needs 1 to 120 characters of plain text with no hidden marks. Edit it and try again.",
  origin: "Dreamloom only takes this from its own page. Reload this page and press the button again.",
  address: "That is not an address Dreamloom can move a passport to. Connect your Moolam account again.",
  recipient: "Moolam will not take a passport at that address. Connect your own Moolam account and try again.",
  state: "This picture has already moved on from that step. Its current state is shown below.",
  "not-holder": "Dreamloom no longer holds this passport, so it cannot move it. Its current state is shown below.",
  forgotten: "Dreamloom no longer has your Moolam address, so nothing was registered. Choose again below.",
  busy: "Dreamloom is busy right now. Try again in a minute.",
  upstream: "Moolam's service did not answer as expected. Try again in a minute.",
  limit: {
    read: "Dreamloom has reached today's limit. Come back tomorrow.",
    cosign: "Dreamloom has opened all the co-signs it can today. Come back tomorrow, or let Dreamloom hold it.",
    register: "Dreamloom has registered all the pictures it can today. Come back tomorrow, or sign it as the creator.",
    move: "Dreamloom has moved all the passports it can today. It keeps holding yours; come back tomorrow to claim it.",
    claim: "Dreamloom has put all the pictures it can into Moolam accounts today, so nothing was registered. Come back tomorrow, or sign it as the creator.",
    remember: "Dreamloom has reached today's limit. Come back tomorrow.",
  },
  closed: {
    read: "Dreamloom is paused right now. Try again later.",
    cosign: "Signing as the creator is paused on Dreamloom right now. Try again later, or let Dreamloom hold it.",
    register: "Dreamloom's own registering is paused right now. Try again later, or sign it as the creator.",
    move: "Moving passports is paused on Dreamloom right now. It keeps holding yours; try again later.",
    claim: "Sending pictures straight to Moolam accounts is paused on Dreamloom right now, so nothing was registered. Try again later, or sign it as the creator.",
    remember: "Dreamloom cannot remember addresses right now. Try again later.",
  },
} as const;

/** Refusal words after which the page should read the picture again, since its state is what changed. */
const RELOAD_AFTER = new Set(["state", "not-holder", "upstream"]);

export interface Refusal {
  words: string;
  /** True when the picture may have changed, so the page reads it again. */
  reload: boolean;
}

/** The words for one refusal answer. Anything outside the interface reads as unexpected, never as the server's raw text. */
export function refusalFor(action: Action, body: unknown): Refusal {
  const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
  if (typeof error !== "string" || !Object.hasOwn(REFUSAL_WORDS, error)) {
    return { words: PAGE_WORDS.unexpected, reload: true };
  }
  const entry = REFUSAL_WORDS[error as keyof typeof REFUSAL_WORDS];
  const words = typeof entry === "string" ? entry : entry[action];
  return { words, reload: RELOAD_AFTER.has(error) };
}

/** What a picture's failure word means, for the failed state and for a passport whose terms did not save. */
export const FAILURE_WORDS: Record<string, string> = {
  expired:
    "The time to sign on Moolam ran out, so this picture's co-sign closed. Weave a new picture to try again.",
  taken: "Moolam already holds a passport for this exact picture, so a second one cannot be made.",
  cosign: "Dreamloom could not finish the co-sign with Moolam. Weave a new picture to try again.",
  register:
    "Dreamloom's registration did not finish cleanly, so it will not try again with this picture. If it landed, it shows in the gallery within a minute.",
  terms:
    "The passport was made, but its AI-use terms did not save. Its passport page shows the terms it holds.",
};

export function failureWords(word: string | undefined): string {
  return (word !== undefined && FAILURE_WORDS[word]) || FAILURE_WORDS.cosign;
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** GET /api/pictures/:id with this browser's cookie. A malformed id is missing without a request. */
export async function readPicture(id: string, send: typeof fetch = fetch): Promise<PictureRead> {
  if (!PICTURE_ID.test(id)) return { kind: "missing" };
  let response: Response;
  try {
    response = await send(`/api/pictures/${id}`, { cache: "no-store", credentials: "same-origin" });
  } catch {
    return { kind: "error", words: PAGE_WORDS.unreachable };
  }
  const body = await bodyOf(response);
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "error", words: refusalFor("read", body).words };
  const parsed = pictureShape.safeParse(body);
  return parsed.success ? { kind: "ready", picture: parsed.data } : { kind: "error", words: PAGE_WORDS.unexpected };
}

export function imagePath(id: string): string {
  return `/api/pictures/${id}/image`;
}

export type Posted<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

async function post<T>(
  path: string,
  action: Action,
  payload: Record<string, unknown> | null,
  shape: z.ZodType<T>,
  send: typeof fetch,
  method: "POST" | "DELETE" = "POST",
): Promise<Posted<T>> {
  let response: Response;
  try {
    response = await send(path, {
      method,
      ...(payload === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
      credentials: "same-origin",
    });
  } catch {
    // An unanswered POST may still have landed, so the picture is read again.
    return { ok: false, refusal: { words: PAGE_WORDS.unreachable, reload: true } };
  }
  const body = await bodyOf(response);
  if (response.status !== 200) return { ok: false, refusal: refusalFor(action, body) };
  const parsed = shape.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, refusal: { words: PAGE_WORDS.unexpected, reload: true } };
}

const cosignAnswer = z.object({ cosignUrl: z.string() });
const registerAnswer = z.object({ passportId: z.string().regex(HEX32), registerTx: z.string().regex(HEX32) });
const moveAnswer = z.object({ moveTx: z.string().regex(HEX32), movedTo: z.string().regex(ADDRESS) });

export function postCosign(id: string, terms: TermsChoice, title: string, send: typeof fetch = fetch) {
  return post(`/api/pictures/${id}/cosign`, "cosign", { terms, title }, cosignAnswer, send);
}

export function postRegister(id: string, terms: TermsChoice, title: string, send: typeof fetch = fetch) {
  return post(`/api/pictures/${id}/register`, "register", { terms, title }, registerAnswer, send);
}

/**
 * A register that also moves the passport to the session's remembered address. When the register
 * lands and the move does not, the answer still succeeds, carrying the move's refusal word in
 * `claim`, since the picture has its passport and Dreamloom holds it.
 */
const claimAnswer = registerAnswer.extend({
  moveTx: z.string().regex(HEX32).optional(),
  movedTo: z.string().regex(ADDRESS).optional(),
  claim: z.string().optional(),
});

export function postClaim(id: string, terms: TermsChoice, title: string, send: typeof fetch = fetch) {
  return post(`/api/pictures/${id}/register`, "claim", { terms, title, claim: true }, claimAnswer, send);
}

/** For a register that landed and a move to the remembered address that did not. */
export const CLAIM_SNAG =
  "Your picture has its passport, but Dreamloom could not hand it to your Moolam account just now. It holds it for you: claim it below.";

export function postMove(id: string, address: string, send: typeof fetch = fetch) {
  return post(`/api/pictures/${id}/move`, "move", { address }, moveAnswer, send);
}

/** The address this browser's session asked Dreamloom to remember, checksummed, or null. */
const rememberedAnswer = z.object({ address: z.string().regex(ADDRESS).nullable() });

export const REMEMBERED_PATH = "/api/session/address";

/** Reads the remembered address. Any failure reads as none, so the page simply offers the usual choices. */
export async function readRemembered(send: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await send(REMEMBERED_PATH, { cache: "no-store", credentials: "same-origin" });
    if (response.status !== 200) return null;
    const parsed = rememberedAnswer.safeParse(await response.json());
    return parsed.success ? parsed.data.address : null;
  } catch {
    return null;
  }
}

export function postRemember(address: string, send: typeof fetch = fetch) {
  return post(REMEMBERED_PATH, "remember", { address }, rememberedAnswer, send);
}

export function postForget(send: typeof fetch = fetch) {
  return post(REMEMBERED_PATH, "remember", null, rememberedAnswer, send, "DELETE");
}
