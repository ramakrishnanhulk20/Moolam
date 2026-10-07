import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoosePanel } from "@/components/result/choose-panel";
import { REFUSAL_WORDS, postClaim, postForget, postRemember, readRemembered } from "@/components/result/picture-api";
import { RememberAddressView } from "@/components/result/remember-address";

const ID = "0123456789abcdef0123456789abcdef";
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const noop = () => {};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
}

function panel(remembered: string | null): string {
  return text(
    renderToStaticMarkup(
      createElement(ChoosePanel, {
        id: ID,
        prompt: "a fox reading by lamplight",
        moolamSite: "https://moolam.site",
        remembered,
        onRemembered: noop,
        onCosignOpened: noop,
        onClaimSnag: noop,
        onChanged: noop,
      }),
    ),
  );
}

describe("the offer after a claim", () => {
  it("offers to send future pictures straight to the Moolam account, unticked", () => {
    const markup = renderToStaticMarkup(
      createElement(RememberAddressView, { boxId: "b", address: ADDRESS, on: false, saving: false, problem: null, onToggle: noop }),
    );
    expect(text(markup)).toContain("Send my future pictures straight to my Moolam account");
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain("checked");
    expect(text(markup)).not.toContain("Forget my address");
  });

  it("once ticked, shows the whole address with a Forget my address link", () => {
    const markup = renderToStaticMarkup(
      createElement(RememberAddressView, { boxId: "b", address: ADDRESS, on: true, saving: false, problem: null, onToggle: noop }),
    );
    expect(markup).toContain('checked=""');
    expect(text(markup)).toContain(`Sending to ${ADDRESS}`);
    expect(text(markup)).toContain("Forget my address");
  });
});

describe("the passport step with a remembered address", () => {
  it("keeps Sign it as the creator as the main button and makes the second one put it in the account, naming the address", () => {
    const with_ = panel(ADDRESS);
    expect(with_).toContain("Sign it as the creator");
    expect(with_).toContain("Put it in my Moolam account");
    expect(with_).toContain(`hands the passport straight to ${ADDRESS}`);
    expect(with_).toContain("Forget my address");
    expect(with_).not.toContain("Let Dreamloom hold it for me");
    expect(with_.indexOf("Sign it as the creator")).toBeLessThan(with_.indexOf("Put it in my Moolam account"));
  });

  it("offers the usual hold when nothing is remembered", () => {
    const without = panel(null);
    expect(without).toContain("Sign it as the creator");
    expect(without).toContain("Let Dreamloom hold it for me");
    expect(without).not.toContain("Put it in my Moolam account");
    expect(without).not.toContain("0x");
  });
});

describe("the requests behind remembering", () => {
  function recorder(status: number, body: unknown) {
    const sent: { url: string; method: string; body: unknown }[] = [];
    const send = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return Response.json(body, { status });
    }) as typeof fetch;
    return { sent, send };
  }

  it("sends the address in the body, never the URL, and forgets with a DELETE", async () => {
    const r = recorder(200, { address: ADDRESS });
    expect(await postRemember(ADDRESS, r.send)).toEqual({ ok: true, value: { address: ADDRESS } });
    const f = recorder(200, { address: null });
    expect(await postForget(f.send)).toEqual({ ok: true, value: { address: null } });
    expect(r.sent).toEqual([{ url: "/api/session/address", method: "POST", body: { address: ADDRESS } }]);
    expect(f.sent).toEqual([{ url: "/api/session/address", method: "DELETE", body: undefined }]);
    for (const { url } of [...r.sent, ...f.sent]) expect(url).not.toContain("0x");
  });

  it("asks for the claim on the register route, with the terms and the title", async () => {
    const r = recorder(429, { error: "limit", scope: "day" });
    const answer = await postClaim(ID, "open", "A fox", r.send);
    expect(r.sent).toEqual([{ url: `/api/pictures/${ID}/register`, method: "POST", body: { terms: "open", title: "A fox", claim: true } }]);
    expect(answer).toEqual({ ok: false, refusal: { words: REFUSAL_WORDS.limit.claim, reload: false } });
    expect(REFUSAL_WORDS.limit.claim).toMatch(/nothing was registered/);
  });

  it("reads the remembered address, and reads any failure or odd answer as none", async () => {
    expect(await readRemembered(recorder(200, { address: ADDRESS }).send)).toBe(ADDRESS);
    expect(await readRemembered(recorder(200, { address: null }).send)).toBeNull();
    expect(await readRemembered(recorder(200, { address: "<b>0x12</b>" }).send)).toBeNull();
    expect(await readRemembered(recorder(503, { error: "busy" }).send)).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await readRemembered(down)).toBeNull();
  });
});
