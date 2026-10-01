import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { describeForgetFailure } from "@/components/passport/PrivateCopyPanel";
import { Receipt } from "@/components/studio/Receipt";
import { verifyProblem } from "@/components/verify/answer";
import { describeEditFailure } from "@/lib/passport/edit";
import { describeUnsealFailure } from "@/lib/passport/unseal";
import { initialRegisterState } from "@/lib/studio/flow";
import { asGenerateFailure } from "@/lib/studio/generate";
import { describeFailure } from "@/lib/studio/problems";
import type { Studio } from "@/lib/studio/useStudio";
import {
  VerifierError,
  edit,
  forgetPrivateCopy,
  generate,
  prepare,
  prepareResponseSchema,
  unseal,
  verify,
  type PrepareResponse,
} from "@/lib/verifier/client";

/**
 * A fault on Moolam's side reads as Moolam's fault on every screen that can meet one, and the
 * refusals pass 6 added to publishing a sealed picture each read as their own sentence.
 *
 * The failures go through the real client, from a stubbed fetch answering exactly what the service
 * sends, so the mapping is proven on the error a screen actually receives. A creator whose camera
 * signed the photo is told on the studio's stub what Moolam kept of that record. A full match gate
 * on the verify page reads as Moolam being busy.
 *
 * Does NOT click anything in a browser, and does not prove a translation says the same thing as the
 * English, only that each language says something of its own.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));
const LANGS = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
const PASSPORT = `0x${"7c".repeat(32)}` as Hex;
const FAULT_BODY = { error: "service-fault", reason: "the service could not read this picture right now, try again" };
const FAULT_SENTENCE =
  "This was a fault on Moolam's side, not a problem with your picture. Nothing was saved. Try again in a minute.";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: status < 400, status, json: async () => body })),
  );
}

async function refusal(status: number, body: unknown, call: () => Promise<unknown>): Promise<VerifierError> {
  stubFetch(status, body);
  try {
    await call();
  } catch (error) {
    if (error instanceof VerifierError) {
      return error;
    }
    throw error;
  }
  throw new Error("the call answered instead of refusing");
}

const picture = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], "harbour.jpg", { type: "image/jpeg" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a 503 service-fault", () => {
  it("reads on the verify page as Moolam's fault, not as an answer it did not understand", async () => {
    const error = await refusal(503, FAULT_BODY, () => verify({ file: picture() }));
    expect(verifyProblem(error)).toEqual({ key: "problem.serviceFault" });
  });

  it("reads in the studio as Moolam's fault with a retry, on an upload and on a drawing", async () => {
    const prepared = await refusal(503, FAULT_BODY, () =>
      prepare({ file: picture(), title: "Harbour", accessToken: "token" }),
    );
    expect(describeFailure(prepared, "prepare")).toEqual({ key: "serviceFault", next: "again" });

    const drawn = await refusal(503, FAULT_BODY, () =>
      generate({
        prompt: "a lighthouse in a monsoon storm",
        title: "Lighthouse",
        creator: `0x${"85".repeat(20)}` as Hex,
        deadline: 1_790_000_000,
        accessToken: "token",
      }),
    );
    expect(asGenerateFailure(describeFailure(drawn, "prepare"), "prepare")).toEqual({
      key: "serviceFault",
      next: "generateAgain",
    });
  });

  it("reads on the edit panel as Moolam's fault with a retry, never as an edit that may be out", async () => {
    const error = await refusal(503, FAULT_BODY, () =>
      edit({ file: picture(), title: "Harbour, warmer", parentId: PASSPORT, note: "", accessToken: "token" }),
    );
    expect(describeEditFailure(error)).toEqual({ key: "serviceFault", next: "later" });
  });

  it("reads on the publish panel as Moolam's fault with a retry", async () => {
    const error = await refusal(503, FAULT_BODY, () =>
      unseal({ file: picture(), passportId: PASSPORT, accessToken: "token" }),
    );
    expect(describeUnsealFailure(error)).toEqual({ key: "serviceFault", next: "later" });
  });
});

describe("a 503 busy on the verify page", () => {
  it("reads as Moolam being busy, not as an answer it did not understand, with no English word under it", async () => {
    const error = await refusal(503, { error: "busy" }, () => verify({ file: picture() }));
    expect(verifyProblem(error)).toEqual({ key: "problem.busy" });
  });
});

describe("the refusals pass 6 added to publishing a sealed picture", () => {
  const publish = () => unseal({ file: picture(), passportId: PASSPORT, accessToken: "token" });

  it("reads a 409 unseal-in-progress as a publish already running, with the page reload as the way on", async () => {
    const error = await refusal(409, { error: "unseal-in-progress", passportId: PASSPORT }, publish);
    expect(describeUnsealFailure(error)).toEqual({ key: "unsealInProgress", next: "showPicture" });
  });

  it("reads a 409 thumbnail-held-privately as its own sentence, without the service's English under it", async () => {
    const error = await refusal(
      409,
      { error: "thumbnail-held-privately", passportId: PASSPORT, reason: "nothing was published and the passport still reads sealed" },
      publish,
    );
    expect(describeUnsealFailure(error)).toEqual({ key: "thumbnailHeldPrivately" });
  });

  it("reads a 422 fingerprint-unstable as its own sentence, with no retry because the same file would fail again", async () => {
    const error = await refusal(
      422,
      { error: "fingerprint-unstable", limit: 8, distance: 12, reason: "this picture's thumbnail reads as another picture" },
      publish,
    );
    expect(describeUnsealFailure(error)).toEqual({ key: "fingerprintUnstable" });
  });

  it("reads the route limiter's 429 as the rate limit, on publishing and on deleting a private copy", async () => {
    const limited = { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded, retry in 1 minute" };

    const published = await refusal(429, limited, publish);
    expect(describeUnsealFailure(published)).toEqual({ key: "rateLimited", next: "later" });

    const deleted = await refusal(429, limited, () => forgetPrivateCopy({ passportId: PASSPORT, accessToken: "token" }));
    expect(describeForgetFailure(deleted)).toEqual({ key: "rateLimited" });
  });
});

describe("the sentences those keys print", () => {
  const files = LANGS.map((lang) => [lang, JSON.parse(readFileSync(`${MESSAGES}${lang}.json`, "utf8"))] as const);
  const PATHS = [
    "verify.problem.serviceFault",
    "studio.failure.serviceFault",
    "passport.edit.failure.serviceFault",
    "passport.unseal.failure.serviceFault",
    "passport.unseal.failure.unsealInProgress",
    "passport.unseal.failure.thumbnailHeldPrivately",
    "passport.unseal.failure.fingerprintUnstable",
    "studio.receipt.cameraKept",
    "studio.receipt.cameraDropped",
    "studio.receipt.credentialsKept",
  ];
  const at = (tree: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], tree);

  it("says the fault sentence in English on all four screens", () => {
    const english = files[0][1];
    for (const path of PATHS.slice(0, 4)) {
      expect(at(english, path), path).toBe(FAULT_SENTENCE);
    }
  });

  it("says the publish refusals and the camera record in the order's English", () => {
    const english = files[0][1];
    expect(at(english, "passport.unseal.failure.unsealInProgress")).toBe(
      "This picture is already being published from another tab or device. Give it a moment, then reload the passport.",
    );
    expect(at(english, "passport.unseal.failure.thumbnailHeldPrivately")).toBe(
      "Nothing was published. A private copy of this same picture, kept for another passport, is in the way of its public copy. Try again later.",
    );
    expect(at(english, "passport.unseal.failure.fingerprintUnstable")).toBe(
      "This picture changes too little from side to side for a fingerprint that survives copying, so its public copy could never pass Chainlink's check. Nothing was published.",
    );
    expect(at(english, "studio.receipt.cameraKept")).toBe(
      "Your camera's own record is kept, with its location and serial number removed.",
    );
    expect(at(english, "studio.receipt.cameraDropped")).toBe(
      "Your camera's own record was removed, because its location could not be taken out cleanly.",
    );
    expect(at(english, "studio.receipt.credentialsKept")).toBe(
      "This file's earlier Content Credentials are kept inside Moolam's, with any location and serial removed.",
    );
  });

  it("says the verify page's busy sentence in the order's English, and in every language in its own words", () => {
    const english = files[0][1];
    expect(at(english, "verify.problem.busy")).toBe("Moolam is busy checking other pictures. Try again in a minute.");
    for (const [lang, tree] of files) {
      const said = at(tree, "verify.problem.busy");
      expect(typeof said, lang).toBe("string");
      if (lang !== "en") {
        expect(said, lang).not.toBe(at(english, "verify.problem.busy"));
      }
    }
  });

  it("are in every language, each in its own words rather than the English", () => {
    const english = files[0][1];
    for (const [lang, tree] of files) {
      for (const path of PATHS) {
        const said = at(tree, path);
        expect(typeof said, `${lang} ${path}`).toBe("string");
        if (lang !== "en") {
          expect(said, `${lang} ${path}`).not.toBe(at(english, path));
        }
      }
    }
  });
});

describe("the camera's own record on the studio's stub", () => {
  const PUBLIC: PrepareResponse = {
    passport: {
      exactHash: PASSPORT,
      parentId: `0x${"00".repeat(32)}` as Hex,
      generatorAgentId: "0",
      phash: "7840506850305415717",
      blockhash256: `0x${"11".repeat(32)}` as Hex,
      manifestHash: `0x${"22".repeat(32)}` as Hex,
      kind: 1,
      fingerprintVersion: 1,
      metadataURI: "ipfs://metadata",
    },
    image: { cid: "cid", uri: "ipfs://image", gatewayUrl: "https://gateway/image", bytes: 10, width: 1600, height: 1200 },
    thumbnail: { cid: "thumb", uri: "ipfs://thumb", gatewayUrl: "https://gateway/thumb" },
    metadata: { cid: "meta", uri: "ipfs://metadata" },
    manifest: { embedded: true },
    preparedBy: "did:privy:someone",
  };
  const SEALED = {
    passport: PUBLIC.passport,
    metadata: PUBLIC.metadata,
    manifest: { embedded: true },
    preparedBy: "did:privy:someone",
    sealed: true,
    signedFile: { name: "harbour.signed.jpg", type: "image/jpeg", bytes: "YmVuY2g=", sha256: PASSPORT },
  };

  function stub(prepared: unknown, locale: "en" | "ta" = "en"): string {
    const studio = {
      authenticated: false,
      account: { kind: "email", value: null },
      binding: { status: "unbound", passkey: null },
      bind: { txHash: null },
      register: { ...initialRegisterState, prepared },
      actions: {},
    } as unknown as Studio;
    const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
      locale: string;
      messages: unknown;
      timeZone: string;
    }>;
    const node: ReactElement = createElement(Receipt, { studio });
    return renderToStaticMarkup(
      createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
    );
  }

  const kept = "Your camera&#x27;s own record is kept, with its location and serial number removed.";
  const dropped = "Your camera&#x27;s own record was removed, because its location could not be taken out cleanly.";

  it("keeps the field the service sends, on a published answer and on a sealed one", () => {
    const published = prepareResponseSchema.parse({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "kept" } });
    const sealed = prepareResponseSchema.parse({ ...SEALED, manifest: { embedded: true, cameraRecord: "dropped" } });
    expect(published.manifest).toEqual({ embedded: true, cameraRecord: "kept" });
    expect(sealed.manifest).toEqual({ embedded: true, cameraRecord: "dropped" });
    const credentials = prepareResponseSchema.parse({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "credentials-kept" } });
    expect(credentials.manifest).toEqual({ embedded: true, cameraRecord: "credentials-kept" });
  });

  it("V112: says the file's own earlier credentials were kept, never the camera's, for a store that records no capture", () => {
    const credentials = "This file&#x27;s earlier Content Credentials are kept inside Moolam&#x27;s, with any location and serial removed.";
    const markup = stub({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "credentials-kept" } });
    expect(markup).toContain(credentials);
    expect(markup).not.toContain(kept);
    expect(markup).not.toContain(dropped);
    expect(stub({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "kept" } })).not.toContain(credentials);
  });

  it("says kept or removed under the manifest line, and nothing when the photo carried no record", () => {
    const keptMarkup = stub({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "kept" } });
    expect(keptMarkup).toContain(kept);
    expect(keptMarkup).not.toContain(dropped);

    const droppedMarkup = stub({ ...SEALED, manifest: { embedded: false, cameraRecord: "dropped" } });
    expect(droppedMarkup).toContain(dropped);
    expect(droppedMarkup).not.toContain(kept);

    const plain = stub(PUBLIC);
    expect(plain).not.toContain(kept);
    expect(plain).not.toContain(dropped);
  });

  it("says it in Tamil too", () => {
    const markup = stub({ ...PUBLIC, manifest: { embedded: true, cameraRecord: "kept" } }, "ta");
    expect(markup).toContain((ta as { studio: { receipt: Record<string, string> } }).studio.receipt.cameraKept ?? "missing");
  });
});
