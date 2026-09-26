import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, toEventSelector } from "viem";
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
  type ReceiptLog,
} from "../edit/send.js";
import { delegatedWallets, signerIds, walletSigners, type OwnerWallet, type WalletSigner } from "../edit/signers.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { FingerprintFault, ImageTooLarge, readImageHeader, type Hex } from "../fingerprint.js";
import { Kind, type PassportInput } from "../generate/eip712.js";
import { Busy } from "../generate/gate.js";
import { ownerContext, privy, privyErrorText } from "../generate/privy.js";
import { dailyQuota } from "../generate/quota.js";
import { gatewayUrl, pinFile, pinJson } from "../ipfs/pinata.js";
import { takeToday } from "../limits/dayGate.js";
import { refusedByPinata } from "../sealed.js";
import { FINGERPRINT_VERSION, fileSlug, passportMetadata } from "../metadata.js";
import {
  EDIT_THUMBNAIL_TOO_LARGE_REASON,
  FINGERPRINT_UNSTABLE_REASON,
  FingerprintUnstable,
  SIGNED_FILE_TOO_LARGE_REASON,
  ThumbnailTooLarge,
  assertStableFingerprint,
  prepareOrFallback,
  type PreparedResult,
} from "../prepare.js";
import { MONAD_CHAIN_ID, readClient } from "../reputation/registry.js";
import { BadRequest, SERVICE_FAULT_REASON, statusOf } from "./shared.js";

/** What the C2PA manifest records as the tool that made the claim. */
const CLAIM_GENERATOR = "moolam-studio/0.1.0";

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
 * that holds the parent. The creator's own daily allowance is taken once the request is known to
 * be worth serving and given back whenever the edit fails before Privy was asked to send; the
 * day's ceiling for everyone goes back only when the request pinned nothing and sent nothing.
 *
 * Every answer that leaves a transaction out on the network carries `passportId`, the child's own
 * id, so the browser can watch the registry for that one passport instead of guessing which edit
 * under the parent is theirs.
 *
 * Answers 401 for a missing or foreign token, 400 for the fields, 413 and 415 for the image, 413
 * `signed-file-too-large` when signing grew the file past the upload cap, 409
 * `no-signer` when the owner has granted nothing this app can use, 409 `already-registered` when
 * the child is on chain already, 404 `no-parent`, 403 `not-owner`, 429 `quota` past EDITS_PER_DAY
 * and 429 `global-limit` once GLOBAL_EDITS_PER_DAY is spent for everyone,
 * 502 `pin-failed`, `sign-failed`, `send-failed`, `send-pending`, `privy-unavailable` or
 * `chain-unavailable`, 422 `thumbnail-too-large` for a picture too detailed for the Chainlink
 * fetch budget, 422 `fingerprint-unstable` when the picture's own thumbnail is further from its
 * pHash than the match threshold, 503 `busy`, and 503 `service-fault` with the sentence /verify
 * uses when this service, not the picture, failed while fingerprinting it. The two 413s, both 422s
 * and the service fault pin nothing and send nothing, so both allowances come back.
 */
export async function editRoutes(app: FastifyInstance, options: { keys?: PrivyKeys } = {}): Promise<void> {
  const quota = dailyQuota(env.EDITS_PER_DAY);
  const chain = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;

  app.post("/edit", async (request: FastifyRequest, reply: FastifyReply) => {
    // The one long wait in this route is the prepare gate, and a creator who closed the tab while
    // waiting must not be charged a slot or have a transaction sent on their behalf. The request
    // stream is no guide: Node closes it as soon as its body has been read, with the caller still
    // waiting. The connection is: the response closing before it finished, or the socket going.
    let hungUp = false;
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        hungUp = true;
      }
    });
    const gone = (): boolean => hungUp || request.raw.socket?.destroyed === true;

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
      if (error instanceof FingerprintFault) {
        request.log.error(
          { url: request.url, reason: error.message },
          "rejected: /edit the service failed reading the image",
        );
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
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
 * The checks that cost nothing come first, then the creator's own allowance, then the day's
 * ceiling for everyone, and only then the work. Only the decode sits
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

  // The day's ceiling for everyone, asked last of the three checks and before a pin or a sponsored
  // send. A ceiling that is not this creator's fault must not eat their own allowance, so their
  // slot goes back before the refusal is written.
  const today = takeToday(app, request, reply, "edits", () => {
    context.quota.release(identity.userId, ticket);
  });
  if (!today.ok) {
    return today.refused;
  }

  // Two flags, because the two allowances answer different questions. The creator's own is about
  // what they got: it goes back unless Privy was asked to send, because until then no edit of
  // theirs can be on chain. The day's ceiling is about what the world spent: it goes back only
  // when this request spent nothing at all, and a pin that landed is money spent whether or not
  // the edit ever reached the chain.
  let submitted = false;
  let pinned = false;
  try {
    let edited: PreparedResult;
    try {
      // The holder says this is an edit of their passport, and that is all Moolam knows about how
      // it was made, so the manifest records the file opened and edited with no source type
      // (review pass 4, V22).
      // The edit is judged by the thumbnail the runner's re-check will hash, exactly as /prepare
      // judges an upload, because this route pins and sends the edit itself (review pass 6,
      // intake 2).
      edited = await app.verifier.runPrepare(async () => {
        const prepared = await prepareOrFallback(upload.bytes, {
          title: upload.title,
          claimGenerator: CLAIM_GENERATOR,
          action: "c2pa.edited",
        });
        await assertStableFingerprint(prepared.print.phash, prepared.thumbnail);
        return prepared;
      });
    } catch (error) {
      if (error instanceof FingerprintUnstable) {
        request.log.warn({ url: request.url, distance: error.distance }, "rejected: /edit fingerprint unstable");
        return reply.code(422).send({
          error: "fingerprint-unstable",
          limit: error.limit,
          distance: error.distance,
          reason: FINGERPRINT_UNSTABLE_REASON,
        });
      }
      if (error instanceof Busy) {
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /edit busy");
        return reply.code(503).send({ error: "busy" });
      }
      // This service failed to fingerprint a picture it could read, so the file is not to blame
      // (review pass 6, answers 7). Nothing was pinned or sent, so both slots come back.
      if (error instanceof FingerprintFault) {
        request.log.error(
          { url: request.url, reason: error.message },
          "rejected: /edit the service failed fingerprinting",
        );
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      if (error instanceof SignerUnavailable) {
        request.log.error({ url: request.url, reason: error.message }, "rejected: /edit the signer is down");
        return reply.code(502).send({ error: "sign-failed" });
      }
      // A real picture with too much detail for the Chainlink fetch budget, not a file that failed
      // to decode (review pass 5, intake 4). Nothing was pinned or sent, so both slots come back.
      if (error instanceof ThumbnailTooLarge) {
        request.log.warn({ url: request.url, reason: error.message }, "rejected: /edit thumbnail too large");
        return reply
          .code(422)
          .send({ error: "thumbnail-too-large", limit: error.limit, reason: EDIT_THUMBNAIL_TOO_LARGE_REASON });
      }
      // readImageHeader passes on a file whose header is intact and whose pixels are not, so a
      // truncated upload only fails here. That is the caller's file, not this service breaking.
      request.log.warn({ url: request.url, reason: reasonOf(error) }, "rejected: /edit undecodable image");
      return reply.code(415).send({ error: "not-an-image", reason: UNDECODABLE });
    }

    // Signing can re-encode at quality 95 and adds the manifest store, so an upload under the cap
    // can come out over it, and /verify could never take the registered file back (review pass 6,
    // intake 3). Refused before the duplicate read and before anything is pinned.
    if (edited.bytes.length > MAX_UPLOAD_BYTES) {
      request.log.warn({ url: request.url, bytes: edited.bytes.length }, "rejected: /edit signed file over the upload cap");
      return reply
        .code(413)
        .send({ error: "signed-file-too-large", limit: MAX_UPLOAD_BYTES, reason: SIGNED_FILE_TOO_LARGE_REASON });
    }

    if (!edited.embedded) {
      request.log.warn({ url: request.url, reason: edited.detail }, "edit: manifest not embedded");
    }

    // The child's id is the hash of the bytes about to be pinned, so it is known before the pins
    // and before the send, and every answer from here down can name it.
    const passportId = edited.print.sha256 as Hex;
    if (await alreadyRegistered(context, passportId, request)) {
      // The signed path cannot produce a duplicate, because the registry refuses one and the gas
      // estimate would catch it. The unsigned fallback can, and a pin of a picture that can never
      // be registered is money spent for nothing, so the read comes first.
      request.log.warn({ url: request.url, user: identity.userId, passportId }, "rejected: /edit duplicate");
      return reply.code(409).send({ error: "already-registered", passportId });
    }

    const slug = fileSlug(upload.title, edited.print.sha256);
    // The picture, its thumbnail and the manifest document do not depend on each other, so they go
    // to Pinata at once rather than one after the next. Settled rather than raced, because a
    // failure still has to say what did land: a pin that succeeded is paid for, and that is what
    // decides whether this request keeps the day's slot.
    const [imagePin, thumbnailPin, manifestPin] = await Promise.allSettled([
      pinFile(edited.bytes, `${slug}.jpg`, "image/jpeg"),
      pinFile(edited.thumbnail, `${slug}-thumb.jpg`, "image/jpeg"),
      edited.manifestDoc === undefined ? Promise.resolve(undefined) : pinJson(edited.manifestDoc, `${slug}-c2pa.json`),
    ]);
    const attempted = [imagePin, thumbnailPin, manifestPin];
    // A pin that failed after its bytes left this process may still have stored them, so only
    // Pinata's own refusal, or a request never sent, counts as nothing landed (review pass 6,
    // intake 4). The rule is the one the private copy follows.
    pinned = attempted.some((one) =>
      one.status === "fulfilled" ? one.value !== undefined : !refusedByPinata(one.reason),
    );

    if (imagePin.status === "rejected" || thumbnailPin.status === "rejected" || manifestPin.status === "rejected") {
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
        "rejected: /edit pin failed",
      );
      return reply.code(502).send({ error: "pin-failed" });
    }

    const pinnedImage = imagePin.value;
    const thumbnail = thumbnailPin.value;
    let pinnedMetadata;
    try {
      pinnedMetadata = await pinJson(
        {
          ...passportMetadata({
            title: upload.title,
            description: EDITED_DESCRIPTION,
            image: pinnedImage.uri,
            thumbnail: thumbnail.uri,
            manifest: manifestPin.value?.uri,
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
      request.log.error(
        { ip: request.ip, url: request.url, reason: reasonOf(error) },
        "rejected: /edit metadata pin failed",
      );
      return reply.code(502).send({ error: "pin-failed" });
    }

    const child: PassportInput = {
      exactHash: passportId,
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
        return reply.code(502).send({ error: "send-pending", transactionId: error.transactionId, passportId });
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
      return reply
        .code(502)
        .send({ error: "send-pending", transactionId: sent.transactionId, hash: sent.hash, passportId });
    }
    if (receipt === undefined) {
      request.log.error({ url: request.url, hash: sent.hash }, "rejected: /edit no receipt in time");
      return reply
        .code(502)
        .send({ error: "send-pending", transactionId: sent.transactionId, hash: sent.hash, passportId });
    }
    if (receipt.status === "reverted") {
      request.log.error(
        { url: request.url, hash: sent.hash, reason: receipt.reason },
        "rejected: /edit the chain reverted the edit",
      );
      return reply.code(502).send({ error: "send-failed", reason: receipt.reason ?? "reverted" });
    }
    // A sponsored send is a user operation inside a bundle, and the bundle succeeds even when the
    // appendEdit inside it reverted. The registry's own event for this child is the only proof the
    // edit was written.
    if (!childRegistered(receipt.logs, context.registry, passportId)) {
      request.log.error(
        { url: request.url, hash: sent.hash, passportId },
        "rejected: /edit the transaction landed and the registry wrote no child",
      );
      return reply.code(502).send({
        error: "send-failed",
        reason: "the user operation reverted: the transaction landed and the registry wrote no passport for this edit",
        passportId,
        hash: sent.hash,
      });
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
    if (!submitted) {
      context.quota.release(identity.userId, ticket);
    }
    // An edit that pinned and then failed on the gas estimate or the send still spent four files
    // of somebody's Pinata plan. Handing the day's slot back there would let one bad afternoon at
    // a provider spend the whole budget twice over while /health reported nothing used.
    if (!submitted && !pinned) {
      today.slot.giveBack();
    }
  }
}

/** The registry's event for a new passport, whose first indexed topic is the passport id. */
const PASSPORT_REGISTERED = toEventSelector(
  "PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
);

/**
 * Whether a receipt carries the registry's PassportRegistered event for this passport. The address
 * and the id are compared after the same normaliser on both sides: getAddress for the contract, and
 * lower case hex for the topic.
 */
function childRegistered(logs: readonly ReceiptLog[] | undefined, registry: Hex, passportId: Hex): boolean {
  const contract = getAddress(registry);
  const id = passportId.toLowerCase();
  return (logs ?? []).some((log) => {
    let from: string;
    try {
      from = getAddress(log.address);
    } catch {
      return false;
    }
    return from === contract && log.topics[0]?.toLowerCase() === PASSPORT_REGISTERED && log.topics[1]?.toLowerCase() === id;
  });
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

/**
 * Whether the registry already holds this exact picture.
 *
 * A chain that will not answer is not a duplicate: the send that follows runs a gas estimate
 * against current state and the registry refuses a second registration itself, so a missed read
 * here costs a pin at worst and never a wrong refusal.
 */
async function alreadyRegistered(context: EditContext, passportId: Hex, request: FastifyRequest): Promise<boolean> {
  try {
    return await passportExists(context.chain, context.registry, passportId);
  } catch (error) {
    request.log.warn(
      { url: request.url, reason: reasonOf(error) },
      "edit: the duplicate check could not reach the chain",
    );
    return false;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
