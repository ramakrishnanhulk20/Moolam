import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { domain as serviceRegistryDomain, passportDigest as servicePassportDigest } from "@moolam/verifier/src/generate/eip712.js";
import { platformKeyHash } from "@moolam/verifier/src/platform/key.js";
import { MODE, issuedAtProblem, prepareDigest, signedByAddress } from "@moolam/verifier/src/platform/signatures.js";
import { identityAbi, registryAbi } from "../../src/abi.js";
import { AGENT_IDENTITY_REGISTRY, MOOLAM_REGISTRY } from "../../src/constants.js";

// Real fingerprint numbers of packages/verifier/test-assets/original.jpg, as the agents fork test
// uses them. The registry does not recompute them, so any honest-looking values serve.
const PHASH = 0x336b806a7e894e76n;
const BLOCKHASH = "0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff" as Hex;
const WINDOW = 30n * 60n;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A lying service: each switch makes one answer wrong in the way the kit must catch. */
export type Tamper = "digest" | "signed-file" | "terms" | null;

export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  /** Every header but the Authorization one, as one string, for checks that nothing else rides there. */
  otherHeaders: string;
}

/** One accepted ticket as GET /platform/deliveries lists it. */
export interface MockDelivery {
  ticketId: string;
  passportId: Hex;
  destination: string;
}

interface FileEntry {
  cid: string;
  bytes: number;
}

export interface MockRecord {
  fields: Record<string, string | number>;
  files: Record<"image" | "thumbnail" | "manifest" | "metadata", FileEntry>;
  openBy: number;
  state: "awaiting-creator" | "creator-set" | "signed";
  creator?: Address;
  deadline?: bigint;
  digest?: Hex;
  agentSignature?: Hex;
}

function sha256(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function fakeCid(): string {
  return `bafkrei${Array.from(randomBytes(52), (byte) => BASE32[byte % 32]).join("")}`;
}

/**
 * The verify service's four platform routes, answered at the HTTP level on this machine. There is
 * no gateway: the platform-mode prepare hands the signed file back in its answer, as the real route
 * does. It checks the key, the agent owner's PlatformPrepare and passport signatures with the
 * service's own functions against ownerOf read from the fork, and says "registered" only after a
 * getPassport read of the fork, as the real routes do. It does not sign C2PA, fingerprint or pin:
 * its "signed file" is the picture with bytes appended, so every passport id is new to mainnet.
 * For the email claim it keeps each prepare's deliverTo field as sent, answers deliverNow when told
 * to, and lists whatever deliveries a test sets, so a test can list a ticket the real service would
 * already have filtered out; a failed report removes the ticket from the list, as the service does.
 */
export class MockVerifyService {
  readonly seen: SeenRequest[] = [];
  readonly records = new Map<string, MockRecord>();
  tamper: Tamper = null;
  base = "";
  /** The deliverTo field of each platform prepare, as it arrived; undefined when the request carried none. */
  readonly deliverToSeen: (string | undefined)[] = [];
  /** The standing destination the next platform-mode answers carry, as the service would write it. */
  deliverNow: string | undefined;
  deliveries: MockDelivery[] = [];
  readonly failedReports: string[] = [];

  readonly #key: string;
  readonly #keyHash: Hex;
  readonly #agentId: bigint;
  readonly #creatorWallet: Address;
  readonly #reader: PublicClient;
  #server: Server | undefined;

  constructor(options: { platformKey: string; agentId: bigint; creatorWallet: Address; reader: PublicClient }) {
    this.#key = options.platformKey;
    this.#keyHash = `0x${platformKeyHash(options.platformKey).toString("hex")}`;
    this.#agentId = options.agentId;
    this.#creatorWallet = getAddress(options.creatorWallet);
    this.#reader = options.reader;
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  /** What the co-sign page does when the person signs in: the creator is set once, with a chain-time deadline. */
  async openAs(handle: string, wallet: Address): Promise<void> {
    const record = this.records.get(handle);
    if (record === undefined || record.state !== "awaiting-creator") throw new Error("no record awaiting a creator");
    const deadline = (await this.#now()) + WINDOW;
    record.creator = getAddress(wallet);
    record.deadline = deadline;
    record.digest = this.#digest(record, record.creator, deadline);
    record.state = "creator-set";
  }

  async #now(): Promise<bigint> {
    return (await this.#reader.getBlock({ blockTag: "latest" })).timestamp;
  }

  async #agentOwner(): Promise<Address> {
    return getAddress(
      await this.#reader.readContract({ address: AGENT_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [this.#agentId] }),
    );
  }

  #digest(record: MockRecord, creator: Address, deadline: bigint): Hex {
    const f = record.fields;
    return servicePassportDigest(
      {
        exactHash: f.exactHash as Hex,
        parentId: f.parentId as Hex,
        creator,
        generatorAgentId: BigInt(f.generatorAgentId as string),
        phash: BigInt(f.phash as string),
        blockhash256: f.blockhash256 as Hex,
        manifestHash: f.manifestHash as Hex,
        kind: 0,
        fingerprintVersion: 1,
        metadataURI: f.metadataURI as string,
        deadline,
      },
      serviceRegistryDomain(MOOLAM_REGISTRY, 143),
    );
  }

  #filesAnswer(record: MockRecord): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(record.files).map(([role, entry]) => [
        role,
        { cid: entry.cid, uri: `ipfs://${entry.cid}`, gatewayUrl: `${this.base}/ipfs/${entry.cid}`, bytes: entry.bytes },
      ]),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = request.url ?? "";
    const { authorization, ...otherHeaders } = request.headers;
    this.seen.push({ method: request.method ?? "", url, authorization, otherHeaders: JSON.stringify(otherHeaders) });
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };

    if (request.headers.authorization !== `Bearer ${this.#key}`) return send(401, { error: "unauthorized" });

    if (request.method === "GET" && url === "/platform/deliveries") {
      return send(200, { deliveries: this.deliveries });
    }
    const failed = /^\/platform\/deliveries\/([0-9A-Za-z_-]+)\/failed$/.exec(url);
    if (request.method === "POST" && failed !== null) {
      const ticketId = failed[1] as string;
      this.failedReports.push(ticketId);
      this.deliveries = this.deliveries.filter((one) => one.ticketId !== ticketId);
      return send(200, { ok: true });
    }

    if (request.method === "POST" && url === "/platform/prepare") {
      const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return send(400, { error: "no file" });
      const picture = new Uint8Array(await file.arrayBuffer());
      const mode = form.get("mode") as "platform" | "cosign";
      const deliverTo = form.get("deliverTo");
      if (mode === "platform") this.deliverToSeen.push(typeof deliverTo === "string" ? deliverTo : undefined);
      const issuedAt = BigInt(form.get("issuedAt") as string);
      const now = await this.#now();
      if (issuedAtProblem(issuedAt, now) !== null) return send(403, { error: "prepare-expired" });
      const message = { mode: MODE[mode], pictureHash: sha256(picture), platformId: this.#keyHash, nonce: form.get("nonce") as Hex, issuedAt };
      if (!(await signedByAddress(prepareDigest(message), form.get("signature") as string, await this.#agentOwner()))) {
        return send(403, { error: "agent-signature-refused" });
      }

      const signed = Buffer.concat([picture, Buffer.from("moolam-signed"), randomBytes(16)]);
      const record: MockRecord = {
        fields: {
          exactHash: sha256(signed),
          parentId: `0x${"00".repeat(32)}`,
          generatorAgentId: this.#agentId.toString(),
          phash: PHASH.toString(),
          blockhash256: BLOCKHASH,
          manifestHash: `0x${randomBytes(32).toString("hex")}`,
          kind: 0,
          fingerprintVersion: 1,
          metadataURI: "",
        },
        files: {
          image: { cid: fakeCid(), bytes: signed.length },
          thumbnail: { cid: fakeCid(), bytes: 900 },
          manifest: { cid: fakeCid(), bytes: 700 },
          metadata: { cid: fakeCid(), bytes: 1200 },
        },
        openBy: Number(now + WINDOW),
        state: "awaiting-creator",
      };
      record.fields.metadataURI = `ipfs://${record.files.metadata.cid}`;

      const trainingText = form.get("training");
      const stated = typeof trainingText === "string" ? { ...JSON.parse(trainingText), standard: "cawg.training-mining/1.1" } : undefined;
      const training = this.tamper === "terms" && stated !== undefined ? { ...stated, aiTraining: "allowed" } : stated;
      const common = { files: this.#filesAnswer(record), training, platform: { name: "Example Platform", agentId: this.#agentId.toString() }, manifest: { embedded: true } };

      if (mode === "platform") {
        const deadline = now + WINDOW;
        const digest = this.#digest(record, this.#creatorWallet, deadline);
        const handed = this.tamper === "signed-file" ? Buffer.concat([signed, Buffer.from("!")]) : signed;
        return send(200, {
          mode: "platform",
          passport: { ...record.fields, creator: this.#creatorWallet, deadline: deadline.toString() },
          digest: this.tamper === "digest" ? `0x${randomBytes(32).toString("hex")}` : digest,
          signedFile: { name: "picture.jpg", type: "image/jpeg", bytes: handed.toString("base64"), sha256: record.fields.exactHash },
          ...common,
          ...(this.deliverNow === undefined ? {} : { deliverNow: this.deliverNow }),
        });
      }
      const handle = randomBytes(16).toString("hex");
      this.records.set(handle, record);
      return send(200, { mode: "cosign", handle, passport: record.fields, openBy: record.openBy, ...common });
    }

    const status = /^\/platform\/status\/([0-9a-f]{32})$/.exec(url);
    const sign = /^\/platform\/sign\/([0-9a-f]{32})$/.exec(url);
    const handle = (status ?? sign)?.[1];
    const record = handle === undefined ? undefined : this.records.get(handle);
    if (record === undefined) return send(404, { error: "not-found" });

    if (sign !== null && request.method === "POST") {
      const signature = (JSON.parse(body.toString("utf8")) as { signature: string }).signature.toLowerCase() as Hex;
      if (record.state !== "creator-set" || record.creator === undefined || record.deadline === undefined) return send(409, { error: record.state });
      const digest = this.#digest(record, record.creator, record.deadline);
      if (!(await signedByAddress(digest, signature, await this.#agentOwner()))) return send(403, { error: "agent-signature-refused" });
      record.agentSignature = signature;
      record.state = "signed";
      return send(200, this.#recordAnswer(record, record.state));
    }

    let state: string = record.state;
    let registeredAt: string | undefined;
    if (record.state === "signed") {
      const onChain = await this.#reader.readContract({
        address: MOOLAM_REGISTRY,
        abi: registryAbi,
        functionName: "getPassport",
        args: [record.fields.exactHash as Hex],
      });
      if (onChain.registeredAt !== 0n) {
        const ours = getAddress(onChain.creator) === record.creator && onChain.metadataURI === record.fields.metadataURI;
        state = ours ? "registered" : "failed";
        registeredAt = ours ? onChain.registeredAt.toString() : undefined;
      }
    }
    return send(200, { ...this.#recordAnswer(record, state), ...(registeredAt === undefined ? {} : { registeredAt }) });
  }

  #recordAnswer(record: MockRecord, state: string): Record<string, unknown> {
    return {
      state,
      agentId: this.#agentId.toString(),
      platform: { name: "Example Platform", agentId: this.#agentId.toString() },
      exactHash: record.fields.exactHash,
      passport: {
        ...record.fields,
        ...(record.creator === undefined ? {} : { creator: record.creator }),
        ...(record.deadline === undefined ? {} : { deadline: record.deadline.toString() }),
      },
      files: this.#filesAnswer(record),
      openBy: record.openBy,
      ...(record.digest === undefined ? {} : { digest: record.digest }),
      ...(record.agentSignature === undefined ? {} : { agentSignature: record.agentSignature }),
    };
  }
}
