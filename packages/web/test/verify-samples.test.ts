// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import { pickSamples, type TrySample } from "@/lib/data/samples";
import { fileFromSample } from "@/components/verify/sample";
import { VerifyScreen } from "@/components/verify/VerifyScreen";

/**
 * The three registered pictures a judge with no Moolam file can press, and
 * what happens when they do.
 *
 * Two things are held shut here. The list comes from the one rule both panels
 * pick by, so the home page and the verify page can never offer different
 * pictures. And pressing a plate runs the real check: the same upload to the
 * same service that a dropped file makes, never a stored answer.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

// The picture itself is next/image inside the app, which wants a Next runtime.
// What this file is about is the button around it and what pressing it sends.
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const ID = (word: string): Hex => `0x${word.repeat(32)}` as Hex;

const queried = {
  sha256: ID("7e"),
  phash: "6620159428093749285",
  blockhash: ID("1f"),
  width: 512,
  height: 384,
  format: "jpeg",
};

const answer = {
  result: {
    exact: null,
    best: { id: ID("2b"), phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 },
    matches: [{ id: ID("2b"), phashDistance: 0, blockhashDistance: 0, variant: "identity", score: 1 }],
    confidence: 0.99,
    queried,
  },
  manifest: { present: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the one rule both panels pick their samples by", () => {
  const plates = [
    { id: ID("11"), picture: "https://gateway/ipfs/one" },
    { id: ID("22"), picture: "https://gateway/ipfs/two" },
    { id: ID("33"), picture: "https://gateway/ipfs/two" },
    { id: ID("44"), picture: "https://gateway/ipfs/four" },
    { id: ID("55"), picture: "https://gateway/ipfs/five" },
  ];

  it("offers the newest three, one per picture, when nothing else is known", () => {
    expect(pickSamples(plates)).toEqual([
      { id: ID("11"), url: "https://gateway/ipfs/one" },
      { id: ID("22"), url: "https://gateway/ipfs/two" },
      { id: ID("44"), url: "https://gateway/ipfs/four" },
    ]);
  });

  it("never offers the same picture twice, whatever passports it is registered under", () => {
    const urls = pickSamples(plates).map((sample) => sample.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("puts a re-checked picture with a statement first, without dropping anything from the row", () => {
    const marks = {
      [ID("44").toLowerCase()]: { stated: true, rechecked: true },
      [ID("22").toLowerCase()]: { stated: true, rechecked: false },
      [ID("11").toLowerCase()]: { stated: false, rechecked: false },
    };

    expect(pickSamples(plates, marks).map((sample) => sample.id)).toEqual([ID("44"), ID("22"), ID("11")]);
  });

  it("carries the pinned title through when the page that offered it read one", () => {
    const marks = { [ID("11").toLowerCase()]: { stated: false, rechecked: false, title: "A church in a storm" } };
    expect(pickSamples(plates, marks)[0]).toEqual({
      id: ID("11"),
      url: "https://gateway/ipfs/one",
      title: "A church in a storm",
    });
  });

  it("falls back to the newest three when the index said nothing at all", () => {
    expect(pickSamples(plates, {}).map((sample) => sample.id)).toEqual(pickSamples(plates).map((sample) => sample.id));
  });
});

describe("the bytes behind a pressed plate", () => {
  const sample: TrySample = { id: ID("2b"), url: "ipfs://bafkreisample", title: "A church in a storm" };

  it("hands the check a real file, named after the picture", async () => {
    const file = await fileFromSample(sample, async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));

    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("a-church-in-a-storm.png");
    expect(file.size).toBe(3);
  });

  it("calls a gateway answer with no type a JPEG rather than sending a typeless part", async () => {
    const file = await fileFromSample({ id: ID("2b"), url: "ipfs://x" }, async () => new Blob([new Uint8Array([9])]));

    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/\.jpeg$/);
  });
});

describe("pressing one of the offered plates", () => {
  it("uploads the picture to the verify service, the same way a dropped file is uploaded", async () => {
    const sent: { url: string; body: unknown }[] = [];

    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    URL.createObjectURL = () => "blob:sample";
    URL.revokeObjectURL = () => undefined;

    vi.stubGlobal("fetch", async (input: string | URL, options: { body?: unknown } = {}) => {
      const url = String(input);
      sent.push({ url, body: options.body });
      if (url.endsWith("/verify")) {
        return { ok: true, status: 200, json: async () => answer } as Response;
      }
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }) } as Response;
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const samples: TrySample[] = [{ id: ID("2b"), url: "ipfs://bafkreisample", title: "A church in a storm" }];

    await act(async () => {
      root.render(
        createElement(
          NextIntlClientProvider as never,
          { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
          createElement(VerifyScreen, { samples }),
        ),
      );
    });

    const plates = host.querySelectorAll("[data-verify-samples] button");
    expect(plates).toHaveLength(1);
    expect(host.textContent).toContain("A church in a storm");

    await act(async () => {
      (plates[0] as HTMLButtonElement).click();
      await new Promise((settle) => setTimeout(settle, 0));
    });

    const upload = sent.find((one) => one.url.endsWith("/verify"));
    expect(upload, "the press reached the verify service").toBeDefined();
    const body = upload?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    // The same one part a dropped file travels in, under the same name.
    expect([...body.keys()]).toEqual(["file"]);
    expect(body.get("file")).toBeInstanceOf(File);

    // The bytes were fetched from the pinned picture before the upload, which
    // is the whole difference between a press and a drop.
    expect(sent[0].url).toContain("bafkreisample");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe("the home panel's result", () => {
  it("names the picture's passport as a link and prints the same challenge line the card prints", async () => {
    const { TryPanel } = await import("@/components/story/TryPanel");

    const disputed = {
      ...answer,
      result: {
        ...answer.result,
        best: { ...answer.result.best, dispute: { source: "chain", status: "open" } },
        matches: [{ ...answer.result.matches[0], dispute: { source: "chain", status: "open" } }],
      },
    };

    URL.createObjectURL = () => "blob:sample";
    URL.revokeObjectURL = () => undefined;

    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/verify")) {
        return { ok: true, status: 200, json: async () => disputed } as Response;
      }
      if (url.includes("bafkreisample")) {
        return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }) } as Response;
      }
      // The chain read behind the picture's own name. A panel that cannot reach
      // it still has to show the answer, so it is refused here on purpose.
      throw new Error("no network in this test");
    });

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(
          NextIntlClientProvider as never,
          { locale: "en", messages: en, timeZone: "Asia/Kolkata" },
          createElement(TryPanel, {
            onPreview: () => undefined,
            pinned: false,
            samples: [{ id: ID("2b"), url: "ipfs://bafkreisample", title: "A church in a storm" }],
          }),
        ),
      );
    });

    const plate = host.querySelector("li button") as HTMLButtonElement;
    expect(plate).not.toBeNull();

    await act(async () => {
      plate.click();
      await new Promise((settle) => setTimeout(settle, 20));
    });

    expect(host.textContent).toContain("Open its passport");
    expect(host.querySelector(`a[href="/passport/${ID("2b")}"]`)).not.toBeNull();
    expect(host.textContent).toContain("A church in a storm");
    expect(host.textContent).toContain("This passport is under challenge.");
    expect(host.querySelector("[data-dispute-line]")?.className).toContain("text-failed");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
