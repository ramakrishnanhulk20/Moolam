import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import {
  editCalldata,
  estimateEditGas,
  parentOwner,
  passportExists,
  revertName,
  tokenIdOf,
} from "../edit/registry.js";
import { SponsoredSendFailed, SponsoredSendPending, sendFromWallet } from "../edit/send.js";
import { delegatedWallet, signerIds, walletSigners, type OwnerWallet } from "../edit/signers.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { ImageTooLarge, fingerprint, readImageHeader, type Fingerprint, type Hex } from "../fingerprint.js";
import { Kind, type PassportInput } from "../generate/eip712.js";
import { Busy, waitingGate } from "../generate/gate.js";
import { ownerContext, privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import { FINGERPRINT_VERSION, fileSlug, manifestDocument, passportMetadata } from "../metadata.js";
import { makeThumbnail, prepareImage, uprightImage } from "../prepare.js";
import { MONAD_CHAIN_ID, readClient } from "../reputation/registry.js";
import { BadRequest, statusOf } from "./shared.js";

/** What the C2PA manifest records as the tool that made the claim. */
const CLAIM_GENERATOR = "moolam-studio/0.1.0";

/** IPTC's code for a picture a person changed by hand. C2PA readers key their label off it. */
const EDITED_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/minorHumanEdits";

const EDITED_DESCRIPTION =
  "An edit of a Moolam passport, appended by the creator who holds the original. The service sent it from the creator's own wallet through the signer they granted, under a policy that allows nothing but this one call.";

/** An edit carries no generator agent: the person who holds the parent is the only author. */
const NO_AGENT = 0n;
const NO_GENERATOR_SIGNATURE = "0x" as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/**
 * How many edits run at once across the service.
 *
 * The same shape as the drawing gate: two in flight, and a caller who would queue longer than the
 * wait below is told the service is busy rather than holding a connection open on nothing.
 */
const MAX_CONCURRENT_EDITS = 2;
const MAX_GATE_WAIT_MS = 90_000;

/** How long the child passport stays valid. The send happens within seconds of the build. */
const DEADLINE_SECONDS = 30 * 60;

const titleSchema = z.string().trim().min(1).max(120);
const parentSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "parentId must be 0x followed by 64 hex characters");
const noteSchema = z.string().trim().max(280);

interface Upload {
  bytes: Buffer;
  title: string;
  parentId: Hex;
  note: string;
}

interface EditedImage {
  /** The bytes that get pinned, and whose sha256 becomes the child passport id. */
  bytes: Buffer;
  thumbnail: Buffer;
  print: Fingerprint;
  manifestHash: Hex;
  manifestDoc?: unknown;
  embedded: boolean;
  reason?: string;
}

interface EditContext {
  quota: ReturnType<typeof dailyQuota>;
  chain: ReturnType<typeof readClient>;
  registry: Hex;
}

/**
 * POST /edit: the owner of a passport appends an edited version of it without touching a passkey.
 *
 * The owner granted this app a signer on their own Privy wallet, scoped by a policy that allows
 * one function on one contract. So the browser uploads the edited picture and the service does the
 * rest: it prepares and pins the image the way /prepare does, builds the child passport that points
 * at the parent, and sends appendEdit from the owner's wallet with the app's authorization key,
 * gas sponsored by Privy. The owner stays the sender on chain, which is what the registry requires,
 * and this service never holds a key that could move their money.
 *
 * The wallet comes from the Privy user record, never from the request, and the ownership check is
 * read from the chain before anything is spent. Answers 401 for a missing or foreign token, 400 for
 * the fields, 413 and 415 for the image, 409 `no-signer` when the owner has granted nothing this
 * app can use, 404 `no-parent`, 403 `not-owner`, 429 `quota` past EDITS_PER_DAY, 502 `pin-failed`,
 * `sign-failed` or `send-failed`, and 503 `busy`.
 */
export async function editRoutes(app: FastifyInstance, options: { keys?: PrivyKeys } = {}): Promise<void> {
  const gate = waitingGate(MAX_CONCURRENT_EDITS, MAX_GATE_WAIT_MS);
  const quota = dailyQuota(env.EDITS_PER_DAY);
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;

  app.post("/edit", async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await identify(request, options.keys);
    if (identity === undefined) {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: /edit unauthorized");
      return reply.code(401).send({ error: "unauthorized" });
    }

    let upload: Upload;
    try {
      upload = await readEditUpload(request);
    } catch (error) {
      const status = statusOf(error);
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ ip: request.ip, url: request.url, status, reason }, "rejected: /edit");
      return reply.code(status).send({ error: reason });
    }

    try {
      await readImageHeader(upload.bytes);
    } catch (error) {
      const tooBig = error instanceof ImageTooLarge;
      const reason = error instanceof Error ? error.message : String(error);
      request.log.warn({ ip: request.ip, url: request.url, reason }, "rejected: /edit image");
      return reply.code(tooBig ? 413 : 415).send({ error: tooBig ? reason : "not-an-image" });
    }

    // Reading the upload is a network wait, so it happens before the gate. Everything past here
    // costs CPU, pins or a transaction, and that is what the gate holds back.
    try {
      return await gate(() => append(app, request, reply, identity, upload, { quota, chain, registry }));
    } catch (error) {
      if (error instanceof Busy) {
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /edit busy");
        return reply.code(503).send({ error: "busy" });
      }
      throw error;
    }
  });
}

/** Everything from the owner's wallet to the transaction hash, once a slot at the gate is free. */
async function append(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: PrivyIdentity,
  upload: Upload,
  context: EditContext,
): Promise<FastifyReply> {
  const client = privy();

  // The parent is checked first because it is the one claim in the request that costs nothing to
  // settle: a passport id nobody registered is wrong whoever is asking.
  if (!(await passportExists(context.chain, context.registry, upload.parentId))) {
    request.log.warn({ url: request.url, parent: upload.parentId }, "rejected: /edit unknown parent");
    return reply.code(404).send({ error: "no-parent" });
  }

  let wallet: OwnerWallet | undefined;
  try {
    wallet = await delegatedWallet(client, identity.userId);
  } catch (error) {
    // A user id this Privy app does not know has granted nothing, which is the same answer for the
    // browser as a user who never granted a signer: ask for one.
    if (error instanceof APIError && error.status === 404) {
      request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit unknown user");
      return reply.code(409).send({ error: "no-signer" });
    }
    request.log.error({ url: request.url, reason: privyErrorText(error) }, "rejected: /edit user lookup failed");
    return reply.code(502).send({ error: "sign-failed" });
  }
  if (wallet === undefined) {
    request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit no delegated wallet");
    return reply.code(409).send({ error: "no-signer" });
  }

  const granted = await walletSigners(client, wallet.id);
  const signer = granted.find((entry) => entry.signerId === env.PRIVY_EDIT_SIGNER_ID);
  if (signer === undefined) {
    request.log.warn(
      { url: request.url, user: identity.userId, signers: signerIds(granted).length },
      "rejected: /edit this app is not a signer on that wallet",
    );
    return reply.code(409).send({ error: "no-signer" });
  }
  if (!signer.policyIds.includes(env.PRIVY_EDIT_POLICY_ID as string)) {
    // A signer with no policy on it could do more than append an edit, and this service promises
    // it cannot, so the grant is refused until the browser asks again with the policy attached.
    request.log.warn(
      { url: request.url, user: identity.userId },
      "rejected: /edit signer granted without the edit policy",
    );
    return reply.code(409).send({ error: "no-signer" });
  }

  const owner = await parentOwner(context.chain, context.registry, upload.parentId);
  if (owner !== wallet.address) {
    request.log.warn(
      { url: request.url, parent: upload.parentId, user: identity.userId },
      "rejected: /edit caller does not hold the parent",
    );
    return reply.code(403).send({ error: "not-owner" });
  }

  const reservation = context.quota.take(identity.userId);
  if (!reservation.ok) {
    request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit quota");
    return reply.code(429).send({ error: "quota", quota: reservation.state });
  }

  const edited = await app.verifier.runPrepare(() => editedImage(upload.bytes, upload.title));
  if (!edited.embedded) {
    request.log.warn({ url: request.url, reason: edited.reason }, "edit: manifest not embedded");
  }

  const slug = fileSlug(upload.title, edited.print.sha256);
  let pinnedImage;
  let thumbnail;
  let pinnedMetadata;
  try {
    pinnedImage = await pinFile(edited.bytes, `${slug}.jpg`, "image/jpeg");
    thumbnail = await pinFile(edited.thumbnail, `${slug}-thumb.jpg`, "image/jpeg");
    const manifest =
      edited.manifestDoc === undefined ? undefined : await pinJson(edited.manifestDoc, `${slug}-c2pa.json`);

    pinnedMetadata = await pinJson(
      {
        ...passportMetadata({
          title: upload.title,
          description: EDITED_DESCRIPTION,
          image: pinnedImage.uri,
          thumbnail: thumbnail.uri,
          manifest: manifest?.uri,
          agentId: NO_AGENT,
          fingerprint: edited.print,
        }),
        // The chain records the parent id, and these two are the human readable half of the same
        // link: which passport this came from, and what the creator says they changed.
        parent: upload.parentId,
        edit: upload.note,
      },
      `${slug}.json`,
    );
  } catch (error) {
    // pinFile's message carries Pinata's status and its answer, and never the token.
    const reason = error instanceof Error ? error.message : String(error);
    request.log.error({ ip: request.ip, url: request.url, reason }, "rejected: /edit pin failed");
    return reply.code(502).send({ error: "pin-failed" });
  }

  const child: PassportInput = {
    exactHash: edited.print.sha256 as Hex,
    parentId: upload.parentId,
    creator: wallet.address,
    generatorAgentId: NO_AGENT,
    phash: edited.print.phash,
    blockhash256: edited.print.blockhash as Hex,
    manifestHash: edited.manifestHash,
    kind: Kind.Edited,
    fingerprintVersion: FINGERPRINT_VERSION,
    metadataURI: pinnedMetadata.uri,
    deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
  };

  let gasLimit: bigint;
  try {
    gasLimit = await estimateEditGas(context.chain, context.registry, wallet.address, child, NO_GENERATOR_SIGNATURE);
  } catch (error) {
    // The call ran against current state and was refused, so nothing was signed or broadcast.
    const name = revertName(error);
    const reason = error instanceof Error ? error.message : String(error);
    request.log.error({ url: request.url, reason: name ?? reason }, "rejected: /edit the registry refused");
    return reply.code(502).send({ error: "send-failed", reason: name ?? "the registry refused the edit" });
  }

  let sent;
  try {
    sent = await sendFromWallet(client, wallet.id, {
      to: context.registry,
      data: editCalldata(child, NO_GENERATOR_SIGNATURE),
      gasLimit,
      chainId: MONAD_CHAIN_ID,
      sponsor: true,
      context: ownerContext(),
    });
  } catch (error) {
    if (error instanceof SponsoredSendFailed || error instanceof SponsoredSendPending) {
      request.log.error({ url: request.url, reason: error.message }, "rejected: /edit send failed");
      return reply.code(502).send({ error: "send-failed", reason: error.message });
    }
    // privyErrorText is Privy's status, code and message. The authorization key is never in it.
    request.log.error({ url: request.url, reason: privyErrorText(error) }, "rejected: /edit sign failed");
    return reply.code(502).send({ error: "sign-failed" });
  }

  request.log.info(
    { user: identity.userId, parent: upload.parentId, child: child.exactHash, hash: sent.hash },
    "edit: appended",
  );

  return reply.send({
    child: {
      exactHash: child.exactHash,
      parentId: child.parentId,
      creator: child.creator,
      generatorAgentId: child.generatorAgentId.toString(),
      phash: child.phash.toString(),
      blockhash256: child.blockhash256,
      manifestHash: child.manifestHash,
      kind: child.kind,
      fingerprintVersion: child.fingerprintVersion,
      metadataURI: child.metadataURI,
      deadline: child.deadline.toString(),
    },
    tokenId: tokenIdOf(child.exactHash).toString(),
    hash: sent.hash,
    sponsored: sent.sponsored,
    image: {
      cid: pinnedImage.cid,
      uri: pinnedImage.uri,
      gatewayUrl: gatewayUrl(pinnedImage.uri),
      bytes: edited.bytes.length,
      width: edited.print.width,
      height: edited.print.height,
    },
    thumbnail: { cid: thumbnail.cid, uri: thumbnail.uri, gatewayUrl: gatewayUrl(thumbnail.uri) },
    metadata: { cid: pinnedMetadata.cid, uri: pinnedMetadata.uri },
    manifest: edited.embedded ? { embedded: true } : { embedded: false, reason: edited.reason },
    quota: context.quota.state(identity.userId),
  });
}

/**
 * Prepares the edited picture for pinning, with the manifest when C2PA will sign it and without
 * when it will not.
 *
 * The action is c2pa.edited rather than c2pa.created, which is the one place inside the file that
 * says this picture is a change to another one. The parent id itself lives on chain and in the
 * pinned metadata, because the manifest builder here takes no field to put it in.
 */
async function editedImage(bytes: Buffer, title: string): Promise<EditedImage> {
  try {
    const prepared = await prepareImage(bytes, {
      title,
      claimGenerator: CLAIM_GENERATOR,
      action: "c2pa.edited",
      digitalSourceType: EDITED_SOURCE_TYPE,
    });
    return {
      bytes: prepared.original,
      thumbnail: prepared.thumbnail,
      print: prepared.fingerprint,
      manifestHash: prepared.manifestHash,
      manifestDoc: manifestDocument(prepared),
      embedded: true,
    };
  } catch (error) {
    const upright = await uprightImage(bytes);
    return {
      bytes: upright,
      thumbnail: await makeThumbnail(upright),
      print: await fingerprint(upright),
      manifestHash: ZERO_BYTES32,
      embedded: false,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    };
  }
}

/**
 * Reads the image and the three text fields out of the multipart body, in whatever order the
 * browser sent them.
 *
 * Throws BadRequest: 413 over the byte limit, 400 for a missing file, a file part under another
 * name, a title outside 1 to 120 characters, a parent id that is not 32 bytes of hex, or a note
 * longer than 280 characters.
 */
async function readEditUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  let bytes: Buffer | undefined;
  const fields = new Map<string, string>();

  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
      if (part.type === "file") {
        if (part.fieldname !== "file") {
          throw new BadRequest(`expected a multipart field named "file", got "${part.fieldname}"`);
        }
        bytes = await part.toBuffer();
      } else if (typeof part.value === "string") {
        fields.set(part.fieldname, part.value);
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new BadRequest(`the image is larger than the ${MAX_UPLOAD_BYTES} byte limit`, 413);
    }
    throw error;
  }

  if (bytes === undefined || bytes.length === 0) {
    throw new BadRequest('send the image in a multipart field named "file"');
  }

  const title = titleSchema.safeParse(fields.get("title"));
  if (!title.success) {
    throw new BadRequest('send a "title" field of 1 to 120 characters');
  }
  const parentId = parentSchema.safeParse(fields.get("parentId"));
  if (!parentId.success) {
    throw new BadRequest('send a "parentId" field of 0x followed by 64 hex characters');
  }
  const note = noteSchema.safeParse(fields.get("note") ?? "");
  if (!note.success) {
    throw new BadRequest('send a "note" field of up to 280 characters saying what changed');
  }

  return { bytes, title: title.data, parentId: parentId.data.toLowerCase() as Hex, note: note.data };
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
