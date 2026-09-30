export const PROMPT_MIN = 8;
export const PROMPT_MAX = 600;

/** The server's picture ids are 16 random bytes written as hex. */
const PICTURE_ID = /^[0-9a-f]{32}$/;

export type WeaveOutcome = { kind: "woven"; pictureId: string } | { kind: "refused"; words: string };

export const WEAVE_WORDS = {
  prompt: `Describe your dream in ${PROMPT_MIN} to ${PROMPT_MAX} characters, then weave it.`,
  refused: "The picture model turned this one down. Try describing your dream another way.",
  limitAddress: "You have woven all of today's pictures from this connection. Come back tomorrow for more.",
  limitDay: "Dreamloom has woven every picture it can today. Come back tomorrow.",
  busy: "The loom is busy with other dreams right now. Try again in a minute.",
  closed: "Weaving is paused for now. The gallery below is still open.",
  unreachable: "Dreamloom's server did not answer. Check your connection and try again.",
  unexpected: "Something went wrong on Dreamloom's side. Try again in a minute.",
} as const;

/** Why this prompt cannot be sent yet, or null when it can. The server counts the same way. */
export function promptProblem(prompt: string): string | null {
  const length = prompt.trim().length;
  return length < PROMPT_MIN || length > PROMPT_MAX ? WEAVE_WORDS.prompt : null;
}

/**
 * What one answer from POST /api/weave means for the visitor. Only the fixed
 * error words of the interface are read; a refusal's reason is the model's own
 * text and is not shown, because nothing promises it is fit for the page.
 */
export function weaveOutcome(status: number, body: unknown): WeaveOutcome {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  if (status === 200) {
    const id = fields.pictureId;
    return typeof id === "string" && PICTURE_ID.test(id)
      ? { kind: "woven", pictureId: id }
      : { kind: "refused", words: WEAVE_WORDS.unexpected };
  }

  const error = fields.error;
  if (status === 400 && error === "prompt") {
    return { kind: "refused", words: WEAVE_WORDS.prompt };
  }
  if (status === 422 && error === "refused") {
    return { kind: "refused", words: WEAVE_WORDS.refused };
  }
  if (status === 429 && error === "limit") {
    return {
      kind: "refused",
      words: fields.scope === "address" ? WEAVE_WORDS.limitAddress : WEAVE_WORDS.limitDay,
    };
  }
  if (status === 503 && error === "busy") {
    return { kind: "refused", words: WEAVE_WORDS.busy };
  }
  if (status === 503 && error === "closed") {
    return { kind: "refused", words: WEAVE_WORDS.closed };
  }
  return { kind: "refused", words: WEAVE_WORDS.unexpected };
}

/** Sends one prompt. A network failure is an answer too, never a thrown error the form has to guess at. */
export async function submitWeave(prompt: string, send: typeof fetch = fetch): Promise<WeaveOutcome> {
  const problem = promptProblem(prompt);
  if (problem !== null) {
    return { kind: "refused", words: problem };
  }

  let response: Response;
  try {
    response = await send("/api/weave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    });
  } catch {
    return { kind: "refused", words: WEAVE_WORDS.unreachable };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return weaveOutcome(response.status, body);
}

/** Where a woven picture is shown. */
export function picturePath(pictureId: string): string {
  return `/p/${pictureId}`;
}
