import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import consentAbiJson from "../../contracts/abi/MoolamConsent.json";
import registryAbiJson from "../../contracts/abi/MoolamRegistry.json";
import receiverAbiJson from "../../contracts/abi/MoolamReceiver.json";
import { ATTACKS } from "@/components/docs/breakIt/attacks";
import { decodeRefusal, refusalLine, refusalOf } from "@/components/docs/breakIt/decode";
import { repoRoot } from "@/lib/docs/paths";
import en from "@/messages/en.json";
import { readPage } from "@/lib/docs/pages";
import { renderPage } from "@/lib/docs/render";

/**
 * The page that lets a judge attack the live contracts from the browser.
 *
 * Three things are worth holding down here. Every row points at a Foundry test
 * that really exists, so the page cannot claim a rule is pinned by a test
 * somebody renamed. The decoder turns the exact bytes Monad answered with,
 * copied out of the saved transcripts, into the name and the arguments the
 * screen prints. And a read that failed for any other reason comes back as
 * "could not ask" rather than as a refusal, which is the one way this page
 * could lie.
 */

// The docs renderer reaches next-intl's navigation through its link, and that
// only resolves inside the bundler. The link itself is all this test needs.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const abis: Record<string, Abi> = {
  consent: consentAbiJson as Abi,
  registry: registryAbiJson as Abi,
  receiver: receiverAbiJson as Abi,
};

/** The bytes the live consent register answered on 2026-09-21, from proofs/consent-attacks.txt. */
const NOT_HOLDER =
  "0x0c9ccf20cdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638000000000000000000000000000000000000000000000000000000000000dead" as Hex;
const NOT_PRINTABLE = "0xfd3fe8c3000000000000000000000000000000000000000000000000000000000000000a" as Hex;
const TOO_LONG = "0x2bcfe3eb0000000000000000000000000000000000000000000000000000000000000101" as Hex;
const EMPTY_BATCH = "0xc2e5347d" as Hex;

describe("the attacks the page can send", () => {
  it("is the twelve of the saved runs, control last", () => {
    expect(ATTACKS.map((attack) => attack.id)).toEqual([
      "consent-from-stranger",
      "conditions-missing",
      "conditions-newline",
      "conditions-too-long",
      "batch-too-large",
      "batch-empty",
      "consent-no-money",
      "edit-by-non-owner",
      "attest-from-stranger",
      "report-from-fake-forwarder",
      "expired-deadline",
      "control",
    ]);
    expect(ATTACKS.filter((attack) => attack.answer === "passes")).toHaveLength(1);
  });

  it.each(ATTACKS.map((attack) => [attack.id, attack] as const))(
    "%s names a Foundry test that exists",
    (_id, attack) => {
      const source = readFileSync(path.join(repoRoot, attack.test.file), "utf8");
      expect(source).toContain(`function ${attack.test.name}(`);
    },
  );

  it.each(ATTACKS.filter((attack) => attack.expected !== null).map((attack) => [attack.id, attack] as const))(
    "%s expects an error its own ABI carries",
    (_id, attack) => {
      const names = (abis[attack.abi] as { type: string; name?: string }[])
        .filter((item) => item.type === "error")
        .map((item) => item.name);
      expect(names).toContain(attack.expected);
    },
  );

  it("aims the receiver row at the public simulation receiver and expects its first refusal", () => {
    const row = ATTACKS.find((attack) => attack.id === "report-from-fake-forwarder");
    expect(row).toMatchObject({
      contract: "SimulationReceiver",
      address: "0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95",
      fn: "onReport",
      from: "0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7",
      expected: "InvalidSender",
    });
    // A caller that is not the mock forwarder meets the template's first revert
    // before the pins or the sending wallet are read.
    const template = readFileSync(
      path.join(repoRoot, "packages/contracts/src/vendor/chainlink/ReceiverTemplate.sol"),
      "utf8",
    );
    const onReport = template.slice(template.indexOf("function onReport("));
    expect(onReport.match(/revert (\w+)\(/)?.[1]).toBe("InvalidSender");
    const receiver = readFileSync(path.join(repoRoot, "packages/contracts/src/SimulationReceiver.sol"), "utf8");
    expect(receiver).toContain("contract SimulationReceiver is ReceiverTemplate");

    const answer = encodeErrorResult({
      abi: abis.receiver,
      errorName: "InvalidSender",
      args: ["0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7", "0x9eF6468C5f37b976E57d52054c693269479A784d"],
    });
    expect(refusalLine(decodeRefusal(answer, abis.receiver))).toBe(
      "InvalidSender(0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7, 0x9eF6468C5f37b976E57d52054c693269479A784d)",
    );
  });

  it("sends every call from an address that is not the app's own", () => {
    // A key for any of these would defeat the point: the refusal has to be
    // about who is asking, and nobody here can sign for the burn address.
    expect(new Set(ATTACKS.map((attack) => attack.from)).size).toBe(4);
  });
});

describe("reading what the chain answered", () => {
  it("names a refusal and its arguments from the bytes the register really sent", () => {
    const refusal = decodeRefusal(NOT_HOLDER, abis.consent);
    expect(refusal).toMatchObject({ kind: "refused", name: "NotPassportHolder", decoded: true });
    expect(refusalLine(refusal)).toBe(
      "NotPassportHolder(0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638, 0x000000000000000000000000000000000000dEaD)",
    );
  });

  it("carries the position of the byte the text was refused for", () => {
    expect(refusalLine(decodeRefusal(NOT_PRINTABLE, abis.consent))).toBe("ConstraintInfoNotPrintable(10)");
    expect(refusalLine(decodeRefusal(TOO_LONG, abis.consent))).toBe("ConstraintInfoTooLong(257)");
  });

  it("reads an error with no arguments", () => {
    expect(refusalLine(decodeRefusal(EMPTY_BATCH, abis.consent))).toBe("EmptyBatch()");
  });

  it("calls a revert with no data what it is, which is how a value transfer is refused", () => {
    expect(decodeRefusal("0x", abis.consent)).toEqual({ kind: "empty" });
    expect(decodeRefusal(undefined, abis.consent)).toEqual({ kind: "empty" });
  });

  it("keeps the selector of a revert the ABI does not name", () => {
    const refusal = decodeRefusal("0xdeadbeef", abis.consent);
    expect(refusal).toEqual({ kind: "refused", name: "0xdeadbeef", args: [], decoded: false });
  });

  it("reads the decode viem did for itself when the call went through simulateContract", () => {
    const thrown = new ContractFunctionRevertedError({
      abi: abis.registry,
      data: "0x2805c495000000000000000000000000c5ead1e4e5c6d56e87e02317f3fb3731cb0b6ef7" as Hex,
      functionName: "appendEdit",
    });
    const refusal = refusalOf(new BaseError("reverted", { cause: thrown }), abis.registry);
    expect(refusalLine(refusal)).toBe("NotParentOwner(0xC5ead1E4E5C6d56E87e02317f3fB3731cB0b6Ef7)");
  });

  it("turns a rate limited endpoint into no answer at all, never into a refusal", () => {
    const network = new HttpRequestError({ url: "https://example.invalid", details: "429 too many requests" });
    expect(refusalOf(network, abis.consent)).toEqual({ kind: "unknown" });
    expect(refusalOf(new Error("fetch failed"), abis.consent)).toEqual({ kind: "unknown" });
    expect(refusalOf(undefined, abis.consent)).toEqual({ kind: "unknown" });
  });
});

/**
 * The page rendered the way the docs route renders it, as markup.
 *
 * Held per page: the highlighter is the slow part of a docs render and three
 * tests here read the same two pages.
 */
const markup = new Map<string, Promise<string>>();

function markupOf(slug: string): Promise<string> {
  const already = markup.get(slug);
  if (already !== undefined) {
    return already;
  }
  const work = (async () => {
    const page = readPage(slug);
    const { content } = await renderPage(slug, page?.body ?? "");
    return renderToStaticMarkup(
      createElement(NextIntlClientProvider, { locale: "en", timeZone: "UTC", messages: en }, content),
    );
  })();
  markup.set(slug, work);
  return work;
}

/** The whole suite runs a hundred files at once, so a render gets room to breathe. */
const RENDER_TIMEOUT = 30_000;

describe("the fence that puts the screen in a page", () => {
  it("mounts the component where the page writes a break-it fence", async () => {
    expect(readPage("security/try-to-break-it")?.body).toContain("```break-it");
    const page = await markupOf("security/try-to-break-it");
    expect(page).toContain("Twelve attacks.");
    // Twelve rows and the button that runs all of them.
    expect(page.split(">Run<").length - 1).toBe(12);
    expect(page).toContain("Run all twelve");
  }, RENDER_TIMEOUT);

  it("asks nothing before a reader presses, so every row opens unanswered", async () => {
    const page = await markupOf("security/try-to-break-it");
    expect(page.split("not asked yet").length - 1).toBe(12);
    expect(page).toContain("nothing has been sent yet");
    expect(page).toContain("the saved run answered NotPassportHolder");
    expect(page).not.toContain("simulated at block");
  }, RENDER_TIMEOUT);

  it("leaves every other page alone", async () => {
    expect(await markupOf("security/threat-model")).not.toContain("Twelve attacks.");
  }, RENDER_TIMEOUT);
});
