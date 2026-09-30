import { describe, expect, it } from "vitest";
import { createGalleryReader, gatewayAddress, passportUrl, type GallerySettings } from "@/lib/gallery";

const INDEX = "https://index.example/v1/graphql";
const GATEWAY = "https://gateway.example/ipfs/";
const SITE = "https://moolam.vercel.app";
const ID_A = `0x${"a1".repeat(32)}`;
const ID_B = `0x${"b2".repeat(32)}`;

function row(id: string, metadata: string) {
  return { id, registeredAt: "1790523930", metadataURI: `ipfs://${metadata}` };
}

/** A stand-in for the network that answers the index and the gateway and counts every request. */
function network(index: () => Promise<Response>) {
  const calls = { index: 0, documents: 0 };
  const send = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === INDEX) {
      calls.index += 1;
      return await index();
    }
    calls.documents += 1;
    const cid = url.slice(GATEWAY.length);
    return Response.json({ name: `Picture ${cid}`, prompt: `A dream about ${cid}`, thumbnail: `ipfs://thumb${cid}` });
  }) as typeof fetch;
  return { calls, send };
}

function settings(send: typeof fetch, clock: { at: number }): GallerySettings {
  return { indexUrl: INDEX, agentId: "10249", siteUrl: SITE, gateway: GATEWAY, send, now: () => clock.at };
}

const twoPictures = async () =>
  Response.json({ data: { Passport: [row(ID_A, "bafkreidocumentaaaa"), row(ID_B, "bafkreidocumentbbbb")] } });

describe("the gallery read", () => {
  it("makes one index request for many callers at once and holds the answer for 60 seconds", async () => {
    const clock = { at: 1_000_000 };
    const { calls, send } = network(twoPictures);
    const read = createGalleryReader(settings(send, clock));

    const answers = await Promise.all(Array.from({ length: 25 }, () => read()));
    expect(calls.index).toBe(1);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0].state).toBe("ready");

    clock.at += 59_999;
    await read();
    await read();
    expect(calls.index).toBe(1);

    clock.at += 1;
    await read();
    expect(calls.index).toBe(2);
  });

  it("reads each pinned document once, since a pinned document never changes", async () => {
    const clock = { at: 0 };
    const { calls, send } = network(twoPictures);
    const read = createGalleryReader(settings(send, clock));
    await read();
    clock.at += 60_000;
    await read();
    expect(calls.index).toBe(2);
    expect(calls.documents).toBe(2);
  });

  it("gives each picture its image through the gateway and its badge link from the passport id", async () => {
    const { send } = network(twoPictures);
    const answer = await createGalleryReader(settings(send, { at: 0 }))();
    if (answer.state !== "ready") {
      throw new Error("expected a ready gallery");
    }
    expect(answer.pictures.map((picture) => picture.passportId)).toEqual([ID_A, ID_B]);
    expect(answer.pictures[0].imageUrl).toBe(`${GATEWAY}thumbbafkreidocumentaaaa`);
    expect(answer.pictures[0].prompt).toBe("A dream about bafkreidocumentaaaa");
    expect(answer.pictures[0].passportUrl).toBe(`${SITE}/en/passport/${ID_A}`);
  });

  it("tells a picture its creator kept private from one whose document could not be read", async () => {
    const send = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === INDEX) {
        return await twoPictures();
      }
      return url.endsWith("aaaa")
        ? Response.json({ name: "Sealed", sealed: true })
        : new Response("gone", { status: 504 });
    }) as typeof fetch;
    const answer = await createGalleryReader(settings(send, { at: 0 }))();
    if (answer.state !== "ready") {
      throw new Error("expected a ready gallery");
    }
    expect(answer.pictures[0]).toMatchObject({ imageUrl: null, unpublished: true });
    expect(answer.pictures[1]).toMatchObject({ imageUrl: null, unpublished: false });
  });
});

describe("an index that does not answer", () => {
  const failures: [string, () => Promise<Response>][] = [
    ["a dropped connection", async () => await Promise.reject(new TypeError("fetch failed"))],
    ["a server error", async () => new Response("down", { status: 502 })],
    ["a rate limit", async () => new Response("slow down", { status: 429 })],
    ["a GraphQL error", async () => Response.json({ errors: [{ message: "throttled" }] })],
    ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
  ];

  for (const [name, answer] of failures) {
    it(`gives the unavailable state for ${name}, never an empty list`, async () => {
      const { send } = network(answer);
      const result = await createGalleryReader(settings(send, { at: 0 }))();
      expect(result.state).toBe("unavailable");
      expect(result).not.toHaveProperty("pictures");
    });
  }

  it("is not asked again inside the minute, so a failure never becomes a retry loop", async () => {
    const clock = { at: 0 };
    const { calls, send } = network(async () => new Response("down", { status: 503 }));
    const read = createGalleryReader(settings(send, clock));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await read()).state).toBe("unavailable");
    }
    expect(calls.index).toBe(1);
    clock.at += 60_000;
    await read();
    expect(calls.index).toBe(2);
  });

  it("is unavailable, not empty, when the index address or agent id is missing", async () => {
    const { calls, send } = network(twoPictures);
    const noIndex = await createGalleryReader({ ...settings(send, { at: 0 }), indexUrl: undefined })();
    const noAgent = await createGalleryReader({ ...settings(send, { at: 0 }), agentId: "" })();
    expect(noIndex.state).toBe("unavailable");
    expect(noAgent.state).toBe("unavailable");
    expect(calls.index).toBe(0);
  });

  it("says ready with no pictures only when the index answered with none", async () => {
    const { send } = network(async () => Response.json({ data: { Passport: [] } }));
    const answer = await createGalleryReader(settings(send, { at: 0 }))();
    expect(answer).toMatchObject({ state: "ready", pictures: [] });
  });
});

describe("the badge link", () => {
  it("is built from the passport id on Moolam's English passport page", () => {
    expect(passportUrl(ID_A, SITE)).toBe(`https://moolam.vercel.app/en/passport/${ID_A}`);
    expect(passportUrl(ID_A.toUpperCase().replace("0X", "0x"), `${SITE}/`)).toBe(`${SITE}/en/passport/${ID_A}`);
  });

  it("refuses anything that is not a passport id", () => {
    expect(() => passportUrl("0x1234", SITE)).toThrow();
    expect(() => passportUrl(`../../evil?${ID_A}`, SITE)).toThrow();
  });

  it("drops a row whose id is not a passport id instead of linking it", async () => {
    const { send } = network(async () =>
      Response.json({
        data: { Passport: [row("javascript:alert(1)", "bafkreidocumentaaaa"), row(ID_B, "bafkreidocumentbbbb")] },
      }),
    );
    const answer = await createGalleryReader(settings(send, { at: 0 }))();
    expect(answer.state === "ready" && answer.pictures.map((picture) => picture.passportId)).toEqual([ID_B]);
  });
});

describe("picture addresses", () => {
  it("reads only ipfs addresses, through the gateway", () => {
    expect(gatewayAddress("ipfs://bafkreiexample1234", GATEWAY)).toBe(`${GATEWAY}bafkreiexample1234`);
    expect(gatewayAddress("https://tracker.example/pixel.png", GATEWAY)).toBeNull();
    expect(gatewayAddress("ipfs://bafkreiexample1234?x=1", GATEWAY)).toBeNull();
    expect(gatewayAddress(undefined, GATEWAY)).toBeNull();
  });
});
