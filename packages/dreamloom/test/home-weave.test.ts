import { describe, expect, it } from "vitest";
import { WEAVE_WORDS, picturePath, promptProblem, submitWeave, weaveOutcome } from "@/components/weave/outcome";

const PICTURE = "0123456789abcdef0123456789abcdef";

describe("the weave form's words for each answer of POST /api/weave", () => {
  const refusals: [number, unknown, string][] = [
    [400, { error: "prompt" }, WEAVE_WORDS.prompt],
    [422, { error: "refused", reason: "the model's own text" }, WEAVE_WORDS.refused],
    [429, { error: "limit", scope: "address" }, WEAVE_WORDS.limitAddress],
    [429, { error: "limit", scope: "day" }, WEAVE_WORDS.limitDay],
    [503, { error: "busy" }, WEAVE_WORDS.busy],
    [503, { error: "closed" }, WEAVE_WORDS.closed],
    [500, { error: "boom" }, WEAVE_WORDS.unexpected],
    [502, null, WEAVE_WORDS.unexpected],
  ];

  for (const [status, body, words] of refusals) {
    it(`${status} ${JSON.stringify(body)} reads "${words}"`, () => {
      expect(weaveOutcome(status, body)).toEqual({ kind: "refused", words });
    });
  }

  it("never shows the model's refusal reason", () => {
    const outcome = weaveOutcome(422, { error: "refused", reason: "<script>secret</script>" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  it("accepts a woven picture only with a well-formed id", () => {
    expect(weaveOutcome(200, { pictureId: PICTURE })).toEqual({ kind: "woven", pictureId: PICTURE });
    expect(weaveOutcome(200, { pictureId: "../admin" })).toEqual({ kind: "refused", words: WEAVE_WORDS.unexpected });
    expect(weaveOutcome(200, {})).toEqual({ kind: "refused", words: WEAVE_WORDS.unexpected });
  });

  it("routes a woven picture to its own page", () => {
    expect(picturePath(PICTURE)).toBe(`/p/${PICTURE}`);
  });
});

describe("sending a prompt", () => {
  it("posts the trimmed prompt as JSON to /api/weave", async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const send = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Response.json({ pictureId: PICTURE });
    }) as typeof fetch;
    const outcome = await submitWeave("  a fox reading by candlelight  ", send);
    expect(outcome).toEqual({ kind: "woven", pictureId: PICTURE });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/weave");
    expect(sent[0].init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ prompt: "a fox reading by candlelight" });
  });

  it("does not send a prompt outside 8 to 600 characters", async () => {
    let sent = 0;
    const send = (async () => {
      sent += 1;
      return Response.json({});
    }) as typeof fetch;
    expect(await submitWeave("short", send)).toEqual({ kind: "refused", words: WEAVE_WORDS.prompt });
    expect(await submitWeave("x".repeat(601), send)).toEqual({ kind: "refused", words: WEAVE_WORDS.prompt });
    expect(sent).toBe(0);
    expect(promptProblem("x".repeat(8))).toBeNull();
    expect(promptProblem("x".repeat(600))).toBeNull();
  });

  it("names a dead connection instead of throwing", async () => {
    const send = (async () => await Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    expect(await submitWeave("a lighthouse of glass", send)).toEqual({
      kind: "refused",
      words: WEAVE_WORDS.unreachable,
    });
  });

  it("reads a refusal whose body is not JSON as unexpected", async () => {
    const send = (async () => new Response("<html>gateway</html>", { status: 502 })) as typeof fetch;
    expect(await submitWeave("a lighthouse of glass", send)).toEqual({
      kind: "refused",
      words: WEAVE_WORDS.unexpected,
    });
  });
});
