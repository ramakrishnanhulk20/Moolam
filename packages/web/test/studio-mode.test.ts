import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";

/**
 * The link that opens the studio on the generate panel.
 *
 * The first screen's primary button points at /studio?mode=generate, so the
 * word in the URL has to survive the whole way to the panel the creator lands
 * on, and anything else in that parameter has to leave the studio exactly where
 * it has always opened.
 */

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (key: string) => key,
}));

// The page's two children are the wallet SDK and the studio itself. Neither is
// under test here: what is under test is the prop the page hands over.
vi.mock("@/components/providers/WalletProvider", () => ({
  WalletProvider: (props: { children?: unknown }) => createElement("div", null, props.children as never),
}));

vi.mock("@/components/studio/StudioScreen", () => ({
  StudioScreen: () => null,
}));

const { default: StudioPage } = await import("@/app/[locale]/studio/page");

async function openedOn(asked?: string | string[]): Promise<string | undefined> {
  const tree = (await StudioPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: asked === undefined ? undefined : Promise.resolve({ mode: asked }),
  })) as ReactElement<{ children: ReactElement<{ initialMode?: string }> }>;

  return tree.props.children.props.initialMode;
}

describe("which panel the studio opens on", () => {
  it("opens on the generate panel when the link said so", async () => {
    expect(await openedOn("generate")).toBe("generate");
  });

  it("opens on the upload panel when the link said register", async () => {
    expect(await openedOn("register")).toBe("upload");
  });

  it("ignores a word it does not know", async () => {
    expect(await openedOn("sideways")).toBe("upload");
  });

  it("ignores the parameter written twice", async () => {
    expect(await openedOn(["generate", "register"])).toBe("upload");
  });

  it("opens where it always opened when nothing was asked for", async () => {
    expect(await openedOn()).toBe("upload");
  });
});
