import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { VerifierError } from "@/lib/verifier/client";
import { passportFor, verifyProblem, type Answer } from "@/components/verify/answer";
import { isImageSignature, sizeLabel, uploadProblem } from "@/components/verify/upload";
import { AnswerCard } from "@/components/verify/AnswerCard";
import { VerifyScreen } from "@/components/verify/VerifyScreen";
import type { MatchedPassport } from "@/components/verify/lookup";

/**
 * The Verify polish of wave 1: a renamed text file is refused before it is
 * sent, the service's own not-an-image refusal gets the page's sentence, no
 * size reads 0 KB, a failed chain read keeps the match, and the tool is in the
 * server's HTML visible.
 *
 * Does NOT cover the phone layout of the second Choose another or the scroll
 * itself, which need a real browser; nor the home page's drop, which has its
 * own check path.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const ID = `0x${"4d".repeat(32)}` as Hex;

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const TEXT = [...new TextEncoder().encode("hello, this is not a picture")];

function draw(node: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider as unknown as FunctionComponent<Record<string, unknown>>,
      { locale: "en", messages: en, timeZone: "UTC" },
      node,
    ),
  );
}

function tagOf(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

const MATCH: Answer = {
  kind: "close",
  id: ID,
  confidence: 0.94,
  variant: "identity",
  others: 0,
  manifest: false,
  phashDistance: 1,
  blockhashDistance: 0,
  queried: { sha256: `0x${"7e".repeat(32)}`, phash: "c3a5", blockhash: `0x${"1f".repeat(32)}`, width: 614, height: 410, format: "jpeg" },
};

describe("a file's first bytes", () => {
  it("accepts the three signatures the service decodes", () => {
    expect(isImageSignature(new Uint8Array(JPEG))).toBe(true);
    expect(isImageSignature(new Uint8Array(PNG))).toBe(true);
    expect(isImageSignature(new Uint8Array(WEBP))).toBe(true);
  });

  it("refuses text, a RIFF that is not WebP, and nothing at all", () => {
    expect(isImageSignature(new Uint8Array(TEXT))).toBe(false);
    expect(isImageSignature(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBe(false);
    expect(isImageSignature(new Uint8Array([]))).toBe(false);
  });

  it("refuses a text file named .png before anything is sent, with the page's own sentence", async () => {
    const renamed = new File([new Uint8Array(TEXT)], "notes.png", { type: "image/png" });
    expect(await uploadProblem(renamed)).toEqual({ key: "problem.notAnImage" });
    expect(en.verify.problem.notAnImage).toBe("That file could not be read as an image. JPEG, PNG or WebP.");
  });

  it("lets a real JPEG, PNG and WebP through", async () => {
    for (const [bytes, name, type] of [
      [JPEG, "a.jpg", "image/jpeg"],
      [PNG, "a.png", "image/png"],
      [WEBP, "a.webp", "image/webp"],
    ] as const) {
      expect(await uploadProblem(new File([new Uint8Array(bytes)], name, { type })), name).toBeNull();
    }
  });

  it("still answers the size and type test first", async () => {
    expect(await uploadProblem(new File([], "empty.png", { type: "image/png" }))).toEqual({ key: "problem.empty" });
    expect(await uploadProblem(new File(["x"], "notes.txt", { type: "text/plain" }))).toEqual({ key: "problem.notAnImage" });
  });
});

describe("the service saying the upload is not an image", () => {
  it("maps the 400 refusal to the not-an-image sentence, with no English reason under it", () => {
    const error = new VerifierError(
      "bad-request",
      400,
      "the upload is not an image we can read: only JPEG, PNG and WebP pictures are taken",
    );
    expect(verifyProblem(error)).toEqual({ key: "problem.notAnImage" });
  });

  it("maps the 415 refusal the same way", () => {
    expect(verifyProblem(new VerifierError("not-an-image", 415, "not-an-image"))).toEqual({ key: "problem.notAnImage" });
  });

  it("leaves any other 400 on the request sentence with its reason", () => {
    expect(verifyProblem(new VerifierError("bad-request", 400, 'send the image in a multipart field named "file"'))).toEqual({
      key: "problem.badRequest",
      reason: 'send the image in a multipart field named "file"',
    });
  });
});

describe("a file size", () => {
  it("prints nothing for zero or an unknown size", () => {
    expect(sizeLabel(0)).toBe("");
    expect(sizeLabel(undefined)).toBe("");
    expect(sizeLabel(Number.NaN)).toBe("");
  });

  it("never prints 0 KB for a file of a few bytes", () => {
    expect(sizeLabel(24)).toBe("1 KB");
    expect(sizeLabel(46_000)).toBe("46 KB");
    expect(sizeLabel(3_400_000)).toBe("3.4 MB");
  });
});

describe("a match whose passport cannot be read from Monad", () => {
  it("keeps the answer and draws the lookupFailed line, not the RPC client's error", async () => {
    const raw = "HTTP request failed. Status: 429 URL: https://rpc.monad.xyz Details: rate limited";
    const passport = await passportFor(MATCH, async () => {
      throw new Error(raw);
    });
    expect(passport).toBeNull();

    const markup = draw(createElement(AnswerCard, { stage: { kind: "answer", answer: MATCH, passport } }));
    expect(markup).toContain(en.verify.lookupFailed);
    expect(markup).toContain(en.verify.matched);
    expect(markup).not.toContain(en.verify.problem.badResponse);
    expect(markup).not.toContain("429");
    expect(markup).not.toContain("rpc.monad.xyz");
  });

  it("hands back the passport when the read works, and reads nothing on a miss", async () => {
    const found = { id: ID, kind: 0, registeredAt: "1790000000", creator: ID, generatorAgentId: "0", disputed: false } as MatchedPassport;
    expect(await passportFor(MATCH, async () => found)).toBe(found);

    const read = vi.fn(async () => found);
    const miss: Answer = { kind: "miss", manifest: false, queried: MATCH.queried };
    expect(await passportFor(miss, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("sets the kind and the date apart evenly, with no stray slash", () => {
    const found = { id: ID, kind: 0, registeredAt: "1790000000", creator: ID, generatorAgentId: "0", disputed: false } as MatchedPassport;
    const markup = draw(createElement(AnswerCard, { stage: { kind: "answer", answer: MATCH, passport: found } }));
    const meta = tagOf(markup, "data-still-meta");
    expect(meta).toContain("gap-x-2");
    const line = markup.slice(markup.indexOf("data-still-meta"), markup.indexOf("</p>", markup.indexOf("data-still-meta")));
    expect(line).toContain("<span>Generated</span><span aria-hidden=\"true\">/</span><span>");
    expect(line).not.toContain("mx-1");
  });
});

describe("the tool before its script runs", () => {
  const samples = [{ id: ID, url: "ipfs://bafkreisample", title: "Marina Beach Kite Sellers at Dusk" }];
  const markup = draw(createElement(VerifyScreen, { samples }));
  const HIDDEN = /opacity:\s*0(?![.\d])/;

  it("serves the drop box, the plates and the answer card with no opacity 0", () => {
    for (const attribute of ["data-verify-drop", "data-verify-samples", "data-answer-card"]) {
      expect(tagOf(markup, attribute), attribute).not.toMatch(HIDDEN);
    }
    expect(tagOf(markup, "data-verify-drop")).toContain("rise");
    expect(tagOf(markup, "data-answer-card")).toContain("rise");
    expect(markup).not.toMatch(HIDDEN);
  });

  it("serves Choose an image and the sample plates in the HTML", () => {
    expect(markup).toContain(en.verify.choose);
    expect(markup).toContain("Marina Beach Kite Sellers at Dusk");
  });

  it("draws no phone Choose another before there is an answer", () => {
    expect(markup).not.toContain("data-choose-after");
  });
});
