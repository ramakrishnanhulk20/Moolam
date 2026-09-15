// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Picture } from "@/components/passport/Picture";
import { isOptimizable, nextSource, optimizedUrl, pictureSources } from "@/lib/images";
import { publicEnv } from "@/lib/env";

/**
 * Where a pinned picture is read from, and what happens when the first gateway
 * will not serve it.
 *
 * The account's own Pinata gateway has a monthly request allowance, so every
 * picture goes through Next's optimizer and is read from the gateway once. The
 * other half of that bargain is this: when the gateway is out of requests, or
 * down, the picture has somewhere else to come from.
 */

const CID = "bafybeigdyrztktx5b5m2y4sogfjmc6xmpbstrvbwqrwzk6bxrn4qxeqmaa";
const OWN = publicEnv.ipfsGateway.endsWith("/") ? publicEnv.ipfsGateway : `${publicEnv.ipfsGateway}/`;

describe("the gateways one picture can be read from", () => {
  it("puts the account's own gateway first and the public ones behind it", () => {
    expect(pictureSources(`ipfs://${CID}`)).toEqual([
      `${OWN}${CID}`,
      `https://ipfs.io/ipfs/${CID}`,
      `https://dweb.link/ipfs/${CID}`,
    ]);
  });

  it("reads the content id back out of a gateway address, so a stored http URL falls back too", () => {
    expect(pictureSources(`${OWN}${CID}`)).toEqual([
      `${OWN}${CID}`,
      `https://ipfs.io/ipfs/${CID}`,
      `https://dweb.link/ipfs/${CID}`,
    ]);
  });

  it("carries the file inside a directory, which the content id alone would drop", () => {
    expect(pictureSources(`ipfs://${CID}/still.jpg`)[1]).toBe(`https://ipfs.io/ipfs/${CID}/still.jpg`);
  });

  it("leaves an address that is not on IPFS alone", () => {
    expect(pictureSources("https://example.com/still.jpg")).toEqual(["https://example.com/still.jpg"]);
  });

  it("walks the list once and then gives up, which is when the seal is drawn", () => {
    const sources = pictureSources(`ipfs://${CID}`);
    expect(nextSource(sources, sources[0])).toBe(sources[1]);
    expect(nextSource(sources, sources[1])).toBe(sources[2]);
    expect(nextSource(sources, sources[2])).toBe(null);
  });
});

describe("what the optimizer is allowed to fetch", () => {
  it("takes the gateways in the list", () => {
    expect(isOptimizable(`${OWN}${CID}`)).toBe(true);
    expect(isOptimizable(`https://ipfs.io/ipfs/${CID}`)).toBe(true);
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
  it("swaps to the second gateway when the first one errors, and draws the seal only after the last", async () => {
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

    for (const next of [sources[1], sources[2]]) {
      await act(async () => {
        (host.querySelector("img") as HTMLImageElement).dispatchEvent(new Event("error"));
      });
      expect(shown()).toContain(next);
    }

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
