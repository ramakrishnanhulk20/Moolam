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

// The page's children are its server drawn intro, the wallet SDK and the studio
// itself. None of them is under test here: what is under test is the prop the
// page hands over.
vi.mock("@/components/providers/WalletProvider", () => ({
  WalletProvider: (props: { children?: unknown }) => createElement("div", null, props.children as never),
}));

vi.mock("@/components/studio/StudioScreen", () => ({
  StudioScreen: () => null,
}));

// The passport beside the sign-in card is a registry read and a drawing, and
// neither is under test.
vi.mock("@/components/studio/showcasePassport", () => ({ showcasePassport: async () => null }));
vi.mock("@/components/studio/Showcase", () => ({ Showcase: () => null }));

const { default: StudioPage } = await import("@/app/[locale]/studio/page");
const { StudioScreen } = await import("@/components/studio/StudioScreen");

/** The studio screen's element, wherever the page's frame puts it. */
function screenIn(node: unknown): ReactElement<{ initialMode?: string }> | undefined {
  if (Array.isArray(node)) {
    return node.map(screenIn).find((found) => found !== undefined);
  }
  if (node === null || typeof node !== "object" || !("props" in node)) {
    return undefined;
  }
  const element = node as ReactElement<{ children?: unknown; initialMode?: string }>;
  return element.type === StudioScreen ? element : screenIn(element.props.children);
}

async function openedOn(asked?: string | string[]): Promise<string | undefined> {
  const tree = await StudioPage({
    params: Promise.resolve({ locale: "en" }),
    searchParams: asked === undefined ? undefined : Promise.resolve({ mode: asked }),
  });

  const screen = screenIn(tree);
  expect(screen, "the page should hand the studio screen over").toBeDefined();
  return screen?.props.initialMode;
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
