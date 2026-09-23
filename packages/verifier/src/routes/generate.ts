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
import { takeToday } from "../limits/dayGate.js";
import {
  AI_SOURCE_TYPE,
  FINGERPRINT_VERSION,
  GENERATED_DESCRIPTION,
  SEALED_GENERATED_DESCRIPTION,
  fileSlug,
  passportMetadata,
} from "../metadata.js";
import type { PrivateFile } from "../ipfs/pinata.js";
import {
  PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
  ThumbnailTooLarge,
  makeThumbnail,
  prepareOrFallback,
  prepareSealed,
  type PreparedResult,
  type SealedResult,
} from "../prepare.js";
import { readClient } from "../reputation/registry.js";
import {
  CHAIN_UNREACHABLE,
  PRIVATE_RECHECK_NEEDS_SEALED,
  SEALED_METADATA_REFUSED,
  dropPrivateCopy,
  keepPrivateCopy,
  registrationOf,
  sealedMetadata,
  signedFile,
  type SealedMetadata,
  type SignedFile,
} from "../sealed.js";

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
  /** A private Chainlink re-check of a sealed picture. Refused without `sealed: true`. */
  privateRecheck: z.boolean().optional(),
});

interface Drawn {
  model: string;
  usage?: ImageUsage;
  /**
   * Whether the creator asked for this picture to be registered without being published.
   *
   * It is carried on the drawing rather than worked out again from the shape of it: a picture
   * with no thumbnail happens to be a sealed one today, and guessing from that would make the
   * answer depend on a coincidence instead of on what the creator asked for.
   */
  sealed: boolean;
}

interface DrawnImage extends PreparedResult, Drawn {
  sealed: false;
}

interface SealedDrawnImage extends SealedResult, Drawn {
  sealed: true;
  /**
   * Made only when the creator asked for a private re-check, by the public path's own
   * makeThumbnail from the signed bytes (B14).
   */
  privateThumbnail?: Buffer;
}

/** What a sealed answer adds to the shared fields: the only copy of the picture there will be. */
interface SealedCopy {
  sealed: true;
  privateRecheck?: true;
  signedFile: SignedFile;
}

/** What a public answer adds instead: where the picture and its thumbnail were pinned. */
interface PinnedPicture {
  image: { cid: string; uri: string; gatewayUrl: string; bytes: number; width: number; height: number };
  thumbnail: { cid: string; uri: string; gatewayUrl: string };
}

/**
 * What a creator is told when the file this service is about to hand back does not hash to the
 * passport id, or carries no bytes at all.
 *
 * The check runs before the sealed document is pinned, so this answer can promise that nothing was
 * published. A commitment sitting on IPFS to a picture the creator never received cannot be taken
 * back, and on this path there is no second copy to try again with. Which of the two ways it
 * failed is this service's own fault to fix and stays in the log.
 */
const SEALED_FILE_REFUSED = {
  error: "sealed-file-refused",
  reason:
    "this service could not hand back a sealed file matching the passport it was about to commit to, so nothing was pinned and nothing was registered. Please try again.",
} as const;

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
 * With `sealed: true` and `privateRecheck: true` a 512 px thumbnail of the signed file is also kept
 * on Pinata's private network, exactly as /prepare keeps one: only after the chain says the
 * picture is not registered, before the document is pinned, deleted again if that pin fails, and
 * named nowhere in the document, which gains `privateRecheck: true`. `privateRecheck` without
 * `sealed` is refused with 400 `private-recheck-needs-sealed` before anything is drawn; the other
 * refusals it adds are 409 `already-registered`, 409 `private-copy-not-private`, 422
 * `thumbnail-too-large` and 503 `chain-unreachable`, all after the picture was drawn, so the daily
 * slot stays spent.
 *
 * Answers 401 for a missing or foreign token, 400 for a bad prompt, title, creator, deadline or
 * training statement, 400 `prompt-refused` when the model's safety system turns the prompt down,
 * 400 `deadline-passed`
 * when too little of the window is left for a person to answer a passkey prompt, 403
 * `creator-mismatch` when the creator is not one of the caller's wallets, 429 `quota` past
 * GENERATE_PER_DAY in a rolling day, 429 `global-limit` once GLOBAL_GENERATIONS_PER_DAY is spent
 * for everyone, 502 `model-failed`, `pin-failed` or `sign-failed` when one of
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
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;

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
    if (parsed.data.privateRecheck === true && parsed.data.sealed !== true) {
      return reply.code(400).send(PRIVATE_RECHECK_NEEDS_SEALED);
    }
    const privateRecheck = parsed.data.privateRecheck === true;

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

    // The day's ceiling for everyone, asked last of the three checks and before the model is
    // called. A ceiling that is not this creator's fault must not eat their own allowance, so
    // their slot goes back before the refusal is written.
    const today = takeToday(app, request, reply, "generations", () => {
      quota.release(identity.userId, ticket);
    });
    if (!today.ok) {
      return today.refused;
    }

    let drawn: DrawnImage | SealedDrawnImage;
    try {
      drawn = await gate(() =>
        draw(parsed.data.prompt, parsed.data.title, parsed.data.training, parsed.data.sealed === true, privateRecheck),
      );
    } catch (error) {
      // Only a private re-check makes a thumbnail of a sealed drawing, and a drawing too detailed
      // for the budget was drawn and paid for, so the slot stays spent. A public drawing that
      // lands here keeps the answer it had before this branch existed.
      if (error instanceof ThumbnailTooLarge && privateRecheck) {
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /generate thumbnail too large");
        return reply.code(422).send({
          error: "thumbnail-too-large",
          limit: error.limit,
          reason: PRIVATE_RECHECK_THUMBNAIL_TOO_LARGE_REASON,
        });
      }
      if (error instanceof Busy) {
        quota.release(identity.userId, ticket);
        today.slot.giveBack();
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /generate busy");
        return reply.code(503).send({ error: "busy" });
      }
      if (error instanceof PromptRefused) {
        quota.release(identity.userId, ticket);
        today.slot.giveBack();
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /generate prompt refused");
        return reply.code(400).send({ error: "prompt-refused", reason: error.message });
      }
      // A 4xx is a call the provider turned down before it drew anything, so the slot goes back.
      // A timeout, a dead connection or a 5xx may have drawn and billed, and that one keeps it.
      // The day's budget follows the creator's own allowance exactly: the two are spent or given
      // back together, so /health's count can never drift from what was really drawn.
      const billed = billedOrUnknown(error);
      if (!billed) {
        quota.release(identity.userId, ticket);
        today.slot.giveBack();
      }
      request.log.error(
        { url: request.url, reason: reasonOf(error), slotKept: billed },
        "rejected: /generate model failed",
      );
      return reply.code(502).send({ error: "model-failed" });
    }
    // Past here the picture exists and the provider has been paid for it, so the day's slot stays
    // spent however this request ends: the ceiling is there to bound spend, not attempts.

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
    // What this answer carries on top of the shared fields, chosen by the flag the creator sent.
    let carried: SealedCopy | PinnedPicture;
    let pinnedMetadata: { cid: string; uri: `ipfs://${string}` };

    if (drawn.sealed) {
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
          privateRecheck,
        });
      } catch (error) {
        // Which field did not fit is this service's own fault to fix, so it stays in the log.
        // The picture was drawn, so the daily slot stays spent, and nothing was pinned.
        request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /generate sealed record refused");
        return reply.code(500).send(SEALED_METADATA_REFUSED);
      }

      // The file is packed and checked against the id the chain will commit to before the document
      // is pinned, never after. A pinned commitment to a picture the creator did not receive
      // cannot be taken back, and this service keeps no second copy to try again with.
      let file: SignedFile;
      try {
        file = signedFile(drawn.bytes, `${slug}.jpg`, drawn.print.sha256 as Hex);
      } catch (error) {
        request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /generate sealed file refused");
        return reply.code(500).send(SEALED_FILE_REFUSED);
      }

      // The same step /prepare takes, in the same order: the chain first (B2), then the private
      // copy, then the document, so a document that says privateRecheck never points past a
      // refused copy.
      let privateCopy: PrivateFile | undefined;
      if (privateRecheck) {
        const passportId = drawn.print.sha256 as Hex;
        const registration = await registrationOf(chain, registry, passportId, request.log);
        if (registration === "registered") {
          request.log.warn({ url: request.url, user: identity.userId, passportId }, "rejected: /generate duplicate");
          return reply.code(409).send({ error: "already-registered", passportId });
        }
        if (registration === "unreachable") {
          request.log.warn(
            { url: request.url, user: identity.userId, passportId },
            "rejected: /generate no private copy without a duplicate check",
          );
          return reply.code(503).send(CHAIN_UNREACHABLE);
        }
        if (drawn.privateThumbnail === undefined) {
          throw new Error("a private re-check was asked for and no thumbnail was made");
        }
        const copy = await keepPrivateCopy(drawn.privateThumbnail, passportId, request.log);
        if ("refused" in copy) {
          return reply.code(copy.refused.status).send(copy.refused.body);
        }
        privateCopy = copy.kept;
      }

      try {
        pinnedMetadata = await pinJson(document, `${slug}.json`);
      } catch (error) {
        // pinFile's message carries Pinata's status and its answer, and never the token.
        request.log.error(
          { ip: request.ip, url: request.url, reason: reasonOf(error) },
          "rejected: /generate sealed pin failed",
        );
        if (privateCopy !== undefined) {
          await dropPrivateCopy(privateCopy, request.log);
        }
        return reply.code(502).send({ error: "pin-failed" });
      }
      carried =
        privateCopy === undefined
          ? { sealed: true, signedFile: file }
          : { sealed: true, privateRecheck: true, signedFile: file };
    } else {
      // The picture, its thumbnail and the manifest document do not depend on each other, so they
      // go to Pinata at once rather than one after the next. Settled rather than raced, because a
      // failure still has to say in the log which of the three did land and is now paid for.
      const [imagePin, thumbnailPin, manifestPin] = await Promise.allSettled([
        pinFile(drawn.bytes, `${slug}.jpg`, "image/jpeg"),
        pinFile(drawn.thumbnail, `${slug}-thumb.jpg`, "image/jpeg"),
        drawn.manifestDoc === undefined ? Promise.resolve(undefined) : pinJson(drawn.manifestDoc, `${slug}-c2pa.json`),
      ]);

      if (imagePin.status === "rejected" || thumbnailPin.status === "rejected" || manifestPin.status === "rejected") {
        const attempted = [imagePin, thumbnailPin, manifestPin];
        // pinFile's message carries Pinata's status and its answer, and never the token.
        request.log.error(
          {
            ip: request.ip,
            url: request.url,
            reason: attempted
              .filter((one) => one.status === "rejected")
              .map((one) => reasonOf(one.reason))
              .join("; "),
            landed: attempted.filter((one) => one.status === "fulfilled" && one.value !== undefined).length,
          },
          "rejected: /generate pin failed",
        );
        return reply.code(502).send({ error: "pin-failed" });
      }

      const image = imagePin.value;
      const thumbnail = thumbnailPin.value;
      try {
        pinnedMetadata = await pinJson(
          {
            ...passportMetadata({
              title: parsed.data.title,
              description: GENERATED_DESCRIPTION,
              image: image.uri,
              thumbnail: thumbnail.uri,
              manifest: manifestPin.value?.uri,
              prompt: parsed.data.prompt,
              agentId: env.GENERATOR_AGENT_ID,
              fingerprint: drawn.print,
              training: parsed.data.training,
            }),
            // Which model drew it is not part of the shared document, and a generated passport is
            // worth less without it: it is the one field that says what made these pixels.
            model: drawn.model,
          },
          `${slug}.json`,
        );
      } catch (error) {
        request.log.error(
          { ip: request.ip, url: request.url, reason: reasonOf(error) },
          "rejected: /generate metadata pin failed",
        );
        return reply.code(502).send({ error: "pin-failed" });
      }

      carried = {
        image: {
          cid: image.cid,
          uri: image.uri,
          gatewayUrl: gatewayUrl(image.uri),
          bytes: drawn.bytes.length,
          width: drawn.print.width,
          height: drawn.print.height,
        },
        thumbnail: { cid: thumbnail.cid, uri: thumbnail.uri, gatewayUrl: gatewayUrl(thumbnail.uri) },
      };
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

    // A sealed answer carries the only copy of the picture and a public one carries where to find
    // it. Neither may sit in a cache on the way to the browser that asked for it, which the hook
    // in server.ts puts on every answer this route sends.
    return reply.send({ ...answer, ...carried });
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
  privateRecheck: boolean,
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
    const privateThumbnail = privateRecheck ? await makeThumbnail(prepared.bytes) : undefined;
    return { ...prepared, privateThumbnail, model: image.model, usage: image.usage, sealed: true };
  }
  const prepared = await prepareOrFallback(image.bytes, settings);
  return { ...prepared, model: image.model, usage: image.usage, sealed: false };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
