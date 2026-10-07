import { readFileSync } from "node:fs";
import path from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repoRoot } from "@/lib/docs/paths";
import { readPage } from "@/lib/docs/pages";
import { INDEX_URL_TOKEN, INDEX_URL_UNSET, renderPage } from "@/lib/docs/render";
import en from "@/messages/en.json";

/**
 * The hosted index address is written once, in one Vercel setting, and the docs
 * fill it in when they are built. These tests read the real GraphQL page and
 * check the endpoint line and the curl example, with the setting present and
 * absent.
 */

vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ push: () => undefined }),
  usePathname: () => "/docs",
}));

const SETTING = "NEXT_PUBLIC_ENVIO_GRAPHQL_URL";
const ADDRESS = "https://index.example.test/zz9f1c2/v1/graphql";
const OLD_HOST = "indexer.dev.hyperindex.xyz";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The text of every code block on the page, as a reader sees it, one string each. */
async function codeBlocks(slug: string): Promise<string[]> {
  const page = readPage(slug);
  const { content } = await renderPage(slug, page?.body ?? "");
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "en", messages: en }, content as ReactElement),
  );
  return [...html.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((hit) =>
    hit[0]
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&"),
  );
}

function endpointBlock(blocks: string[]): string {
  return blocks[0] ?? "";
}

function curlBlock(blocks: string[]): string {
  return blocks.find((block) => block.startsWith("curl")) ?? "";
}

function repoFile(...parts: string[]): string {
  return readFileSync(path.join(repoRoot, ...parts), "utf8");
}

describe("the index address on the GraphQL page", () => {
  it("prints the address the build was given in the endpoint line and in the curl example", async () => {
    vi.stubEnv(SETTING, ADDRESS);
    const blocks = await codeBlocks("api/graphql");
    expect(endpointBlock(blocks).trim()).toBe(ADDRESS);
    expect(curlBlock(blocks)).toContain(`curl -s -X POST ${ADDRESS} \\`);
    for (const block of blocks) {
      expect(block).not.toContain(INDEX_URL_TOKEN);
      expect(block).not.toContain(OLD_HOST);
    }
  });

  it("says the address is set by the deployment when the setting is missing", async () => {
    vi.stubEnv(SETTING, "");
    const blocks = await codeBlocks("api/graphql");
    expect(INDEX_URL_UNSET).toContain("set by the deployment");
    expect(endpointBlock(blocks).trim()).toBe(INDEX_URL_UNSET);
    expect(curlBlock(blocks)).toContain(`curl -s -X POST ${INDEX_URL_UNSET} \\`);
    for (const block of blocks) {
      expect(block).not.toContain(INDEX_URL_TOKEN);
      expect(block).not.toContain(OLD_HOST);
    }
  });

  it("treats a setting that is not a web address as missing, never a broken link", async () => {
    vi.stubEnv(SETTING, "not a url");
    const blocks = await codeBlocks("api/graphql");
    expect(endpointBlock(blocks).trim()).toBe(INDEX_URL_UNSET);
    expect(curlBlock(blocks)).not.toContain("not a url");
  });

  it("follows the setting when it changes, so a rendered page is never served stale", async () => {
    vi.stubEnv(SETTING, ADDRESS);
    const first = await codeBlocks("api/graphql");
    vi.stubEnv(SETTING, "https://index.example.test/second/v1/graphql");
    const second = await codeBlocks("api/graphql");
    expect(endpointBlock(first).trim()).toBe(ADDRESS);
    expect(endpointBlock(second).trim()).toBe("https://index.example.test/second/v1/graphql");
  });

  it("asks the curl example for networkAttestations too", async () => {
    vi.stubEnv(SETTING, ADDRESS);
    const curl = curlBlock(await codeBlocks("api/graphql"));
    expect(curl).toContain("GlobalStats { id passports creators generators attestations networkAttestations disputes");
  });

  it("fills the Envio indexer page the same way", async () => {
    vi.stubEnv(SETTING, ADDRESS);
    const blocks = await codeBlocks("developers/envio-indexer");
    expect(endpointBlock(blocks).trim()).toBe(ADDRESS);
    vi.stubEnv(SETTING, "");
    expect((await codeBlocks("developers/envio-indexer"))[0]?.trim()).toBe(INDEX_URL_UNSET);
  });
});

describe("the markdown on GitHub", () => {
  it("carries no hosted address in the README or the two docs pages", () => {
    for (const file of [
      repoFile("README.md"),
      repoFile("docs", "api", "graphql.md"),
      repoFile("docs", "developers", "envio-indexer.md"),
    ]) {
      expect(file).not.toContain(OLD_HOST);
    }
  });

  it("still reads sensibly around the token: a placeholder, and where the real address is shown", () => {
    const graphql = repoFile("docs", "api", "graphql.md");
    expect(graphql.split(INDEX_URL_TOKEN)).toHaveLength(3);
    expect(graphql).toContain("moolam.site/en/docs/api/graphql");
    expect(repoFile("docs", "developers", "envio-indexer.md")).toContain(
      "moolam.site/en/docs/developers/envio-indexer",
    );
    expect(repoFile("README.md")).toContain("(https://moolam.site/en/docs/api/graphql)");
  });
});
