import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress } from "viem";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { env } from "../env.js";
import { fingerprint, type Fingerprint, type Hex } from "../fingerprint.js";
import { Busy, waitingGate } from "../generate/gate.js";
import { generatorDomain, generatorWallet, signPassportAsGenerator } from "../generate/generatorSigner.js";
import { Kind, type PassportInput } from "../generate/eip712.js";
import { PromptRefused, createImage, type ImageUsage } from "../generate/imageModel.js";
import { ownerContext, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import {
  AI_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  GENERATED_DESCRIPTION,
  fileSlug,
  manifestDocument,
  passportMetadata,
} from "../metadata.js";
import { makeThumbnail, prepareImage, uprightImage } from "../prepare.js";

/** What the C2PA manifest records as the tool that made the claim. */
const CLAIM_GENERATOR = "moolam-agent/0.1.0";

/** A generated passport has no parent and, being generated, carries the agent that drew it. */
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/**
 * How many pictures may be drawn at once across the service.
 *
 * Two is the same shape as the match gate: the model call is the slow part and the C2PA signing
 * and thumbnail are the CPU part, and both of those run inside the gate. Pinning and signing
 * happen outside it, because they are network waits that hold nothing heavy in memory.
 */
const MAX_CONCURRENT_GENERATIONS = 2;

/** How long a queued request waits for a slot before it is told the service is busy. */
const MAX_GATE_WAIT_MS = 90_000;

/** How long the image model gets to answer. Past this the request is abandoned and not retried. */
const MODEL_TIMEOUT_MS = 60_000;

/** The window the two signatures stay valid for, as the caller may ask for it. */
const MIN_DEADLINE_SECONDS = 10 * 60;
const MAX_DEADLINE_SECONDS = 2 * 60 * 60;

const bodySchema = z.object({
  prompt: z.string().trim().min(8).max(600),
  title: z.string().trim().min(1).max(120),
  creator: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, "creator must be 0x followed by 40 hex characters"),
  deadline: z.union([
    z.number().int().positive(),
    z.string().trim().regex(/^[0-9]+$/, "deadline must be a whole number of unix seconds"),
  ]),
});

interface DrawnImage {
  /** The bytes that get pinned, and whose sha256 becomes the passport id. */
  bytes: Buffer;
  thumbnail: Buffer;
  print: Fingerprint;
  manifestHash: Hex;
  manifestDoc?: unknown;
  embedded: boolean;
  reason?: string;
  model: string;
  usage?: ImageUsage;
}

/**
 * POST /generate: the generator agent draws a picture for a signed-in creator and co-signs its
 * passport.
 *
 * The agent's key lives in a Privy enclave under a policy that allows one thing, an EIP-712
 * Passport signature on the Moolam registry's domain, so this service can ask for that signature
 * and can do nothing else with the agent's wallet. The order of work is what makes the answer
 * safe to act on: the token is checked and the daily quota is taken before a cent is spent, the
 * image is drawn, signed with a C2PA manifest and pinned, and only then, over the final pinned
 * bytes, does the agent sign. The browser adds the creator's passkey signature over the same
 * struct and sends the transaction, so nothing here can write to the chain.
 *
 * Answers 401 for a missing or foreign token, 400 for a bad prompt, title, creator or deadline,
 * 400 `prompt-refused` when the model's safety system turns the prompt down, 429 `quota` past
 * GENERATE_PER_DAY in a rolling day, 502 `model-failed`, `pin-failed` or `sign-failed` when one of
 * the three outside services will not play, and 503 `busy` when no drawing slot came free.
 */
export async function generateRoutes(
  app: FastifyInstance,
  options: { keys?: PrivyKeys } = {},
): Promise<void> {
  const gate = waitingGate(MAX_CONCURRENT_GENERATIONS, MAX_GATE_WAIT_MS);
  const quota = dailyQuota(env.GENERATE_PER_DAY);

  app.post("/generate", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await identify(request, options.keys);
    if (identity === undefined) {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: /generate unauthorized");
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      return reply.code(400).send({ error: reason });
    }

    const deadline = BigInt(parsed.data.deadline);
    const ahead = Number(deadline) - Math.floor(Date.now() / 1000);
    if (ahead < MIN_DEADLINE_SECONDS || ahead > MAX_DEADLINE_SECONDS) {
      return reply.code(400).send({
        error: `deadline must be between ${MIN_DEADLINE_SECONDS / 60} minutes and ${MAX_DEADLINE_SECONDS / 3600} hours from now`,
      });
    }
    const creator = getAddress(parsed.data.creator as Hex);

    const reservation = quota.take(identity.userId);
    if (!reservation.ok) {
      request.log.warn({ ip: request.ip, url: request.url, user: identity.userId }, "rejected: /generate quota");
      return reply.code(429).send({ error: "quota", quota: reservation.state });
    }
    const ticket = reservation.ticket as number;

    let drawn: DrawnImage;
    try {
      drawn = await gate(() => draw(parsed.data.prompt, parsed.data.title));
    } catch (error) {
      if (error instanceof Busy) {
        quota.release(identity.userId, ticket);
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /generate busy");
        return reply.code(503).send({ error: "busy" });
      }
      if (error instanceof PromptRefused) {
        quota.release(identity.userId, ticket);
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /generate prompt refused");
        return reply.code(400).send({ error: "prompt-refused", reason: error.message });
      }
      // The model may have drawn and billed before it failed, so this one keeps its quota slot.
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ url: request.url, reason }, "rejected: /generate model failed");
      return reply.code(502).send({ error: "model-failed" });
    }

    // What the picture cost is the one number this route spends money on, so it is logged on
    // every success rather than left to the provider's dashboard.
    request.log.info(
      {
        user: identity.userId,
        model: drawn.model,
        imageTokens: drawn.usage?.outputTokens,
        totalTokens: drawn.usage?.totalTokens,
        bytes: drawn.bytes.length,
      },
      "generate: picture drawn",
    );

    if (!drawn.embedded) {
      request.log.warn({ url: request.url, reason: drawn.reason }, "generate: manifest not embedded");
    }

    const slug = fileSlug(parsed.data.title, drawn.print.sha256);
    let pinnedImage;
    let thumbnail;
    let pinnedMetadata;
    try {
      pinnedImage = await pinFile(drawn.bytes, `${slug}.jpg`, "image/jpeg");
      thumbnail = await pinFile(drawn.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
      const manifest =
        drawn.manifestDoc === undefined ? undefined : await pinJson(drawn.manifestDoc, `${slug}-c2pa.json`);

      pinnedMetadata = await pinJson(
        {
          ...passportMetadata({
            title: parsed.data.title,
            description: GENERATED_DESCRIPTION,
            image: pinnedImage.uri,
            thumbnail: thumbnail.uri,
            manifest: manifest?.uri,
            prompt: parsed.data.prompt,
            agentId: env.GENERATOR_AGENT_ID,
            fingerprint: drawn.print,
          }),
          // Which model drew it is not part of the shared document, and a generated passport is
          // worth less without it: it is the one field that says what made these pixels.
          model: drawn.model,
        },
        `${slug}.json`,
      );
    } catch (error) {
      // pinFile's message carries Pinata's status and its answer, and never the token.
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: /generate pin failed");
      return reply.code(502).send({ error: "pin-failed" });
    }

    const input: PassportInput = {
      exactHash: drawn.print.sha256 as Hex,
      parentId: ZERO_BYTES32,
      creator,
      generatorAgentId: env.GENERATOR_AGENT_ID,
      phash: drawn.print.phash,
      blockhash256: drawn.print.blockhash as Hex,
      manifestHash: drawn.manifestHash,
      kind: Kind.Generated,
      fingerprintVersion: FINGERPRINT_VERSION,
      metadataURI: pinnedMetadata.uri,
      deadline,
    };

    let agent;
    let generatorSig;
    try {
      agent = await generatorWallet();
      generatorSig = await signPassportAsGenerator(
        agent.id,
        agent.address,
        input,
        generatorDomain(),
        ownerContext(),
      );
    } catch (error) {
      // privyErrorText is Privy's status, code and message. The authorization key is never in it.
      request.log.error({ url: request.url, reason: privyErrorText(error) }, "rejected: /generate sign failed");
      return reply.code(502).send({ error: "sign-failed" });
    }

    return reply.send({
      passport: {
        exactHash: input.exactHash,
        parentId: input.parentId,
        creator: input.creator,
        generatorAgentId: input.generatorAgentId.toString(),
        phash: input.phash.toString(),
        blockhash256: input.blockhash256,
        manifestHash: input.manifestHash,
        kind: input.kind,
        fingerprintVersion: input.fingerprintVersion,
        metadataURI: input.metadataURI,
        deadline: input.deadline.toString(),
      },
      generatorSig,
      image: {
        cid: pinnedImage.cid,
        uri: pinnedImage.uri,
        gatewayUrl: gatewayUrl(pinnedImage.uri),
        bytes: drawn.bytes.length,
        width: drawn.print.width,
        height: drawn.print.height,
      },
      thumbnail: { cid: thumbnail.cid, uri: thumbnail.uri, gatewayUrl: gatewayUrl(thumbnail.uri) },
      metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
      manifest: drawn.embedded ? { embedded: true } : { embedded: false, reason: drawn.reason },
      model: drawn.model,
      agent: { id: input.generatorAgentId.toString(), wallet: agent.address },
      quota: quota.state(identity.userId),
      preparedBy: identity.userId,
    });
  });
}

/**
 * Draws the picture and gets it ready to pin.
 *
 * The prompt is the only thing that reaches the model: there is no wrapper text, so nothing this
 * service says about itself can end up inside the manifest of a picture a creator then registers
 * in their own name. The manifest carries the same soft binding /prepare writes, and a file the
 * C2PA signer will not take still produces a usable passport, it just loses the provenance that
 * travels inside the file.
 */
async function draw(prompt: string, title: string): Promise<DrawnImage> {
  const image = await createImage(prompt, { timeoutMs: MODEL_TIMEOUT_MS });

  try {
    const prepared = await prepareImage(image.bytes, {
      title,
      claimGenerator: CLAIM_GENERATOR,
      action: "c2pa.created",
      digitalSourceType: AI_SOURCE_TYPE,
    });
    return {
      bytes: prepared.original,
      thumbnail: prepared.thumbnail,
      print: prepared.fingerprint,
      manifestHash: prepared.manifestHash,
      manifestDoc: manifestDocument(prepared),
      embedded: true,
      model: image.model,
      usage: image.usage,
    };
  } catch (error) {
    const upright = await uprightImage(image.bytes);
    return {
      bytes: upright,
      thumbnail: await makeThumbnail(upright),
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      model: image.model,
      usage: image.usage,
    };
  }
}

/**
 * Who sent this request, or undefined when the token is missing, expired or from another Privy
 * app. Anything wrong with it is a 401 and never a 500, and the reason is logged rather than
 * returned.
 */
async function identify(request: FastifyRequest, keys?: PrivyKeys): Promise<PrivyIdentity | undefined> {
  const token = bearerToken(request.headers.authorization);
  if (token === undefined) return undefined;
  try {
    return await verifyPrivyToken(token, keys);
  } catch (error) {
    if (error instanceof InvalidToken) {
      request.log.warn({ ip: request.ip, reason: error.message }, "rejected: bad Privy token");
      return undefined;
    }
    throw error;
  }
}
