// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Picture } from "@/components/passport/Picture";
import { isOptimizable, nextSource, optimizedUrl, pictureSources } from "@/lib/images";
import { publicEnv } from "@/lib/env";

/**
 * Where a pinned picture is read from, and what a plate does when it is not
 * served.
 *
 * The account's own Pinata gateway is the only one in the list. Every picture
 * goes through Next's optimizer, which reads the gateway once and serves every
 * later view from its own cache. ipfs.io and dweb.link were here as a fallback
 * until a check on 21 September found both refusing a direct browser fetch, so
 * they only ever cost a plate two failed requests before the seal, and naming
 * them let the optimizer fetch any address on either host for anyone who asked,
 * out of this project's own monthly allowance.
 */

const CID = "bafybeigdyrztktx5b5m2y4sogfjmc6xmpbstrvbwqrwzk6bxrn4qxeqmaa";
const OWN = publicEnv.ipfsGateway.endsWith("/") ? publicEnv.ipfsGateway : `${publicEnv.ipfsGateway}/`;

describe("the gateways one picture can be read from", () => {
  it("is the account's own gateway and nothing else", () => {
    expect(pictureSources(`ipfs://${CID}`)).toEqual([`${OWN}${CID}`]);
  });

  it("carries a stored gateway address through as it stands", () => {
    expect(pictureSources(`${OWN}${CID}`)).toEqual([`${OWN}${CID}`]);
  });

  it("carries the file inside a directory, which a content id alone would drop", () => {
    expect(pictureSources(`ipfs://${CID}/still.jpg`)).toEqual([`${OWN}${CID}/still.jpg`]);
  });

  it("leaves an address that is not on IPFS alone", () => {
    expect(pictureSources("https://example.com/still.jpg")).toEqual(["https://example.com/still.jpg"]);
  });

  it("names no public gateway anywhere in the list", () => {
    for (const uri of [`ipfs://${CID}`, `${OWN}${CID}`, `ipfs://${CID}/still.jpg`]) {
      for (const source of pictureSources(uri)) {
        expect(source, uri).toContain(OWN);
      }
    }
  });

  it("walks the list once and then gives up, which is when the seal is drawn", () => {
    const sources = pictureSources(`ipfs://${CID}`);
    expect(nextSource(sources, sources[0])).toBe(null);
  });
});

describe("what the optimizer is allowed to fetch", () => {
  it("takes the account's own gateway", () => {
    expect(isOptimizable(`${OWN}${CID}`)).toBe(true);
  });

  it("does not take a public gateway, which would serve any content id to anyone", () => {
    expect(isOptimizable(`https://ipfs.io/ipfs/${CID}`)).toBe(false);
    expect(isOptimizable(`https://dweb.link/ipfs/${CID}`)).toBe(false);
  });

  it("does not take a host next.config knows nothing about", () => {
    expect(isOptimizable("https://example.com/still.jpg")).toBe(false);
  });

  it("hands the WebGL plates the optimizer's own address, so a texture is cached like a picture", () => {
    const address = optimizedUrl(`${OWN}${CID}`, 640);
    expect(address.startsWith("/_next/image?url=")).toBe(true);
    expect(decodeURIComponent(address)).toContain(`${OWN}${CID}`);
    expect(address).toContain("w=640");
    expect(address).toContain("q=70");
  });

  it("leaves a foreign host as it stands rather than asking for a 400", () => {
    expect(optimizedUrl("https://example.com/still.jpg", 640)).toBe("https://example.com/still.jpg");
  });
});

describe("a plate whose gateway will not answer", () => {
  it("draws the seal once the last address in the list has errored", async () => {
    const sources = pictureSources(`ipfs://${CID}`);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(Picture, {
          sources,
          sizes: "100vw",
          fallback: createElement("span", { "data-seal": "true" }),
        }),
      );
    });

    const shown = () => {
      const image = host.querySelector("img");
      return image === null ? null : decodeURIComponent(image.getAttribute("src") ?? "");
    };

    expect(shown()).toContain(sources[0]);

    await act(async () => {
      (host.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error"));
    });
    expect(host.querySelector("img")).toBe(null);
    expect(host.querySelector("[data-seal]")).not.toBe(null);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
