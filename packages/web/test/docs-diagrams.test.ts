// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { navPages } from "@/lib/docs/nav";
import { readPage } from "@/lib/docs/pages";

function fencesIn(body: string): string[] {
  return [...body.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((hit) => hit[1]);
}

const drawings = navPages().flatMap((page) => {
  const body = readPage(page.slug)?.body ?? "";
  return fencesIn(body).map((source, index) => ({ where: `${page.slug} #${index + 1}`, source }));
});

describe("the architecture diagrams", () => {
  it("are the three the page promises", () => {
    expect(drawings.map((drawing) => drawing.where)).toEqual([
      "developers/architecture #1",
      "developers/architecture #2",
      "developers/architecture #3",
    ]);
  });

  it("are all valid mermaid, so the browser can draw every one of them", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
    for (const drawing of drawings) {
      await expect(mermaid.parse(drawing.source), drawing.where).resolves.toBeTruthy();
    }
  });
});
