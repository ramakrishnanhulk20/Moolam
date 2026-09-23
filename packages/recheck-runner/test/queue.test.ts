import { describe, expect, it } from "vitest";
import { queueClient, readIds } from "../src/queue.js";
import { indexClient, rowsOf } from "../src/index-read.js";

const BASE = "https://verify.example";
const TOKEN = "a-token";
const ID = `0x${"0c45b008db6a6b74b203e63e7659fc86c60c2598d762e0280c4ae12fc57e0e2e".slice(0, 64)}`;

interface Sent {
  url: string;
  method: string;
  authorization: string;
  body: unknown;
}

function recorder(reply: (url: string) => Response): { sent: Sent[]; fetcher: typeof fetch } {
  const sent: Sent[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: input,
      method: init?.method ?? "GET",
      authorization: headers.authorization ?? "",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return reply(input);
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the request queue client", () => {
  it("sends the runner token on every call and never in the body", async () => {
    const { sent, fetcher } = recorder(() => json({ requests: [{ passportId: ID }] }));
    await queueClient(BASE, TOKEN, fetcher).pending();
    expect(sent[0]?.url).toBe("https://verify.example/recheck/queue");
    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(sent[0]?.body ?? {})).not.toContain(TOKEN);
  });

  it("reads an empty queue when the service has the queue switched off", async () => {
    const { fetcher } = recorder(() => new Response("runner-disabled", { status: 503 }));
    expect(await queueClient(BASE, TOKEN, fetcher).pending()).toEqual([]);
  });

  it("says so loudly when the token is wrong", async () => {
    const { fetcher } = recorder(() => new Response("no", { status: 401 }));
    await expect(queueClient(BASE, TOKEN, fetcher).pending()).rejects.toThrowError(/answered 401/);
  });

  it("claims a passport, and knows the three answers apart", async () => {
    const codes = [200, 409, 404];
    let at = 0;
    const { fetcher } = recorder(() => new Response("", { status: codes[at++] ?? 500 }));
    const queue = queueClient(BASE, TOKEN, fetcher);
    expect(await queue.claim(ID)).toBe("claimed");
    expect(await queue.claim(ID)).toBe("taken");
    expect(await queue.claim(ID)).toBe("not-requested");
  });

  it("asks for a request of its own on the public route, without the runner token", async () => {
    const codes = [200, 409, 503];
    let at = 0;
    const { sent, fetcher } = recorder(() => json({ passportId: ID, status: "pending" }, codes[at++] ?? 500));
    const queue = queueClient(BASE, TOKEN, fetcher);
    expect(await queue.request(ID)).toBe("placed");
    expect(await queue.request(ID)).toBe("sealed");
    expect(await queue.request(ID)).toBe("failed");
    expect(sent[0]).toEqual({ url: "https://verify.example/recheck/request", method: "POST", authorization: "", body: { passportId: ID } });

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await queueClient(BASE, TOKEN, down).request(ID)).toBe("failed");
  });

  it("reports a finished run with its transaction", async () => {
    const { sent, fetcher } = recorder(() => json({ ok: true }));
    await queueClient(BASE, TOKEN, fetcher).done({
      passportId: ID,
      reportTx: `0x${"1".repeat(64)}`,
      matched: true,
      distance: 2,
    });
    expect(sent[0]?.url).toBe("https://verify.example/recheck/done");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toEqual({ passportId: ID, reportTx: `0x${"1".repeat(64)}`, matched: true, distance: 2 });
  });

  it("cuts a long failure reason to what the queue will store", async () => {
    const { sent, fetcher } = recorder(() => json({ ok: true }));
    await queueClient(BASE, TOKEN, fetcher).done({ passportId: ID, reason: "x".repeat(500) });
    const reason = (sent[0]?.body as { reason: string }).reason;
    expect(reason.length).toBeLessThanOrEqual(200);
  });
});

describe("reading the queue's list whatever shape it arrives in", () => {
  it("takes a bare array, and the wrapped forms", () => {
    expect(readIds([{ passportId: ID }])).toEqual([ID]);
    expect(readIds({ requests: [{ passportId: ID }] })).toEqual([ID]);
    expect(readIds({ queue: [{ passportId: ID }] })).toEqual([ID]);
    expect(readIds({ pending: [ID] })).toEqual([ID]);
  });

  it("drops anything that is not a passport id rather than handing it to the CLI", () => {
    expect(readIds({ requests: [{ passportId: "0xnope" }, { passportId: 7 }, {}, null] })).toEqual([]);
  });

  it("does not repeat an id the queue listed twice", () => {
    expect(readIds([{ passportId: ID }, { passportId: ID.toUpperCase() }])).toEqual([ID]);
  });
});

describe("the index read", () => {
  it("asks only for passports nothing has re-checked, older than the settle line", async () => {
    const { sent, fetcher } = recorder(() => json({ data: { Passport: [] } }));
    await indexClient("https://index.example/v1/graphql", fetcher).unrechecked(1_789_000_000, 5);
    const body = sent[0]?.body as { query: string; variables: { where: unknown; limit: number } };
    expect(body.query).toContain("UnrecheckedPassports");
    expect(body.variables.limit).toBe(5);
    expect(JSON.stringify(body.variables.where)).toContain('"attestationCount":{"_eq":0}');
    expect(JSON.stringify(body.variables.where)).toContain('"registeredAt":{"_lt":"1789000000"}');
  });

  it("reads a timestamp whether the index served a string or a number", () => {
    const rows = rowsOf({
      Passport: [
        { id: ID.toUpperCase(), metadataURI: "ipfs://a", registeredAt: "1789629200", txHash: "0xaa", attestationCount: 0 },
        { id: `0x${"b".repeat(64)}`, metadataURI: "ipfs://b", registeredAt: 1_789_629_300, txHash: "0xbb", attestationCount: "2" },
      ],
    });
    expect(rows[0]?.id).toBe(ID);
    expect(rows[0]?.registeredAt).toBe(1_789_629_200);
    expect(rows[1]?.attestationCount).toBe(2);
  });

  it("drops a row with no transaction hash, because there is nothing to trigger from", () => {
    expect(rowsOf({ Passport: [{ id: ID, metadataURI: "ipfs://a", registeredAt: 1, attestationCount: 0 }] })).toEqual(
      [],
    );
  });

  it("says so when the index refuses the query instead of reading it as an empty registry", async () => {
    const { fetcher } = recorder(() => json({ errors: [{ message: "field registeredAt not found" }] }));
    await expect(indexClient("https://index.example/v1/graphql", fetcher).unrechecked(1, 5)).rejects.toThrowError(
      /field registeredAt not found/,
    );
  });
});
