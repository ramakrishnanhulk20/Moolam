import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import en from "@/messages/en.json";

/**
 * The co-sign page's own rules beyond the gate: P10 (a top-level page that
 * reports to its opener only by name and never reads from it, with the frame
 * and referrer headers), P11 (no silent rebind), P13 (registered and terms
 * written only on a receipt), P14 and P16 (two names at two trust levels, and
 * the platform's withheld when its agent changed hands), and the page kept
 * out of search.
 */

process.env.NEXT_PUBLIC_IPFS_GATEWAY = "https://lavender-personal-grasshopper-978.mypinata.cloud/ipfs/";

const stub = vi.hoisted(() => ({
  owner: "0xa374000000000000000000000000000000009afb" as string,
  card: { name: "Totally Real Corp" } as unknown,
  list: null as unknown,
  headers: new Map<string, string>(),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  routing: { locales: ["en", "ta"], defaultLocale: "en" },
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));
vi.mock("next/headers", () => ({ headers: async () => stub.headers }));
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) => (key: string) => `${namespace}.${key}`,
  setRequestLocale: () => undefined,
}));
vi.mock("@/lib/chain/registry", () => ({
  heldAgent: async () => ({ owner: stub.owner, uri: "data:,", card: stub.card }),
}));
vi.mock("@/components/agent/signed", () => ({ signedWorks: async () => [] }));
vi.mock("@/lib/data/platform-label", () => ({ heldPlatformList: async () => stub.list }));
vi.mock("@/lib/chain/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/chain/client")>();
  return { ...real, chain: { readContract: async () => stub.owner } };
});

const flow = await import("@/lib/cosign/flow");
const landed = await import("@/lib/cosign/landed");
const opener = await import("@/lib/cosign/opener");
const { cosignAgentFacts } = await import("@/lib/cosign/agent");
const { listingFor } = await import("@/lib/cosign/listing");
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
const { default: config } = await import("@/next.config");
const { default: robots } = await import("@/app/robots");
const { pagePaths } = await import("@/app/sitemap");
const cosignPage = await import("@/app/[locale]/cosign/page");
const { forgetCallers } = await import("@/lib/api/limit");
type CosignModel = import("@/lib/cosign/flow").CosignModel;
type AgentFacts = import("@/lib/cosign/listing").AgentFacts;
type CosignRecord = import("@/lib/cosign/record").CosignRecord;

const EXACT = `0x${"7a".repeat(32)}` as Hex;
const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const OWNER_AT_ONBOARDING = getAddress("0xa374000000000000000000000000000000009afb");
const TX = `0x${"5e".repeat(32)}` as Hex;
const REGISTRY = "0x1111111111111111111111111111111111111111" as Hex;
const CONSENT = "0x2222222222222222222222222222222222222222" as Hex;

const RECORD: CosignRecord = {
  state: "signed",
  agentId: "4242",
  platform: { name: "Acme Studio", agentId: "4242" },
  exactHash: EXACT,
  passport: {
    exactHash: EXACT,
    parentId: `0x${"00".repeat(32)}` as Hex,
    creator: WALLET,
    generatorAgentId: "4242",
    phash: "1",
    blockhash256: `0x${"ab".repeat(32)}` as Hex,
    manifestHash: `0x${"cd".repeat(32)}` as Hex,
    kind: 0,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreimetadata000000000000000",
    deadline: "1790001800",
  },
  files: {
    image: { cid: "bafkreiimage0000000000000000000", uri: "ipfs://bafkreiimage0000000000000000000", gatewayUrl: "https://g.example/ipfs/i", bytes: 10 },
    thumbnail: { cid: "bafkreithumb0000000000000000000", uri: "ipfs://bafkreithumb0000000000000000000", gatewayUrl: "https://g.example/ipfs/t", bytes: 10 },
    manifest: { cid: "bafkreimanif0000000000000000000", uri: "ipfs://bafkreimanif0000000000000000000", gatewayUrl: "https://g.example/ipfs/m", bytes: 10 },
    metadata: { cid: "bafkreimetadata000000000000000", uri: "ipfs://bafkreimetadata000000000000000", gatewayUrl: "https://g.example/ipfs/d", bytes: 10 },
  },
  openBy: 1_790_000_000,
  digest: `0x${"01".repeat(32)}` as Hex,
  agentSignature: `0x${"11".repeat(65)}` as Hex,
};

function model(actions: import("@/lib/cosign/flow").CosignAction[]): CosignModel {
  let at = flow.initialCosign;
  for (const action of [
    { type: "handle", valid: true },
    { type: "auth", signedIn: true },
    { type: "answer", outcome: { kind: "record", record: RECORD } },
    ...actions,
  ] as import("@/lib/cosign/flow").CosignAction[]) {
    at = flow.cosignReducer(at, action);
  }
  return at;
}

function render(state: CosignModel, agent: AgentFacts | null = null): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  const markup = renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(CosignSheet, { model: state, agent, wallet: WALLET, onPress: () => undefined }),
    ),
  );
  // The words are compared as a reader sees them, so an apostrophe React escaped still matches.
  return markup.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"");
}

function platform(overrides: Partial<import("@/lib/platforms/platforms").Platform> = {}): import("@/lib/platforms/platforms").Platform {
  return {
    name: "Acme Studio",
    agentId: 4242n,
    ownerAtOnboarding: OWNER_AT_ONBOARDING,
    creatorWallet: "0x3333333333333333333333333333333333333333",
    keyHash: `0x${"44".repeat(32)}` as Hex,
    origins: ["https://acme.example", "https://staging.acme.example"],
    validFrom: 1_780_000_000n,
    validTo: null,
    acceptedAt: 1_780_000_000n,
    ...overrides,
  };
}

afterEach(() => {
  stub.owner = OWNER_AT_ONBOARDING;
  stub.list = null;
  forgetCallers();
});

describe("P11: signing in never binds a passkey", () => {
  it("starts no write on its own in any state: the automatic work is reads and the terms after a pressed register", () => {
    const keys = Object.keys(flow.automatic(flow.initialCosign)).sort();
    expect(keys).toEqual(["clock", "gate", "landed", "open", "poll", "terms"]);
    for (const status of ["reading", "unbound", "bound", "bound-elsewhere", "unreadable"] as const) {
      const state = model([{ type: "binding", status }]);
      expect(Object.keys(flow.automatic(state))).not.toContain("bind");
    }
  });

  it("asks for a passkey on a press for a first-timer, and never binds from sign-in", () => {
    const first = model([{ type: "binding", status: "unbound" }]);
    expect(first.view).toBe("makePasskey");
    expect(flow.pressFor(first, "primary")).toBe("bind");
    expect(render(first)).toContain('data-press="bind"');
  });

  it("says a key lives on another device, and replacing it is its own press with the cost spelt out", () => {
    const elsewhere = model([{ type: "binding", status: "bound-elsewhere" }]);
    expect(elsewhere.view).toBe("passkeyElsewhere");
    expect(flow.pressFor(elsewhere, "primary")).toBe("recover");
    expect(flow.pressFor(elsewhere, "secondary")).toBe("bind");
    const markup = render(elsewhere);
    expect(markup).toContain(en.cosign.states.passkeyElsewhere.line);
    expect(markup).toContain("old passkey stops working for new pictures");
  });

  it("sends bindPasskey from exactly one place, the pressed bind", () => {
    const hook = readFileSync("lib/cosign/useCosign.ts", "utf8");
    expect(hook.match(/bindPasskeyCalldata\(/g)).toHaveLength(1);
    const bind = hook.slice(hook.indexOf("const bindThisDevice"), hook.indexOf("const recoverThisDevice"));
    expect(bind).toContain("bindPasskeyCalldata(");
    expect(hook.match(/bindThisDevice\(\)/g)).toHaveLength(1);
    expect(hook).toMatch(/case "bind":\s*void bindThisDevice\(\);/);
  });
});

describe("P13: registered and terms written are said only on a receipt", () => {
  const registered = {
    status: "success" as const,
    transactionHash: TX,
    logs: [{ address: REGISTRY, topics: [landed.PASSPORT_REGISTERED_TOPIC, EXACT, `0x${"00".repeat(12)}${WALLET.slice(2)}` as Hex] }],
  };
  const writerTopic = `0x${"00".repeat(12)}${WALLET.slice(2).toLowerCase()}` as Hex;
  const consentSet = {
    status: "success" as const,
    transactionHash: TX,
    logs: [{ address: CONSENT, topics: [landed.CONSENT_SET_TOPIC, EXACT, writerTopic, `0x${"00".repeat(32)}` as Hex] }],
  };

  it("takes only a successful receipt holding PassportRegistered for this very hash from the registry", () => {
    expect(landed.holdsRegistration(registered, EXACT, REGISTRY)).toBe(true);
    expect(landed.holdsRegistration({ ...registered, status: "reverted" }, EXACT, REGISTRY)).toBe(false);
    expect(landed.holdsRegistration(registered, `0x${"7b".repeat(32)}` as Hex, REGISTRY)).toBe(false);
    expect(landed.holdsRegistration(registered, EXACT, CONSENT)).toBe(false);
    expect(landed.holdsRegistration({ ...registered, logs: [] }, EXACT, REGISTRY)).toBe(false);
  });

  it("takes only a successful receipt holding ConsentSet for this passport from this wallet", () => {
    expect(landed.holdsConsentSet(consentSet, EXACT, WALLET, CONSENT)).toBe(true);
    expect(landed.holdsConsentSet({ ...consentSet, status: "reverted" }, EXACT, WALLET, CONSENT)).toBe(false);
    expect(landed.holdsConsentSet(consentSet, EXACT, OWNER_AT_ONBOARDING, CONSENT)).toBe(false);
    expect(landed.holdsConsentSet(registered, EXACT, WALLET, CONSENT)).toBe(false);
  });

  it("keeps the page signing while the send is out, and says registered only once the receipt is in", () => {
    const passed = { type: "gate", gate: { at: "passed", digest: RECORD.digest } } as const;
    const out = model([{ type: "binding", status: "bound" }, passed, { type: "send", send: { at: "confirming" } }]);
    expect(out.view).toBe("signing");
    expect(render(out)).not.toContain("data-seal-stamp");

    const unconfirmed = flow.cosignReducer(out, { type: "send", send: { at: "unconfirmed", failure: null } });
    expect(unconfirmed.view).toBe("failed");
    expect(flow.failReason(unconfirmed)).toBe("unconfirmed");
    expect(flow.pressFor(unconfirmed, "primary")).toBe("recheck");

    const done = flow.cosignReducer(out, { type: "send", send: { at: "registered", passportId: EXACT, txHash: TX } });
    expect(done.view).toBe("registered");
    const markup = render(done);
    expect(markup).toContain("data-seal-stamp");
    expect(markup).toContain(`href="/passport/${EXACT}"`);
    expect(markup).toContain(`/tx/${TX}`);
  });

  it("says terms written only after the terms step reached written, never while sending", () => {
    const base = model([
      { type: "binding", status: "bound" },
      { type: "send", send: { at: "registered", passportId: EXACT, txHash: TX } },
    ]);
    const sending = flow.cosignReducer(base, { type: "terms", terms: { at: "sending" } });
    expect(render(sending)).not.toContain(en.cosign.termsLine.written);
    expect(render(sending)).toContain(en.cosign.termsLine.sending);
    const written = flow.cosignReducer(base, { type: "terms", terms: { at: "written", txHash: TX } });
    expect(render(written)).toContain(en.cosign.termsLine.written);
    const failed = flow.cosignReducer(base, { type: "terms", terms: { at: "failed", failure: { key: "reverted" } } });
    expect(render(failed)).toContain(en.cosign.termsLine.failed);
    expect(flow.pressFor(failed, "secondary")).toBe("writeTerms");
  });

  it("sends the record's terms to setConsent unchanged, only after the register's receipt", () => {
    const hook = readFileSync("lib/cosign/useCosign.ts", "utf8");
    expect(hook).toContain("setConsentRequest(passportId, terms)");
    const sign = hook.slice(hook.indexOf("const sendRegister"), hook.indexOf("const stillClear"));
    expect(sign.indexOf("confirmRegister(")).toBeLessThan(sign.indexOf('terms: { at: "waiting" }'));
    expect(hook).toContain('current.send.at !== "registered"');
  });
});

describe("P10: a top-level page that says two public facts to its opener and hears nothing", () => {
  it("posts once to each origin the listing names, never to *, and drops anything not canonical", () => {
    const posts: [unknown, string][] = [];
    const target = { postMessage: (message: unknown, origin: string) => posts.push([message, origin]) };
    const went = opener.postRegistered(target, ["https://acme.example", "*", "https://acme.example/", "http://acme.example", "https://staging.acme.example", "https://acme.example"], {
      passportId: EXACT,
      txHash: TX,
    });
    expect(went).toEqual(["https://acme.example", "https://staging.acme.example"]);
    expect(posts).toEqual([
      [{ type: "moolam:registered", passportId: EXACT, txHash: TX }, "https://acme.example"],
      [{ type: "moolam:registered", passportId: EXACT, txHash: TX }, "https://staging.acme.example"],
    ]);
    expect(posts.some(([, origin]) => origin === "*")).toBe(false);
  });

  it("tells nobody when there is no opener or the platform is not listed", () => {
    const target = { postMessage: vi.fn() };
    expect(opener.postRegistered(null, ["https://acme.example"], { passportId: EXACT, txHash: TX })).toEqual([]);
    expect(opener.postRegistered(target, [], { passportId: EXACT, txHash: TX })).toEqual([]);
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it("never listens for a message: no file behind either page reads postMessage", () => {
    const files = [
      "lib/cosign/useCosign.ts",
      "lib/cosign/opener.ts",
      "lib/cosign/flow.ts",
      "components/cosign/CosignSheet.tsx",
      "components/cosign/CosignScreen.tsx",
      "components/cosign/CosignLive.tsx",
      "components/connect/ConnectPanel.tsx",
      "components/connect/ConnectLive.tsx",
      "components/connect/ConnectScreen.tsx",
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/addEventListener\(\s*["']message["']|onmessage|useEffectEvent\(.*message/);
    }
  });

  it("answers both routes with the frame refused and no referrer", async () => {
    const rules = await (config.headers as () => Promise<{ source: string; headers: { key: string; value: string }[] }[]>)();
    for (const source of ["/:locale/cosign", "/:locale/connect"]) {
      const rule = rules.find((entry) => entry.source === source);
      expect(rule, source).toBeDefined();
      const sent = Object.fromEntries((rule?.headers ?? []).map((header) => [header.key, header.value]));
      expect(sent["x-frame-options"]).toBe("DENY");
      expect(sent["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(sent["referrer-policy"]).toBe("no-referrer");
    }
    // Later rules win for a shared key, so the route rules must come after the site-wide one.
    expect(rules.findIndex((entry) => entry.source === "/:path*")).toBe(0);
  });
});

describe("the two pages stay out of search", () => {
  it("are closed in robots.txt", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(["/*/cosign", "/*/connect"]));
  });

  it("are absent from the sitemap", () => {
    expect(pagePaths().some((path) => path.includes("cosign") || path.includes("connect"))).toBe(false);
  });

  it("ask not to be indexed", async () => {
    const meta = await cosignPage.generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    const connect = readFileSync("app/[locale]/connect/page.tsx", "utf8");
    expect(connect).toContain("robots: { index: false, follow: false }");
  });
});

describe("P14 and P16: two names, two trust levels, and a badge only while the agent's owner is unchanged", () => {
  it("lists the platform for its agent only while its entry is current", () => {
    const list = { ok: true as const, platforms: [platform({ validTo: 1_785_000_000n }), platform({ name: "Acme Studio", validFrom: 1_785_000_000n })] };
    expect(listingFor(list, 4242n)?.validTo).toBeNull();
    expect(listingFor(list, 7n)).toBeNull();
    expect(listingFor({ ok: false, platforms: [], reason: "refused" }, 4242n)).toBeNull();
  });

  it("names the listed platform when ownerOf now is the owner at onboarding", async () => {
    stub.list = { ok: true, platforms: [platform()] };
    const facts = await cosignAgentFacts("4242");
    expect(facts).toMatchObject({
      name: "Totally Real Corp",
      owner: OWNER_AT_ONBOARDING,
      listing: { name: "Acme Studio", origins: ["https://acme.example", "https://staging.acme.example"], badge: true },
    });

    const markup = render(model([{ type: "binding", status: "bound" }]), facts);
    expect(markup).toContain(en.cosign.clauses.platform.listed);
    expect(markup).toContain("Acme Studio");
    expect(markup).toContain("“Totally Real Corp”");
    expect(markup).toContain(en.cosign.clauses.agent.label);
    expect(markup).toContain(en.cosign.agent.unchecked);
    expect(markup).toContain("Agent 4242");
    expect(markup).toContain("owner 0xa374…9AFB");
  });

  it("withholds the badge and the name when the agent changed hands after onboarding", async () => {
    stub.list = { ok: true, platforms: [platform()] };
    stub.owner = "0x9999999999999999999999999999999999999999";
    const facts = await cosignAgentFacts("4242");
    expect(facts?.listing).toMatchObject({ badge: false });

    const markup = render(model([{ type: "binding", status: "bound" }]), facts);
    expect(markup).toContain(en.cosign.clauses.platform.withheld);
    expect(markup).toContain(en.cosign.platform.withheldName);
    expect(markup).not.toContain("Acme Studio");
    expect(markup).toContain("“Totally Real Corp”");
  });

  it("never takes the platform's name from the record the service sent", () => {
    const markup = render(model([{ type: "binding", status: "bound" }]), {
      agentId: "4242",
      name: null,
      owner: OWNER_AT_ONBOARDING,
      listing: null,
      field: [],
    });
    expect(RECORD.platform.name).toBe("Acme Studio");
    expect(markup).not.toContain("Acme Studio");
    expect(markup).toContain(en.cosign.platform.unlistedName);
    expect(markup).toContain(en.cosign.agent.noName);
  });

  it("refuses an agent id that is not a bounded decimal before any read", async () => {
    stub.list = { ok: true, platforms: [platform()] };
    for (const bad of ["", "0", "-1", "12a", "1".repeat(79), "0x10"]) {
      expect(await cosignAgentFacts(bad), bad).toBeNull();
    }
  });
});

describe("WO-253: the stage's outline word sits whole in its column in every language", () => {
  it("keeps a word that fits at full size and shrinks a longer one to the column", async () => {
    const { outlineFit } = await import("@/components/cosign/CosignSheet");
    expect(outlineFit(520, 624)).toBe(1);
    expect(outlineFit(1476, 624)).toBeCloseTo(624 / 1476, 6);
    // Nothing measured yet, or a zero-width column, never collapses the word.
    expect(outlineFit(0, 624)).toBe(1);
    expect(outlineFit(1476, 0)).toBe(1);
  });

  it("gives the tight poster tracking to Latin words only", async () => {
    const { tracksTight } = await import("@/components/cosign/CosignSheet");
    const messages = ["en", "de", "es", "fr", "pt", "hi", "ta", "ja", "ko", "zh"].map(
      (lang) => [lang, JSON.parse(readFileSync(`messages/${lang}.json`, "utf8")).cosign.outline as string] as const,
    );
    for (const [lang, word] of messages) {
      expect(tracksTight(word), lang).toBe(["en", "de", "es", "fr", "pt"].includes(lang));
    }
  });

  it("draws English at its old size and waits, unseen, for the measure", () => {
    const markup = render(model([]));
    const word = /<p aria-hidden="true" data-outline-word="true" style="([^"]*)" class="([^"]*)">([^<]*)<\/p>/.exec(markup);
    expect(word?.[3]).toBe(en.cosign.outline);
    expect(word?.[1]).toBe("font-size:calc(22cqw * 1);inset-inline-start:calc(-3cqw * 1)");
    expect(word?.[2].split(" ")).toEqual(expect.arrayContaining(["tracking-[-0.07em]", "opacity-0", "motion-reduce:transition-none"]));
  });
});
