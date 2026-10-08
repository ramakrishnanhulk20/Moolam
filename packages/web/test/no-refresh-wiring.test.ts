import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * How the screens are wired so a result shows without pressing refresh (WO-332).
 *
 * Most of this reads the source, because the pieces involved (the co-sign flow,
 * the edit flow, the unseal panel) live behind a wallet that a node test cannot
 * sign with. The behaviour of the held reads, the publish step and the claims
 * confirm is tested by running them in disputes-held.test.ts and
 * no-refresh-hooks.test.ts.
 * Does NOT cover a real browser holding a prefetched page, or a real Vercel build.
 */

const read = (path: string) => readFileSync(path, "utf8");

/** Every opening <Link ...> tag in a file whose text holds the given piece. */
function links(path: string, piece: string): string[] {
  return (read(path).match(/<Link\b[^>]*>/g) ?? []).filter((tag) => tag.includes(piece));
}

/** The text between two markers, which must both be there and in this order. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  expect(start, `"${from}" is in the file`).toBeGreaterThanOrEqual(0);
  expect(end, `"${to}" follows it`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the co-sign flow expires the passport's page", () => {
  const hook = read("lib/cosign/useCosign.ts");

  it("right after the register is confirmed, before the screen says registered", () => {
    const landed = between(hook, "const confirmLanded", "A passport the chain already holds");
    const receipt = landed.indexOf("confirmedRegistration(");
    const refresh = landed.indexOf("void refreshPassport(passportId).catch(() => undefined);");
    const said = landed.indexOf('send: { at: "registered"');
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(receipt);
    expect(said).toBeGreaterThan(refresh);
  });

  it("right after the terms are written, before the screen says written", () => {
    const terms = between(hook, "const writeTerms", "if (auto.terms) void writeTerms()");
    const receipt = terms.indexOf("confirmedConsent(");
    const refresh = terms.indexOf("void refreshPassport(passportId).catch(() => undefined);");
    const said = terms.indexOf('terms: { at: "written"');
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(receipt);
    expect(said).toBeGreaterThan(refresh);
  });

  it("calls it nowhere else, so a pressed button or a poll never expires a page", () => {
    expect(hook.match(/refreshPassport\(/g)).toHaveLength(2);
  });
});

describe("the edit flow tells the grid about the new picture", () => {
  it("once the edit is confirmed, before the screen says confirmed", () => {
    const hook = read("lib/passport/useEditPassport.ts");
    const finish = between(hook, "const finish", "const submit");
    const receipt = finish.indexOf("confirmEdit(");
    const told = finish.indexOf("awaitPassport(wallet, out.childId);");
    const said = finish.indexOf('type: "confirmed"');
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(told).toBeGreaterThan(receipt);
    expect(said).toBeGreaterThan(told);
  });
});

describe("show the picture", () => {
  it("expires the sealed page first and only then asks for the page again", () => {
    const source = read("components/passport/Unsealer.tsx");
    expect(source).toContain(
      "showPicture: () => void refreshPassport(passportId).catch(() => undefined).then(() => router.refresh()),",
    );
    expect(source).not.toContain("showPicture: () => router.refresh()");
  });
});

describe("links to a page that has just been written are not prefetched", () => {
  const cases: [string, string, number][] = [
    ["components/resolve/ResolveConsole.tsx", "#decision", 1],
    ["components/cosign/StateParts.tsx", "href={primaryHref}", 1],
    ["components/cosign/CosignCheckout.tsx", "/passport/${passportId}", 1],
    ["components/mine/HeldPictures.tsx", "/passport/${row.id}", 1],
    ["components/mine/ConfirmedPictures.tsx", "/passport/${row.id}", 1],
    ["components/studio/DoneActions.tsx", "/agent/${drawn.agent.id}", 1],
    ["components/passport/Editor.tsx", "/passport/${child}", 2],
    ["components/studio/Receipt.tsx", "/passport/${id}", 1],
  ];

  it.each(cases)("%s: every link carrying %s says prefetch={false}", (path, piece, expected) => {
    const found = links(path, piece);
    expect(found).toHaveLength(expected);
    for (const tag of found) {
      expect(tag).toContain("prefetch={false}");
    }
  });
});

describe("how long a page is kept", () => {
  it("lets the browser keep a prefetched page for 30 seconds, the least Next allows", async () => {
    const { default: config } = await import("@/next.config");

    expect(config.experimental?.staleTimes?.static).toBe(30);
  });

  it("builds the agent page again every minute, as the passport page is", () => {
    expect(read("app/[locale]/agent/[id]/page.tsx")).toMatch(/^export const revalidate = 60;$/m);
  });
});
