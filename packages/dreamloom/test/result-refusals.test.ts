import { describe, expect, it } from "vitest";
import type { RefusalWord } from "@/lib/server/http";
import {
  FAILURE_WORDS,
  PAGE_WORDS,
  REFUSAL_WORDS,
  failureWords,
  postMove,
  postRegister,
  readPicture,
  refusalFor,
  type Action,
} from "@/components/result/picture-api";

const ID = "0123456789abcdef0123456789abcdef";
const ACTIONS: Action[] = ["read", "cosign", "register", "move", "claim", "remember"];

/** Every word the server's refusal type allows. A new word there fails this list until it has words here. */
const EVERY_WORD: Record<RefusalWord, true> = {
  "not-found": true,
  prompt: true,
  terms: true,
  title: true,
  origin: true,
  address: true,
  recipient: true,
  state: true,
  "not-holder": true,
  forgotten: true,
  refused: true,
  limit: true,
  busy: true,
  closed: true,
  upstream: true,
};

describe("every refusal word from the server has plain words", () => {
  for (const word of Object.keys(EVERY_WORD) as RefusalWord[]) {
    for (const action of ACTIONS) {
      it(`${word} during ${action}`, () => {
        const entry = REFUSAL_WORDS[word];
        const expected = typeof entry === "string" ? entry : entry[action];
        const { words } = refusalFor(action, { error: word });
        expect(words).toBe(expected);
        expect(words.length).toBeGreaterThan(20);
        expect(words).not.toBe(PAGE_WORDS.unexpected);
      });
    }
  }

  it("says the next step for the words the order names", () => {
    expect(refusalFor("register", { error: "limit", scope: "day" }).words).toMatch(/Come back tomorrow, or sign it/);
    expect(refusalFor("cosign", { error: "limit", scope: "day" }).words).toMatch(/let Dreamloom hold it/);
    expect(refusalFor("move", { error: "closed" }).words).toMatch(/keeps holding yours/);
    expect(refusalFor("cosign", { error: "origin" }).words).toMatch(/Reload this page/);
    expect(refusalFor("register", { error: "title" }).words).toMatch(/1 to 120 characters/);
    expect(refusalFor("move", { error: "not-holder" }).words).toMatch(/no longer holds/);
    expect(refusalFor("move", { error: "recipient" }).words).toMatch(/Connect your own Moolam account/);
    expect(refusalFor("move", { error: "address" }).words).toMatch(/Connect your Moolam account again/);
  });

  it("reads the picture again after a refusal that means its state moved", () => {
    expect(refusalFor("register", { error: "state" }).reload).toBe(true);
    expect(refusalFor("move", { error: "not-holder" }).reload).toBe(true);
    expect(refusalFor("register", { error: "upstream" }).reload).toBe(true);
    expect(refusalFor("register", { error: "title" }).reload).toBe(false);
  });

  it("never shows the server's raw text for a word it does not know", () => {
    expect(refusalFor("move", { error: "<b>secret</b>" }).words).toBe(PAGE_WORDS.unexpected);
    expect(refusalFor("move", { error: "toString" }).words).toBe(PAGE_WORDS.unexpected);
    expect(refusalFor("move", null).words).toBe(PAGE_WORDS.unexpected);
  });

  it("maps each failure word a picture record can hold", () => {
    for (const word of ["expired", "taken", "cosign", "register", "terms"]) {
      expect(failureWords(word)).toBe(FAILURE_WORDS[word]);
    }
    expect(failureWords("something-new")).toBe(FAILURE_WORDS.cosign);
  });
});

describe("the requests behind the page", () => {
  const answer = (status: number, body: unknown) => (async () => Response.json(body, { status })) as typeof fetch;

  it("reads a 404 as a picture that is not here, and a bad id without asking", async () => {
    expect(await readPicture(ID, answer(404, { error: "not-found" }))).toEqual({ kind: "missing" });
    let asked = 0;
    const counting = (async () => {
      asked += 1;
      return Response.json({});
    }) as typeof fetch;
    expect(await readPicture("../api/weave", counting)).toEqual({ kind: "missing" });
    expect(asked).toBe(0);
  });

  it("reads a picture in the server's shape", async () => {
    const body = { state: "woven", prompt: "a fox reading", createdAt: "2026-09-30T10:00:00.000Z" };
    expect(await readPicture(ID, answer(200, body))).toEqual({ kind: "ready", picture: body });
    expect((await readPicture(ID, answer(200, { state: "haunted" }))).kind).toBe("error");
  });

  it("sends the title and the terms with a register, and the address with a move", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const send = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: "closed" }, { status: 503 });
    }) as typeof fetch;
    const register = await postRegister(ID, "askFirst", "A fox", send);
    const move = await postMove(ID, "0x52908400098527886E0F7030069857D2E4169EE7", send);
    expect(sent).toEqual([
      { url: `/api/pictures/${ID}/register`, body: { terms: "askFirst", title: "A fox" } },
      { url: `/api/pictures/${ID}/move`, body: { address: "0x52908400098527886E0F7030069857D2E4169EE7" } },
    ]);
    expect(register).toEqual({ ok: false, refusal: { words: REFUSAL_WORDS.closed.register, reload: false } });
    expect(move).toEqual({ ok: false, refusal: { words: REFUSAL_WORDS.closed.move, reload: false } });
  });

  it("treats an unanswered request as unreachable and reads the picture again", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await postRegister(ID, "noAi", "A fox", down)).toEqual({
      ok: false,
      refusal: { words: PAGE_WORDS.unreachable, reload: true },
    });
  });
});
