import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import type { Hex } from "viem";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { ZERO_ID } from "@/lib/chain/registry";

/**
 * The link up to the picture this one was edited from is where a reader finds
 * out the picture was proven fake. The mark on that link is the only place the
 * page can say it, because the chain never wrote it on this record.
 */

const locale = { current: "en" as "en" | "ta" };

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: locale.current, messages: locale.current === "en" ? en : ta, namespace }),
}));

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));

const { Lineage } = await import("@/components/passport/Lineage");

const PARENT = `0x${"7e".repeat(32)}` as Hex;

async function lineage(props: { parentId: Hex; parentDisputed?: boolean }, language: "en" | "ta" = "en") {
  locale.current = language;
  return renderToStaticMarkup(await Lineage({ edits: [], ...props }));
}

describe("the mark on the line up to the parent", () => {
  it("says the picture above was disputed, in the reader's own language", async () => {
    expect(await lineage({ parentId: PARENT, parentDisputed: true })).toContain(en.passport.lineageDisputed);
    expect(await lineage({ parentId: PARENT, parentDisputed: true }, "ta")).toContain(ta.passport.lineageDisputed);
  });

  it("colours the line it sits on with the failed tone, not the accent", async () => {
    const markup = await lineage({ parentId: PARENT, parentDisputed: true });
    expect(markup).toContain("border-failed/50");
    expect(markup).toContain("text-failed");
  });

  it("says nothing at all when the chain above this one is clean", async () => {
    const markup = await lineage({ parentId: PARENT, parentDisputed: false });
    expect(markup).not.toContain(en.passport.lineageDisputed);
    expect(markup).toContain("border-line");
  });

  it("says nothing when the lineage could not be read, so silence is never a verdict", async () => {
    expect(await lineage({ parentId: PARENT })).not.toContain(en.passport.lineageDisputed);
  });

  it("has no line to mark on a picture that was not edited from anything", async () => {
    const markup = await lineage({ parentId: ZERO_ID as Hex, parentDisputed: true });
    expect(markup).not.toContain(en.passport.lineageDisputed);
    expect(markup).not.toContain(`/passport/${ZERO_ID}`);
  });
});
