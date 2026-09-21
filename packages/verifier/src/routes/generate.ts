import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress } from "viem";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { trainingSchema, trainingStatement, type TrainingConsent } from "../consent.js";
import { env } from "../env.js";
import type { Hex } from "../fingerprint.js";
import { Busy, waitingGate } from "../generate/gate.js";
import { generatorDomain, generatorWallet, signPassportAsGenerator } from "../generate/generatorSigner.js";
import { Kind, type PassportInput } from "../generate/eip712.js";
import { PromptRefused, billedOrUnknown, createImage, type ImageUsage } from "../generate/imageModel.js";
import { ownerContext, privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import {
  AI_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  GENERATED_DESCRIPTION,
  SEALED_GENERATED_DESCRIPTION,
  fileSlug,
  passportMetadata,
} from "../metadata.js";
import { prepareOrFallback, prepareSealed, type PreparedResult, type SealedResult } from "../prepare.js";
import { SEALED_METADATA_REFUSED, sealedMetadata, signedFile, type SealedMetadata } from "../sealed.js";

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

/**
 * How much of the deadline has to be left at the moment the agent signs.
 *
 * Drawing and pinning take most of a minute, and after that the person still has to answer a
 * passkey prompt and wait for the transaction. Signing with less than two minutes left would hand
 * them a passport that expires in their hand and a revert they paid for.
 */
const SIGN_WINDOW_SECONDS = 120;

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
  training: trainingSchema.optional(),
  sealed: z.boolean().optional(),
  /**
   * The prompt is the one public field that can describe the picture in words, so a sealed
   * registration leaves it out unless the creator asks for it back.
   */
  includePrompt: z.boolean().optional(),
});

interface Drawn {
  model: string;
  usage?: ImageUsage;
}

interface DrawnImage extends PreparedResult, Drawn {}

interface SealedDrawnImage extends SealedResult, Drawn {}

/** What one pin gives back, so the public branch can carry its pair to the answer. */
type Pinned = Awaited<ReturnType<typeof pinFile>>;

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
 * The creator address on the passport has to be one of the caller's own Privy wallets, read from
 * their user record rather than taken from the request, so nobody can have the agent co-sign a
 * passport that credits someone else. The deadline is checked twice, once as the caller asked for
 * it and once again just before the agent signs, because everything in between takes real time.
 *
 * The creator may say how AI may use the picture in the same request, in an optional `training`
 * field. It is written into the manifest before the agent signs anything and into the pinned
 * metadata whose address both signatures cover.
 *
 * With `sealed: true` the picture is registered without being published. The drawing, the
 * manifest, the fingerprint and the agent's signature are the same; what changes is that nothing
 * of the picture is pinned or kept, one small metadata document goes to IPFS, and the signed file
 * comes back in the answer as the only copy there will be. The prompt stays out of that document
 * unless the creator sends `includePrompt: true`, because it describes the picture in words. The
 * model provider drew this picture and has seen it, which sealed does not change.
 *
 * Answers 401 for a missing or foreign token, 400 for a bad prompt, title, creator, deadline or
 * training statement, 400 `prompt-refused` when the model's safety system turns the prompt down,
 * 400 `deadline-passed`
 * when too little of the window is left for a person to answer a passkey prompt, 403
 * `creator-mismatch` when the creator is not one of the caller's wallets, 429 `quota` past
 * GENERATE_PER_DAY in a rolling day, 502 `model-failed`, `pin-failed` or `sign-failed` when one of
 * the three outside services will not play, and 503 `busy` when no drawing slot came free.
 *
 * A picture the provider never drew gives the daily slot back. A call that timed out or died in
 * the middle of drawing may have been billed, so that one keeps its slot.
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

    // Read before the body is trusted, so that a refusal which repeats a field the caller sent
    // is uncacheable too. Every answer to a sealed request carries this, not only the one that
    // carries the picture.
    if ((request.body as { sealed?: unknown } | undefined)?.sealed === true) {
      void reply.header("cache-control", "no-store");
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

    let wallets: Hex[];
    try {
      wallets = await embeddedWallets(privy(), identity.userId);
    } catch (error) {
      // A user id this Privy app does not know owns no wallet here, which for the caller is the
      // same answer as asking for someone else's address.
      if (error instanceof APIError && error.status === 404) {
        request.log.warn({ url: request.url, user: identity.userId, creator }, "rejected: /generate unknown user");
        return reply.code(403).send({ error: "creator-mismatch" });
      }
      request.log.error(
        { url: request.url, reason: privyErrorText(error) },
        "rejected: /generate wallet lookup failed",
      );
      return reply.code(502).send({ error: "sign-failed" });
    }

    if (!wallets.includes(creator)) {
      request.log.warn(
        { url: request.url, user: identity.userId, creator, wallets: wallets.join(" ") },
        "rejected: /generate creator is not a wallet of the caller",
      );
      return reply.code(403).send({ error: "creator-mismatch" });
    }

    const reservation = quota.take(identity.userId);
    if (!reservation.ok) {
      request.log.warn({ ip: request.ip, url: request.url, user: identity.userId }, "rejected: /generate quota");
      return reply.code(429).send({ error: "quota", quota: reservation.state });
    }
    const ticket = reservation.ticket as number;

    const sealed = parsed.data.sealed === true;
    let drawn: DrawnImage | SealedDrawnImage;
    try {
      drawn = await gate(() => draw(parsed.data.prompt, parsed.data.title, parsed.data.training, sealed));
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
      // A 4xx is a call the provider turned down before it drew anything, so the slot goes back.
      // A timeout, a dead connection or a 5xx may have drawn and billed, and that one keeps it.
      const billed = billedOrUnknown(error);
      if (!billed) {
        quota.release(identity.userId, ticket);
      }
      const reason = error instanceof Error ? error.message : String(error);
      request.log.error({ url: request.url, reason, slotKept: billed }, "rejected: /generate model failed");
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
      request.log.warn({ url: request.url, reason: drawn.detail }, "generate: manifest not embedded");
    }

    const slug = fileSlug(parsed.data.title, drawn.print.sha256);
    // Only a public registration was given a thumbnail and a manifest document to pin, so the
    // absence of those is what marks the sealed path in the two branches below.
    const published = "thumbnail" in drawn ? drawn : undefined;
    let publicPins: { image: Pinned; thumbnail: Pinned } | undefined;
    let pinnedMetadata: { cid: string; uri: `ipfs://${string}` };
    try {
      if (published === undefined) {
        let document: SealedMetadata;
        try {
          document = sealedMetadata({
            title: parsed.data.title,
            description: SEALED_GENERATED_DESCRIPTION,
            passportId: drawn.print.sha256,
            fingerprint: drawn.print,
            agentId: env.GENERATOR_AGENT_ID,
            training: parsed.data.training,
            model: drawn.model,
            // The prompt is a description of the picture in the creator's own words, so a sealed
            // passport leaves it out unless the creator asked for it to be public.
            prompt: parsed.data.includePrompt === true ? parsed.data.prompt : undefined,
          });
        } catch (error) {
          // Which field did not fit is this service's own fault to fix, so it stays in the log.
          // The picture was drawn, so the daily slot stays spent, and nothing was pinned.
          const reason = error instanceof Error ? error.message : String(error);
          request.log.error({ url: request.url, reason }, "rejected: /generate sealed record refused");
          return reply.code(500).send(SEALED_METADATA_REFUSED);
        }

        pinnedMetadata = await pinJson(document, `${slug}.json`);
      } else {
        const image = await pinFile(published.bytes, `${slug}.jpg`, "image/jpeg");
        const thumbnail = await pinFile(published.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
        const manifest =
          published.manifestDoc === undefined ? undefined : await pinJson(published.manifestDoc, `${slug}-c2pa.json`);
        publicPins = { image, thumbnail };

        pinnedMetadata = await pinJson(
          {
            ...passportMetadata({
              title: parsed.data.title,
              description: GENERATED_DESCRIPTION,
              image: image.uri,
              thumbnail: thumbnail.uri,
              manifest: manifest?.uri,
              prompt: parsed.data.prompt,
              agentId: env.GENERATOR_AGENT_ID,
              fingerprint: published.print,
              training: parsed.data.training,
            }),
            // Which model drew it is not part of the shared document, and a generated passport is
            // worth less without it: it is the one field that says what made these pixels.
            model: drawn.model,
          },
          `${slug}.json`,
        );
      }
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

    const secondsLeft = Number(deadline) - Math.floor(Date.now() / 1000);
    if (secondsLeft < SIGN_WINDOW_SECONDS) {
      // The picture was drawn and pinned, so the daily slot stays spent. Only the signature is
      // refused, because one made now would expire before the creator could use it.
      request.log.warn(
        { url: request.url, user: identity.userId, secondsLeft },
        "rejected: /generate too little of the deadline left to sign",
      );
      return reply.code(400).send({ error: "deadline-passed" });
    }

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

    const answer = {
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
      metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
      // Both paths say this, and a sealed answer says it for the same reason a public one does:
      // the creator has to know whether the file carries its provenance inside it.
      manifest: drawn.embedded ? { embedded: true } : { embedded: false, reason: drawn.reason },
      training: trainingStatement(parsed.data.training),
      model: drawn.model,
      agent: { id: input.generatorAgentId.toString(), wallet: agent.address },
      quota: quota.state(identity.userId),
      preparedBy: identity.userId,
    };

    if (published === undefined || publicPins === undefined) {
      // The only copy of this picture leaves in this answer, so it must not sit in a cache on the
      // way to the browser that asked for it.
      return reply.header("cache-control", "no-store").send({
        ...answer,
        sealed: true,
        signedFile: signedFile(drawn.bytes, `${slug}.jpg`, input.exactHash),
      });
    }

    return reply.send({
      ...answer,
      image: {
        cid: publicPins.image.cid,
        uri: publicPins.image.uri,
        gatewayUrl: gatewayUrl(publicPins.image.uri),
        bytes: published.bytes.length,
        width: published.print.width,
        height: published.print.height,
      },
      thumbnail: {
        cid: publicPins.thumbnail.cid,
        uri: publicPins.thumbnail.uri,
        gatewayUrl: gatewayUrl(publicPins.thumbnail.uri),
      },
    });
  });
}

/**
 * Draws the picture and gets it ready to pin.
 *
 * The prompt is the only thing that reaches the model: there is no wrapper text, so nothing this
 * service says about itself can end up inside the manifest of a picture a creator then registers
 * in their own name. The manifest carries the same soft binding /prepare writes and the same
 * training statement when the creator made one, and a file the C2PA signer will not take still
 * produces a usable passport, it just loses the provenance that travels inside the file.
 */
async function draw(
  prompt: string,
  title: string,
  training: TrainingConsent | undefined,
  sealed: boolean,
): Promise<DrawnImage | SealedDrawnImage> {
  const image = await createImage(prompt, { timeoutMs: MODEL_TIMEOUT_MS });
  const settings = {
    title,
    claimGenerator: CLAIM_GENERATOR,
    action: "c2pa.created" as const,
    digitalSourceType: AI_SOURCE_TYPE,
    training,
  };
  if (sealed) {
    const prepared = await prepareSealed(image.bytes, settings);
    return { ...prepared, model: image.model, usage: image.usage };
  }
  const prepared = await prepareOrFallback(image.bytes, settings);
  return { ...prepared, model: image.model, usage: image.usage };
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
