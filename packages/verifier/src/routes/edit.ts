import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { SignerUnavailable } from "../c2pa.js";
import {
  editCalldata,
  estimateEditGas,
  parentOwner,
  passportExists,
  revertName,
  tokenIdOf,
} from "../edit/registry.js";
import {
  RECEIPT_WAIT_MS,
  SponsoredSendFailed,
  SponsoredSendPending,
  awaitReceipt,
  sendFromWallet,
} from "../edit/send.js";
import { delegatedWallets, signerIds, walletSigners, type OwnerWallet, type WalletSigner } from "../edit/signers.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { ImageTooLarge, readImageHeader, type Hex } from "../fingerprint.js";
import { Kind, type PassportInput } from "../generate/eip712.js";
import { Busy } from "../generate/gate.js";
import { ownerContext, privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import { FINGERPRINT_VERSION, fileSlug, passportMetadata } from "../metadata.js";
import { prepareOrFallback, type PreparedResult } from "../prepare.js";
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

/** How long the child passport stays valid. The send happens within seconds of the build. */
const DEADLINE_SECONDS = 30 * 60;

/** The header parsed, so this is a real picture, but the pixels behind it did not decode. */
const UNDECODABLE = "the file could not be decoded";

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
 * read from the chain before anything is spent. A creator with two embedded wallets gets the one
 * that holds the parent. The daily allowance is taken once the request is known to be worth
 * serving and given back whenever the edit fails before Privy was asked to send.
 *
 * Answers 401 for a missing or foreign token, 400 for the fields, 413 and 415 for the image, 409
 * `no-signer` when the owner has granted nothing this app can use, 404 `no-parent`, 403
 * `not-owner`, 429 `quota` past EDITS_PER_DAY, 502 `pin-failed`, `sign-failed`, `send-failed`,
 * `send-pending`, `privy-unavailable` or `chain-unavailable`, and 503 `busy`.
 */
export async function editRoutes(app: FastifyInstance, options: { keys?: PrivyKeys } = {}): Promise<void> {
  const quota = dailyQuota(env.EDITS_PER_DAY);
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;

  app.post("/edit", async (request: FastifyRequest, reply: FastifyReply) => {
    // The one long wait in this route is the prepare gate, and a creator who closed the tab while
    // waiting must not be charged a slot or have a transaction sent on their behalf.
    let closed = request.raw.destroyed === true;
    request.raw.once("close", () => {
      closed = true;
    });
    const gone = (): boolean => closed || request.raw.destroyed === true;

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

    return await append(app, request, reply, identity, upload, { quota, chain, registry }, gone);
  });
}

/**
 * Everything from the owner's wallet to the transaction the chain settled.
 *
 * The checks that cost nothing come first, then the allowance, then the work. Only the decode sits
 * behind the shared prepare gate: holding a slot across the pins and the send would park two
 * creators behind one slow network call each.
 */
async function append(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: PrivyIdentity,
  upload: Upload,
  context: EditContext,
  gone: () => boolean,
): Promise<FastifyReply> {
  const client = privy();

  // The parent is checked first because it is the one claim in the request that costs nothing to
  // settle: a passport id nobody registered is wrong whoever is asking.
  let known: boolean;
  try {
    known = await passportExists(context.chain, context.registry, upload.parentId);
  } catch (error) {
    request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /edit the chain did not answer");
    return reply.code(502).send({ error: "chain-unavailable" });
  }
  if (!known) {
    request.log.warn({ url: request.url, parent: upload.parentId }, "rejected: /edit unknown parent");
    return reply.code(404).send({ error: "no-parent" });
  }

  let wallets: OwnerWallet[];
  try {
    wallets = await delegatedWallets(client, identity.userId);
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
  if (wallets.length === 0) {
    request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit no delegated wallet");
    return reply.code(409).send({ error: "no-signer" });
  }

  let owner: Hex;
  try {
    owner = await parentOwner(context.chain, context.registry, upload.parentId);
  } catch (error) {
    request.log.error({ url: request.url, reason: reasonOf(error) }, "rejected: /edit the chain did not answer");
    return reply.code(502).send({ error: "chain-unavailable" });
  }

  // A creator can hold more than one embedded wallet, and the parent belongs to exactly one of
  // them, so the wallet is chosen by the address on chain rather than by being listed first.
  const wallet = wallets.find((candidate) => candidate.address === owner);
  if (wallet === undefined) {
    request.log.warn(
      { url: request.url, parent: upload.parentId, user: identity.userId, wallets: wallets.length },
      "rejected: /edit caller does not hold the parent",
    );
    return reply.code(403).send({ error: "not-owner" });
  }

  let granted: WalletSigner[];
  try {
    granted = await walletSigners(client, wallet.id);
  } catch (error) {
    if (error instanceof APIError && error.status === 404) {
      request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit unknown wallet");
      return reply.code(409).send({ error: "no-signer" });
    }
    request.log.error({ url: request.url, reason: privyErrorText(error) }, "rejected: /edit Privy did not answer");
    return reply.code(502).send({ error: "privy-unavailable" });
  }

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

  if (gone()) {
    request.log.warn({ url: request.url, user: identity.userId }, "/edit: the caller left before the work began");
    return reply.code(499).send({ error: "client-gone" });
  }

  const reservation = context.quota.take(identity.userId);
  if (!reservation.ok || reservation.ticket === undefined) {
    request.log.warn({ url: request.url, user: identity.userId }, "rejected: /edit quota");
    return reply.code(429).send({ error: "quota", quota: reservation.state });
  }
  const ticket = reservation.ticket;

  // Past here the allowance is spent unless it is given back, and the flag says when it must not
  // be: once Privy has been asked to send, the edit may be on chain whatever this answer says.
  let submitted = false;
  try {
    let edited: PreparedResult;
    try {
      edited = await app.verifier.runPrepare(() =>
        prepareOrFallback(upload.bytes, {
          title: upload.title,
          claimGenerator: CLAIM_GENERATOR,
          action: "c2pa.edited",
          digitalSourceType: EDITED_SOURCE_TYPE,
        }),
      );
    } catch (error) {
      if (error instanceof Busy) {
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /edit busy");
        return reply.code(503).send({ error: "busy" });
      }
      if (error instanceof SignerUnavailable) {
        request.log.error({ url: request.url, reason: error.message }, "rejected: /edit the signer is down");
        return reply.code(502).send({ error: "sign-failed" });
      }
      // readImageHeader passes on a file whose header is intact and whose pixels are not, so a
      // truncated upload only fails here. That is the caller's file, not this service breaking.
      request.log.warn({ url: request.url, reason: reasonOf(error) }, "rejected: /edit undecodable image");
      return reply.code(415).send({ error: "not-an-image", reason: UNDECODABLE });
    }

    if (!edited.embedded) {
      request.log.warn({ url: request.url, reason: edited.detail }, "edit: manifest not embedded");
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
      request.log.error(
        { url: request.url, reason: name ?? reasonOf(error) },
        "rejected: /edit the registry refused",
      );
      return reply.code(502).send({ error: "send-failed", reason: name ?? "the registry refused the edit" });
    }

    if (gone()) {
      request.log.warn({ url: request.url, user: identity.userId }, "/edit: the caller left before the send");
      return reply.code(499).send({ error: "client-gone" });
    }

    let sent;
    try {
      submitted = true;
      sent = await sendFromWallet(client, wallet.id, {
        to: context.registry,
        data: editCalldata(child, NO_GENERATOR_SIGNATURE),
        gasLimit,
        chainId: MONAD_CHAIN_ID,
        sponsor: true,
        context: ownerContext(),
        log: request.log,
      });
    } catch (error) {
      if (error instanceof SponsoredSendPending) {
        // The send may still land, so the browser is told to check rather than to send again.
        request.log.error(
          { url: request.url, transactionId: error.transactionId },
          "rejected: /edit the send had no hash in time",
        );
        return reply.code(502).send({ error: "send-pending", transactionId: error.transactionId });
      }
      if (error instanceof SponsoredSendFailed) {
        request.log.error({ url: request.url, reason: error.message }, "rejected: /edit send failed");
        return reply.code(502).send({ error: "send-failed", reason: error.message });
      }
      // privyErrorText is Privy's status, code and message. The authorization key is never in it.
      request.log.error({ url: request.url, reason: privyErrorText(error) }, "rejected: /edit sign failed");
      return reply.code(502).send({ error: "sign-failed" });
    }

    // A hash says Privy broadcast it, not that the chain kept it, and this route is what the
    // browser believes, so the receipt is read before the edit is called done.
    let receipt;
    try {
      receipt = await awaitReceipt(context.chain, sent.hash, RECEIPT_WAIT_MS);
    } catch (error) {
      request.log.error(
        { url: request.url, hash: sent.hash, reason: reasonOf(error) },
        "rejected: /edit the receipt could not be read",
      );
      return reply.code(502).send({ error: "send-pending", transactionId: sent.transactionId, hash: sent.hash });
    }
    if (receipt === undefined) {
      request.log.error({ url: request.url, hash: sent.hash }, "rejected: /edit no receipt in time");
      return reply.code(502).send({ error: "send-pending", transactionId: sent.transactionId, hash: sent.hash });
    }
    if (receipt.status === "reverted") {
      request.log.error(
        { url: request.url, hash: sent.hash, reason: receipt.reason },
        "rejected: /edit the chain reverted the edit",
      );
      return reply.code(502).send({ error: "send-failed", reason: receipt.reason ?? "reverted" });
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
  } finally {
    if (!submitted) context.quota.release(identity.userId, ticket);
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
