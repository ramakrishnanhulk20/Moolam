import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import en from "@/messages/en.json";

/**
 * P2 and P4 on the co-sign page. A second wallet is refused and still sees
 * which picture and which agent it was sent; the handle is read from the
 * fragment alone, goes to the verify service in the path and nowhere else,
 * and never reaches the analytics beacons.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("@/components/passport/Picture", () => ({
  Picture: () => createElement("span", { "data-picture": true }),
}));

const record = await import("@/lib/cosign/record");
const handle = await import("@/lib/cosign/handle");
const flow = await import("@/lib/cosign/flow");
const { CosignSheet } = await import("@/components/cosign/CosignSheet");
const { publicEnv } = await import("@/lib/env");
type CosignModel = import("@/lib/cosign/flow").CosignModel;

const HANDLE = "0123456789abcdef0123456789abcdef";
const TOKEN = "privy-token-for-this-test";
const EXACT = `0x${"7a".repeat(32)}` as Hex;
const WALLET = "0xc3714B31A5F300D7A79f72C7AEC61240D2f384E7" as Hex;
const NAMED = { error: "creator-mismatch", agentId: "4242", platform: { name: "Acme Studio", agentId: "4242" }, exactHash: EXACT };

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function render(model: CosignModel, agent: import("@/lib/cosign/listing").AgentFacts | null = null): string {
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{ locale: string; messages: unknown; timeZone: string }>;
  return renderToStaticMarkup(
    createElement(
      Provider,
      { locale: "en", messages: en, timeZone: "UTC" },
      createElement(CosignSheet, { model, agent, wallet: WALLET, onPress: () => undefined }),
    ),
  );
}

function signedIn(): CosignModel {
  let model = flow.cosignReducer(flow.initialCosign, { type: "handle", valid: true });
  model = flow.cosignReducer(model, { type: "auth", signedIn: true });
  return flow.cosignReducer(model, { type: "opening" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every refusal from the record routes is a named state", () => {
  it.each([
    [401, { error: "unauthorized" }, "signIn"],
    [403, NAMED, "wrongWallet"],
    [404, { error: "not-found" }, "notFound"],
    [410, { ...NAMED, error: "expired" }, "expired"],
    [409, { error: "record-refused" }, "refused"],
    [503, { error: "chain-unreachable" }, "unavailable"],
    [502, { error: "wallet-lookup-failed" }, "unavailable"],
  ])("%i reads as %s", async (status, body, kind) => {
    expect((await record.outcomeOf(answer(status, body))).kind).toBe(kind);
  });

  it("refuses a 200 whose body is not a record rather than half reading it", async () => {
    expect(await record.outcomeOf(answer(200, { state: "signed" }))).toEqual({ kind: "refused" });
  });

  it("maps each outcome to the state the lab drew", () => {
    const views = {
      signIn: "signIn",
      wrongWallet: "wrongWallet",
      notFound: "notFound",
      expired: "expired",
      refused: "failed",
      unavailable: "failed",
    } as const;
    for (const [kind, view] of Object.entries(views)) {
      const outcome = (kind === "wrongWallet" || kind === "expired" ? { kind, named: null } : { kind }) as import("@/lib/cosign/record").RecordOutcome;
      expect(flow.cosignReducer(signedIn(), { type: "answer", outcome }).view, kind).toBe(view);
    }
  });
});

describe("P2: a second wallet is refused, and still sees what it was sent", () => {
  it("draws the wrong-wallet state with the picture and the agent named from the refusal", async () => {
    const outcome = await record.outcomeOf(answer(403, NAMED));
    expect(outcome).toEqual({ kind: "wrongWallet", named: { agentId: "4242", platform: { name: "Acme Studio", agentId: "4242" }, exactHash: EXACT } });

    const model = flow.cosignReducer(signedIn(), { type: "answer", outcome });
    expect(model.view).toBe("wrongWallet");
    expect(flow.canSign(model)).toBe(false);
    expect(flow.pressFor(model, "secondary")).toBe("signOut");
    expect(flow.pressFor(model, "primary")).toBeNull();

    const markup = render(model, {
      agentId: "4242",
      name: "Totally Real Corp",
      owner: "0xa374000000000000000000000000000000009AFb" as Hex,
      listing: null,
      field: [],
    });
    expect(markup).toContain(`sha256 ${EXACT}`);
    expect(markup).toContain("Agent 4242");
    expect(markup).toContain("“Totally Real Corp”");
    expect(markup).toContain(en.cosign.states.wrongWallet.headline);
    expect(markup).toContain(en.cosign.clauses.creator.other);
    expect(markup).toContain("0xc371…84E7");
    expect(markup).not.toContain('data-press="sign"');
    expect(markup).toContain('data-press="signOut"');
  });
});

describe("P4: the handle is a capability read from the fragment only", () => {
  it("takes 32 lowercase hex characters in the fragment and nothing else", () => {
    expect(handle.handleFrom(`#${HANDLE}`)).toBe(HANDLE);
    expect(handle.handleFrom(HANDLE)).toBe(HANDLE);
    expect(handle.handleFrom(`#${HANDLE.toUpperCase()}`)).toBeNull();
    expect(handle.handleFrom(`#${HANDLE}0`)).toBeNull();
    expect(handle.handleFrom(`#${HANDLE}&x=1`)).toBeNull();
    expect(handle.handleFrom("")).toBeNull();
  });

  it("never reads a handle from the path or the query string", () => {
    vi.stubGlobal("window", {
      location: { hash: "", pathname: `/en/cosign/${HANDLE}`, search: `?handle=${HANDLE}`, href: `https://moolam.vercel.app/en/cosign/${HANDLE}?handle=${HANDLE}` },
    });
    expect(handle.readHandle()).toBeNull();
    vi.stubGlobal("window", { location: { hash: `#${HANDLE}`, pathname: "/en/cosign", search: "" } });
    expect(handle.readHandle()).toBe(HANDLE);
  });

  it("the page takes no handle from the server: no params beyond the locale, no search params", () => {
    const page = readFileSync("app/[locale]/cosign/page.tsx", "utf8");
    expect(page).not.toMatch(/searchParams/);
    expect(page).not.toMatch(/\[handle\]/);
    expect(page).toContain("params: Promise<{ locale: string }>");
  });

  it("sends the handle in the path and the token only in the Authorization header", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return answer(404, { error: "not-found" });
    });

    await record.openRecord(HANDLE, TOKEN, fetcher);
    await record.recordStatus(HANDLE, TOKEN, fetcher);

    const base = publicEnv.verifierUrl.replace(/\/+$/, "");
    expect(seen.map((call) => call.url)).toEqual([`${base}/platform/record/${HANDLE}`, `${base}/platform/status/${HANDLE}`]);
    for (const call of seen) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect(call.init.referrerPolicy).toBe("no-referrer");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.body).toBeUndefined();
    }
    expect([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]).toEqual([]);
  });

  it("carries no handle in any outcome, even a network failure", async () => {
    const outcome = await record.openRecord(HANDLE, TOKEN, async () => {
      throw new Error(`fetch to /platform/record/${HANDLE} failed`);
    });
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(outcome)).not.toContain(HANDLE);
  });

  it("strips the fragment from every address the analytics beacons are given", () => {
    const page = { type: "pageview" as const, url: `https://moolam.vercel.app/en/cosign#${HANDLE}` };
    expect(handle.stripFragment(page)).toEqual({ type: "pageview", url: "https://moolam.vercel.app/en/cosign" });
    const vital = { type: "LCP", url: `https://moolam.vercel.app/ta/cosign#${HANDLE}`, route: "/[locale]/cosign" };
    expect(handle.stripFragment(vital)).toEqual({ type: "LCP", url: "https://moolam.vercel.app/ta/cosign", route: "/[locale]/cosign" });
    expect(handle.withoutFragment(`not a url#${HANDLE}`)).toBe("not a url");
    expect(handle.stripFragment({ url: "https://moolam.vercel.app/en/explore?q=1" }).url).toBe(
      "https://moolam.vercel.app/en/explore?q=1",
    );
  });

  it("hands that beforeSend to both Vercel's counter and Speed Insights", () => {
    const late = readFileSync("components/shell/LateInsights.tsx", "utf8");
    expect(late).toContain('import { stripFragment } from "@/lib/cosign/handle";');
    expect(late).toContain("<Part key={at} beforeSend={stripFragment} />");
    expect(late).toContain("setParts([analytics.Analytics, speed.SpeedInsights]);");
  });
});
