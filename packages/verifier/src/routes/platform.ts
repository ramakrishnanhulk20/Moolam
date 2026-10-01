import { createHash, timingSafeEqual } from "node:crypto";
import { APIError } from "@privy-io/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { InvalidToken, bearerToken, verifyPrivyToken, type PrivyIdentity, type PrivyKeys } from "../auth/privy.js";
import { embeddedWallets } from "../auth/wallet.js";
import { SignerUnavailable } from "../c2pa.js";
import { trainingStatement } from "../consent.js";
import { MAX_UPLOAD_BYTES, env } from "../env.js";
import { FingerprintFault, ImageTooLarge, readImageHeader } from "../fingerprint.js";
import { Busy } from "../generate/gate.js";
import { privy, privyErrorText } from "../generate/privy.js";
import { gatewayUrl } from "../ipfs/pinata.js";
import { dayLimitRefusal } from "../limits/globalDay.js";
import { lookalikeBeforeSigning, pairsOf, type LookalikeAnswer } from "../lookalike/presign.js";
import type { FingerprintPair } from "../lookalike/search.js";
import { AGENT_IDENTITY_REGISTRY, AI_SOURCE_TYPE, FINGERPRINT_VERSION, fileSlug, passportMetadata } from "../metadata.js";
import { safeReason } from "../net/errorText.js";
import { liveChain, type PlatformChain } from "../platform/chain.js";
import { FILE_ROLES, buildFileSet, ipfsUri, pinFileSet, type FileEntry, type FileRole } from "../platform/files.js";
import { platformForKey, looksLikePlatformKey } from "../platform/key.js";
import {
  FrozenFileChanged,
  PendingFull,
  expiredFrom,
  handleHash,
  isHandle,
  newHandle,
  type PendingRecord,
  type PendingStore,
} from "../platform/pending.js";
import {
  SIGNATURE_WINDOW_SECONDS,
  fieldsDigest,
  passportAnswer,
  passportInput,
  registryDomain,
  signingDigest,
  type PassportFields,
} from "../platform/passport.js";
import {
  MODE,
  PREPARE_WINDOW_SECONDS,
  issuedAtProblem,
  prepareDigest,
  signedByAddress,
} from "../platform/signatures.js";
import { DEFAULT_PLATFORM_LIMITS, platformStores, type PlatformLimits } from "../platform/stores.js";
import { crossedField, readPlatformUpload, type PlatformUpload } from "../platform/upload.js";
import type { Platform } from "../platforms/platforms.js";
import {
  FINGERPRINT_UNSTABLE_REASON,
  FingerprintUnstable,
  THUMBNAIL_TOO_LARGE_REASON,
  ThumbnailTooLarge,
  assertStableFingerprint,
  prepareOrFallback,
  type PreparedResult,
} from "../prepare.js";
import { readClient } from "../reputation/registry.js";
import { registrationOf, signedFile, type SignedFile } from "../sealed.js";
import { deliverable, readDeliverTo, type ClaimService, type ClaimSetup } from "../claims/service.js";
import {
  ClaimStoreClosed,
  isTicketId,
  markFailed,
  standingFor,
  writeProblem,
  writeTicket,
  type Ticket,
  type VerifiedBy,
} from "../claims/store.js";
import { CallerGone, SERVICE_FAULT_REASON, givesUploadsBack, statusOf, studioTurn } from "./shared.js";
import { presignReads, type PresignOptions } from "./prepare.js";

/**
 * The most tickets one deliveries answer names. A platform's worker sends at most once per entry
 * per poll, so this bounds the gas one poll can spend (P34); the rest come on the next poll.
 */
const MAX_DELIVERIES = 32;

/** The accepted tickets read against the chain per poll, oldest first, to find MAX_DELIVERIES still held. */
const DELIVERY_CANDIDATES = 64;

/** ownerOf reads in flight at once for one deliveries poll. */
const DELIVERY_READS_AT_ONCE = 8;

/** A prepare's deliverTo, once read: the email's hash under the pepper and the platform's word for how it checked it. */
interface Delivery {
  emailHash: string;
  verifiedBy: VerifiedBy;
}

/** What the C2PA manifest records as the tool that made the claim: Moolam, never the platform. */
const CLAIM_GENERATOR = "moolam-platform-kit/0.1.0";

/**
 * The C2PA namespace a platform's agent is named under inside softwareAgent: the reverse-domain form
 * of moolam.vercel.app, the one the signed and validated test in the research used. It is written
 * into every manifest for good, so it changes only with a Moolam domain of its own.
 */
const AGENT_NAMESPACE = "app.vercel.moolam.erc8004";

/** The ERC-8004 identity registry as a CAIP-10 address on Monad mainnet. */
const AGENT_REGISTRY_CAIP = `eip155:143:${AGENT_IDENTITY_REGISTRY}`;

/** How long a co-sign link waits for its person to open it, read against chain time. */
const OPEN_WINDOW_SECONDS = 30n * 60n;

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const signBodySchema = z.strictObject({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });

/**
 * What the pinned metadata says a platform picture is. It says that the key bound to the creator
 * wallet signed, which is true of a server key and of a phone alike (P15), and never more.
 */
function platformDescription(platform: Platform): string {
  return `An image made by ${platform.name}'s generator, ERC-8004 agent ${platform.agentId}, and registered through the Moolam platform kit. The agent's owner signed this fingerprint, and the key bound to the creator wallet signed it, before the registry would write the record.`;
}

export interface PlatformRouteOptions {
  /** The loaded, signature-checked platform list. */
  platforms: readonly Platform[];
  keys?: PrivyKeys;
  /** Where the platform state lives. Left out, it is the data folder's named files. */
  dir?: string;
  limits?: Partial<PlatformLimits>;
  /** The claim service a prepare's deliverTo and the deliveries routes use, or why it is closed. */
  claims?: ClaimSetup;
  /** Replaces the title read behind the look-alike warning, for tests. */
  lookalike?: Pick<PresignOptions, "titleOf">;
}

/**
 * The platform routes: an outside image generator holding a Moolam key turns a picture its agent
 * made into passport fields, either to register itself (platform mode) or for a person to co-sign on
 * a Moolam page (co-sign mode).
 *
 * The key only identifies and meters a platform. What authorises a manifest naming the platform's
 * agent is the agent owner's own EIP-712 PlatformPrepare signature, recovered against ownerOf(agentId)
 * read at that moment (P19). Every window is read against chain time (P12). The handle routes answer
 * with `no-store`, are logged by nothing that could carry their URL, and compare every handle in
 * constant time (P4).
 *
 * Both prepare answers carry `lookalike`, the same four states the studio's /prepare answers
 * (L19, L20), judged against the platform's own wallet in platform mode and against nobody in
 * co-sign mode, where the creator is not known until the link is opened.
 */
export async function platformRoutes(app: FastifyInstance, options: PlatformRouteOptions): Promise<void> {
  const chain: PlatformChain = liveChain();
  const registryRead = readClient();
  const registry = env.MOOLAM_REGISTRY_ADDRESS as Hex;
  const dom = registryDomain();
  const { titleOf } = presignReads(options.lookalike);
  const limits: PlatformLimits = { ...DEFAULT_PLATFORM_LIMITS, ...options.limits };
  const stores = platformStores(options.dir, limits, dom, (line) => {
    app.log.warn(line);
  });
  /** Handles being signed right now, by their record's hash, so one record is never pinned twice at once. */
  const signing = new Set<string>();
  /** The open claim service, or undefined when the claim routes are closed on this host. */
  const claimService = (): ClaimService | undefined => (options.claims?.open === true ? options.claims.service : undefined);
  /** Chain time now, or `earlier` when the chain cannot be read: an older time only makes a deadline sooner. */
  const chainTimeOr = async (earlier: bigint): Promise<bigint> => {
    try {
      return await chain.now();
    } catch {
      return earlier;
    }
  };

  // Encapsulated in this plugin, so it reaches these routes only, the rate limiter's 429 included.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.post(
    "/platform/prepare",
    givesUploadsBack(async (request: FastifyRequest, reply: FastifyReply) => {
      const platform = platformForKey(request.headers.authorization, options.platforms, wallClock());
      if (platform === undefined) {
        request.log.warn({ ip: request.ip }, "rejected: /platform/prepare no valid platform key");
        return reply.code(401).send({ error: "unauthorized" });
      }

      let upload: PlatformUpload;
      try {
        upload = await readPlatformUpload(request);
      } catch (error) {
        const status = statusOf(error);
        const reason = safeReason(error);
        request.log.warn({ ip: request.ip, status, reason }, "rejected: /platform/prepare");
        return reply.code(status).send({ error: reason });
      }

      const crossed = crossedField(upload, platform);
      if (crossed !== null) {
        request.log.warn({ platform: platform.name, field: crossed }, "rejected: /platform/prepare names another identity");
        return reply.code(403).send({
          error: "platform-mismatch",
          field: crossed,
          reason:
            upload.mode === "cosign" && crossed !== "agentId"
              ? "in co-sign mode the creator is the person who opens the link, so a prepare names none"
              : "a platform prepare may only repeat the creator wallet and agent its key was listed with",
        });
      }
      // Read and hashed before anything is spent, and refused with the field's name only: the value
      // is an email address and goes into no answer and no log line (P29).
      let delivery: Delivery | undefined;
      if (upload.deliverTo !== undefined) {
        const claims = claimService();
        if (upload.mode !== "platform") {
          request.log.warn({ platform: platform.name, field: "deliverTo" }, "rejected: /platform/prepare deliverTo outside platform mode");
          return reply.code(400).send({ error: "deliverTo" });
        }
        if (claims === undefined) {
          request.log.warn({ platform: platform.name }, "rejected: /platform/prepare deliverTo while the claim routes are closed");
          return reply.code(503).send({ error: "claims-unavailable" });
        }
        const read = readDeliverTo(upload.deliverTo, claims.pepper);
        if (read === null) {
          request.log.warn({ platform: platform.name, field: "deliverTo" }, "rejected: /platform/prepare deliverTo");
          return reply.code(400).send({ error: "deliverTo" });
        }
        delivery = read;
      }
      if (upload.mode === "cosign" && stores.pending === undefined) {
        request.log.error({ platform: platform.name }, "rejected: /platform/prepare co-sign with nowhere to freeze files");
        return reply.code(503).send({ error: "cosign-unavailable" });
      }
      if (upload.signature === undefined) {
        request.log.warn({ platform: platform.name }, "rejected: /platform/prepare no agent signature");
        return reply.code(401).send({
          error: "agent-signature-required",
          reason: "send the agent owner's PlatformPrepare signature in the signature field",
        });
      }

      let chainNow: bigint;
      let owner: string;
      try {
        [chainNow, owner] = await Promise.all([chain.now(), chain.agentOwner(platform.agentId)]);
      } catch (error) {
        request.log.warn({ reason: safeReason(error) }, "rejected: /platform/prepare chain unreadable");
        return reply.code(503).send({ error: "chain-unreachable" });
      }

      const timeProblem = issuedAtProblem(upload.issuedAt, chainNow);
      if (timeProblem !== null) {
        request.log.warn({ platform: platform.name, reason: timeProblem }, "rejected: /platform/prepare outside its window");
        return reply.code(403).send({ error: "prepare-expired", reason: timeProblem, chainTime: chainNow.toString() });
      }
      const pictureHash = `0x${createHash("sha256").update(upload.bytes).digest("hex")}` as Hex;
      const digest = prepareDigest({
        mode: MODE[upload.mode],
        pictureHash,
        platformId: platform.keyHash,
        nonce: upload.nonce,
        issuedAt: upload.issuedAt,
      });
      if (!(await signedByAddress(digest, upload.signature, owner))) {
        request.log.warn({ platform: platform.name }, "rejected: /platform/prepare signature is not the agent owner's");
        return reply.code(403).send({
          error: "agent-signature-refused",
          reason: "the signature does not recover to the owner of the platform's agent on the identity registry now",
        });
      }

      const seen = stores.nonces.accept(
        {
          platform: platform.keyHash,
          nonce: upload.nonce,
          picture: pictureHash,
          expiresAt: Number(upload.issuedAt + PREPARE_WINDOW_SECONDS),
        },
        chainNow,
      );
      if (!seen.ok) {
        request.log.warn({ platform: platform.name, reason: seen.reason }, "rejected: /platform/prepare replay memory");
        return reply.code(seen.reason === "replayed" || seen.reason === "same-picture" ? 409 : 503).send({ error: seen.reason });
      }

      if (upload.mode === "cosign") {
        try {
          if ((stores.pending as PendingStore).heldBytes(platform.keyHash, chainNow) >= limits.frozenBytesPerKey) {
            return reply.code(429).send({ error: "pending-full" });
          }
        } catch (error) {
          if (error instanceof PendingFull) {
            return reply.code(503).send({ error: "pending-full" });
          }
          throw error;
        }
      }

      // A key closed for refusals, or at a ticket cap, is told before a slot or a pin is spent. The
      // check reads only the key's own counts, so its answer is the same for any address (P30).
      if (delivery !== undefined) {
        const service = claimService() as ClaimService;
        const { emailHash } = delivery;
        const refusal = ticketRefusal(() => writeProblem(service.store.read(), platform.keyHash, emailHash, service.caps, Number(chainNow)));
        if (refusal !== undefined) {
          request.log.warn({ platform: platform.name, reason: refusal.error }, "rejected: /platform/prepare ticket not writable");
          return reply.code(refusal.status).send({ error: refusal.error });
        }
      }

      const reservation = stores.quota.take(platform.keyHash);
      if (!reservation.ok) {
        request.log.warn({ platform: platform.name }, "rejected: /platform/prepare key quota");
        return reply.code(429).send({ error: "quota", quota: reservation.state });
      }
      const ticket = reservation.ticket as number;
      const today = stores.day.tryTake("prepares");
      if (!today.ok) {
        stores.quota.release(platform.keyHash, ticket);
        request.log.warn({ platform: platform.name }, "rejected: /platform/prepare ceiling for every platform");
        const refusal = dayLimitRefusal(today.use);
        return reply.code(429).header("retry-after", String(refusal.retryAfter)).send(refusal.body);
      }

      // A slot is spent once something that costs Moolam lands: a pin, or files frozen on the volume.
      let spent = false;
      try {
        return await preparePicture(request, reply, platform, upload, chainNow, delivery, () => {
          spent = true;
        });
      } finally {
        if (!spent) {
          today.giveBack();
          stores.quota.release(platform.keyHash, ticket);
        }
      }
    }),
  );

  /** Everything after the checks: sign, fingerprint, and pin or freeze, by mode. */
  async function preparePicture(
    request: FastifyRequest,
    reply: FastifyReply,
    platform: Platform,
    upload: PlatformUpload,
    chainNow: bigint,
    delivery: Delivery | undefined,
    spend: () => void,
  ): Promise<FastifyReply> {
    try {
      await readImageHeader(upload.bytes);
    } catch (error) {
      if (error instanceof FingerprintFault) {
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      const tooBig = error instanceof ImageTooLarge;
      return reply.code(tooBig ? 413 : 415).send({ error: tooBig ? safeReason(error) : "not-an-image" });
    }

    let prepared: PreparedResult;
    let pairs: FingerprintPair[] | undefined;
    try {
      ({ prepared, pairs } = await studioTurn(app, request, upload.bytes, async () => {
        const made = await prepareOrFallback(upload.bytes, {
          title: upload.title,
          claimGenerator: CLAIM_GENERATOR,
          action: "c2pa.created",
          digitalSourceType: AI_SOURCE_TYPE,
          training: upload.training,
          softwareAgent: {
            name: `${platform.name} generator`,
            [AGENT_NAMESPACE]: { agentId: platform.agentId.toString(), registry: AGENT_REGISTRY_CAIP },
          },
          description: `AI-generated by ERC-8004 agent ${platform.agentId}, registered through Moolam for ${platform.name}`,
          log: request.log,
        });
        await assertStableFingerprint(made.print.phash, made.thumbnail);
        return { prepared: made, pairs: await pairsOf(made.bytes, made.print) };
      }));
    } catch (error) {
      const reason = safeReason(error);
      if (error instanceof CallerGone) return reply.code(499).send({ error: "client-gone" });
      if (error instanceof Busy) return reply.code(503).send({ error: "busy" });
      if (error instanceof SignerUnavailable) {
        request.log.error({ reason }, "rejected: /platform/prepare the signer is down");
        return reply.code(502).send({ error: "sign-failed" });
      }
      if (error instanceof FingerprintFault) {
        request.log.error({ reason }, "rejected: /platform/prepare the service failed fingerprinting");
        return reply.code(503).send({ error: "service-fault", reason: SERVICE_FAULT_REASON });
      }
      if (error instanceof ThumbnailTooLarge) {
        return reply.code(422).send({ error: "thumbnail-too-large", limit: error.limit, reason: THUMBNAIL_TOO_LARGE_REASON });
      }
      if (error instanceof FingerprintUnstable) {
        return reply
          .code(422)
          .send({ error: "fingerprint-unstable", limit: error.limit, distance: error.distance, reason: FINGERPRINT_UNSTABLE_REASON });
      }
      return reply.code(415).send({ error: "not-an-image", reason: "the file could not be decoded" });
    }

    // A platform passport is worth its manifest: the badge needs one, and the manifest is what names
    // the agent. A file the signer would not take is refused rather than registered bare.
    if (!prepared.embedded || prepared.manifestDoc === undefined) {
      request.log.warn({ reason: prepared.detail }, "rejected: /platform/prepare manifest not embedded");
      return reply.code(422).send({ error: "manifest-not-embedded", reason: prepared.reason });
    }
    if (prepared.bytes.length > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({ error: "signed-file-too-large", limit: MAX_UPLOAD_BYTES });
    }

    const passportId = prepared.print.sha256 as Hex;
    if ((await registrationOf(registryRead, registry, passportId, request.log)) === "registered") {
      return reply.code(409).send({ error: "already-registered", passportId });
    }

    // In platform mode the creator is the platform's own wallet, so its earlier passports are
    // "yours". In co-sign mode the creator is whoever opens the link, unknown here, so every
    // earlier match is somebody else's and the person sees the warning before they sign.
    const lookalike: Promise<LookalikeAnswer> = lookalikeBeforeSigning(
      app.verifier.snapshot(),
      pairs,
      { creators: async () => (upload.mode === "platform" ? [platform.creatorWallet] : []), titleOf },
      Math.floor(Date.now() / 1000),
    );

    const slug = fileSlug(upload.title, passportId);
    const set = buildFileSet({
      slug,
      image: prepared.bytes,
      thumbnail: prepared.thumbnail,
      manifestDoc: prepared.manifestDoc,
      metadata: (uris) =>
        passportMetadata({
          title: upload.title,
          description: platformDescription(platform),
          image: uris.image,
          thumbnail: uris.thumbnail,
          manifest: uris.manifest,
          agentId: platform.agentId,
          fingerprint: prepared.print,
          training: upload.training,
        }),
    });
    const fields: PassportFields = {
      exactHash: passportId,
      parentId: ZERO_BYTES32,
      generatorAgentId: platform.agentId.toString(),
      phash: prepared.print.phash.toString(),
      blockhash256: prepared.print.blockhash as Hex,
      manifestHash: prepared.manifestHash,
      kind: 0,
      fingerprintVersion: FINGERPRINT_VERSION,
      metadataURI: ipfsUri(set.entries.metadata),
    };
    const shared = {
      manifest: { embedded: true },
      training: trainingStatement(upload.training),
      platform: { name: platform.name, agentId: platform.agentId.toString() },
    };

    if (upload.mode === "platform") {
      // The platform serves these bytes and nothing else carries the passport, so the file is
      // packed and checked against the id the chain will commit to before anything is pinned.
      let file: SignedFile;
      try {
        file = { ...signedFile(prepared.bytes, set.entries.image.name, passportId), type: set.entries.image.contentType };
      } catch (error) {
        request.log.error({ reason: safeReason(error) }, "rejected: /platform/prepare signed file refused");
        return reply.code(500).send({ error: "signed-file-refused", reason: "the signed file does not hash to the passport id" });
      }
      // Platform mode pins now: the agent's signature has already been checked (P19), and the
      // platform signs and sends in one pass, so the gap is the one Moolam's own studio has.
      const pinned = await pinFileSet(set);
      if (!pinned.ok) {
        if (pinned.landed) spend();
        request.log.error({ reason: pinned.reason }, "rejected: /platform/prepare pin failed");
        return reply.code(502).send({ error: "pin-failed" });
      }
      spend();
      const deadline = (await chainTimeOr(chainNow)) + SIGNATURE_WINDOW_SECONDS;
      const input = passportInput(fields, platform.creatorWallet, deadline);

      // The ticket is written pending: it is an offer only once the chain shows the passport under
      // the platform's wallet (P27). The answer is the same for any address, a Moolam user's or
      // not, except deliverNow, which only a standing choice for this very key produces (P30).
      let deliverNow: string | undefined;
      if (delivery !== undefined) {
        const service = claimService() as ClaimService;
        let ticket: Ticket | undefined;
        const refusal = ticketRefusal(() => {
          const found = standingFor(service.store.read(), delivery.emailHash, platform.keyHash);
          const standing = found !== undefined && deliverable(found.destination, service, platform.creatorWallet) ? found : undefined;
          const written = writeTicket(
            service.store,
            {
              passportId,
              keyHash: platform.keyHash,
              platformName: platform.name,
              creatorWallet: platform.creatorWallet,
              verifiedBy: delivery.verifiedBy,
              emailHash: delivery.emailHash,
              standing,
            },
            Number(chainNow),
            service.caps,
          );
          if (!written.ok) return written.reason;
          ticket = written.value;
          deliverNow = standing?.destination;
          return null;
        });
        if (refusal !== undefined) {
          request.log.warn({ platform: platform.name, reason: refusal.error }, "rejected: /platform/prepare ticket not written after the pin");
          return reply.code(refusal.status).send({ error: refusal.error });
        }
        request.log.info({ platform: platform.name, passportId, ticketId: ticket?.ticketId }, "platform: delivery ticket written");
      }

      request.log.info({ platform: platform.name, passportId, mode: "platform" }, "platform: passport fields prepared");
      return reply.send({
        mode: "platform",
        passport: passportAnswer(fields, input.creator, deadline),
        digest: signingDigest(fields, input.creator, deadline, dom),
        files: filesAnswer(set.entries),
        signedFile: file,
        ...shared,
        ...(deliverNow === undefined ? {} : { deliverNow }),
        lookalike: await lookalike,
      });
    }

    const pending = stores.pending as PendingStore;
    const frozenBytes = FILE_ROLES.reduce((sum, role) => sum + set.entries[role].bytes, 0);
    try {
      if (pending.heldBytes(platform.keyHash, chainNow) + frozenBytes > limits.frozenBytesPerKey) {
        return reply.code(429).send({ error: "pending-full" });
      }
    } catch (error) {
      if (error instanceof PendingFull) return reply.code(503).send({ error: "pending-full" });
      throw error;
    }
    const handle = newHandle();
    const record: PendingRecord = {
      version: 1,
      handleHash: handleHash(handle),
      keyHash: platform.keyHash,
      platformName: platform.name,
      agentId: platform.agentId.toString(),
      fields,
      files: set.entries,
      fieldsDigest: fieldsDigest(fields, dom),
      createdAt: Number(chainNow),
      openBy: Number(chainNow + OPEN_WINDOW_SECONDS),
      state: "awaiting-creator",
      creator: null,
      deadline: null,
      digest: null,
      agentSignature: null,
    };
    try {
      pending.create(handle, record, set.bytes);
    } catch (error) {
      pending.drop(handle);
      request.log.error({ reason: safeReason(error) }, "rejected: /platform/prepare could not freeze the files");
      return reply.code(503).send({ error: "cosign-unavailable" });
    }
    spend();
    // Nothing is pinned in co-sign mode until the creator is set and the agent has signed (P6).
    request.log.info({ platform: platform.name, passportId, mode: "cosign" }, "platform: co-sign record made");
    return reply.send({
      mode: "cosign",
      handle,
      passport: passportAnswer(fields),
      files: filesAnswer(set.entries),
      openBy: record.openBy,
      ...shared,
      lookalike: await lookalike,
    });
  }

  app.get(
    "/platform/record/:handle",
    { logLevel: "silent" },
    async (request: FastifyRequest<{ Params: { handle: string } }>, reply: FastifyReply) => {
      const pending = stores.pending;
      const handle = request.params.handle;
      if (pending === undefined || !isHandle(handle)) {
        return reply.code(404).send({ error: "not-found" });
      }
      const identity = await identify(app, request, options.keys);
      if (identity === undefined) {
        app.log.warn({ ip: request.ip }, "rejected: platform record, no valid Privy token");
        return reply.code(401).send({ error: "unauthorized" });
      }

      const opened = pending.open(handle);
      if (opened.kind === "missing") return reply.code(404).send({ error: "not-found" });
      if (opened.kind === "refused") {
        app.log.error({ reason: opened.reason }, "platform record refused and dropped");
        return reply.code(409).send({ error: "record-refused", reason: opened.reason });
      }
      let record = opened.record;

      let chainNow: bigint;
      try {
        chainNow = await chain.now();
      } catch {
        return reply.code(503).send({ error: "chain-unreachable" });
      }
      const expired = expireIfDue(pending, handle, record, chainNow);
      if (expired !== undefined) {
        return reply.code(410).send({ error: "expired", ...named(expired) });
      }

      let wallet: string;
      try {
        const wallets = await embeddedWallets(privy(), identity.userId);
        // The first embedded Ethereum wallet Privy lists: the one Privy made at sign-up, and the one
        // the web app picks as the signer (wallets.find of the first "privy" wallet), so the creator
        // written here is the address the co-sign page signs from. A person with more than one never
        // chooses among them here, because a value the caller chooses is not a verified creator (P2).
        const first = wallets[0];
        if (first === undefined) {
          return reply.code(403).send({ error: "no-wallet", ...named(record) });
        }
        wallet = getAddress(first);
      } catch (error) {
        if (error instanceof APIError && error.status === 404) {
          return reply.code(403).send({ error: "no-wallet", ...named(record) });
        }
        app.log.error({ reason: privyErrorText(error) }, "rejected: platform record, wallet lookup failed");
        return reply.code(502).send({ error: "wallet-lookup-failed" });
      }

      if (record.state === "awaiting-creator") {
        const deadline = chainNow + SIGNATURE_WINDOW_SECONDS;
        const digest = signingDigest(record.fields as PassportFields, wallet, deadline, dom);
        // The store parses what this builds against the next state's schema before writing it.
        const advanced = pending.advance(
          handle,
          "awaiting-creator",
          (current) =>
            ({
              ...current,
              state: "creator-set",
              creator: wallet,
              deadline: Number(deadline),
              digest,
              agentSignature: null,
            }) as PendingRecord,
        );
        // Another open may have set the creator in between; that record is read again and judged
        // like any other, so the second wallet is refused below rather than written over it.
        const settled = advanced.kind === "record" ? advanced : pending.open(handle);
        if (settled.kind !== "record") {
          return reply.code(409).send({ error: "record-refused", ...named(record) });
        }
        record = settled.record;
        if (advanced.kind === "record") {
          app.log.info({ platform: record.platformName }, "platform: co-sign creator set");
        }
      }

      if (record.creator !== wallet) {
        app.log.warn({ ip: request.ip }, "rejected: platform record, opened by a wallet that is not its creator");
        return reply.code(403).send({ error: "creator-mismatch", ...named(record) });
      }
      return reply.send(recordAnswer(record, { digest: true }));
    },
  );

  app.post(
    "/platform/sign/:handle",
    { logLevel: "silent" },
    async (request: FastifyRequest<{ Params: { handle: string } }>, reply: FastifyReply) => {
      const platform = platformForKey(request.headers.authorization, options.platforms, wallClock());
      if (platform === undefined) {
        app.log.warn({ ip: request.ip }, "rejected: platform sign, no valid platform key");
        return reply.code(401).send({ error: "unauthorized" });
      }
      const pending = stores.pending;
      const handle = request.params.handle;
      if (pending === undefined || !isHandle(handle)) {
        return reply.code(404).send({ error: "not-found" });
      }
      const body = signBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "send { \"signature\": \"0x...\" }, the agent owner's 65 byte signature" });
      }
      const signature = body.data.signature.toLowerCase();

      const opened = pending.open(handle);
      if (opened.kind === "missing" || (opened.kind === "record" && !sameHash(opened.record.keyHash, platform.keyHash))) {
        return reply.code(404).send({ error: "not-found" });
      }
      if (opened.kind === "refused") {
        app.log.error({ reason: opened.reason }, "platform record refused and dropped");
        return reply.code(409).send({ error: "record-refused", reason: opened.reason });
      }
      const record = opened.record;

      let chainNow: bigint;
      let owner: string;
      try {
        [chainNow, owner] = await Promise.all([chain.now(), chain.agentOwner(BigInt(record.agentId))]);
      } catch {
        return reply.code(503).send({ error: "chain-unreachable" });
      }
      const expired = expireIfDue(pending, handle, record, chainNow);
      if (expired !== undefined) {
        return reply.code(410).send({ error: "expired", ...named(expired) });
      }
      if (record.state !== "creator-set" || record.creator === null || record.deadline === null) {
        return reply.code(409).send({ error: record.state === "signed" ? "already-signed" : record.state, ...named(record) });
      }

      // The digest the agent must have signed is rebuilt from the record's own fields, never taken
      // from the stored value alone (P3).
      const digest = signingDigest(record.fields as PassportFields, record.creator, BigInt(record.deadline), dom);
      if (digest !== record.digest) {
        pending.drop(handle);
        return reply.code(409).send({ error: "record-refused", reason: "the stored digest is not the fields' digest" });
      }
      if (!(await signedByAddress(digest, signature, owner))) {
        app.log.warn({ platform: platform.name }, "rejected: platform sign, signature is not the agent owner's");
        return reply.code(403).send({
          error: "agent-signature-refused",
          reason: "the signature does not recover to the owner of the platform's agent on the identity registry now",
        });
      }

      const lookup = record.handleHash;
      if (signing.has(lookup)) {
        return reply.code(409).send({ error: "signing" });
      }
      signing.add(lookup);
      try {
        const bytes = {} as Record<FileRole, Buffer>;
        try {
          for (const role of FILE_ROLES) {
            bytes[role] = pending.frozen(handle, record, role);
          }
        } catch (error) {
          if (!(error instanceof FrozenFileChanged)) throw error;
          pending.drop(handle);
          app.log.error({ reason: error.message }, "platform record dropped: a frozen file changed");
          return reply.code(409).send({ error: "record-refused", reason: error.message });
        }

        // Only now, with the creator set from a verified session and the agent's signature checked,
        // does anything of this picture leave the volume (P6).
        const pinned = await pinFileSet({ entries: record.files, bytes });
        if (!pinned.ok) {
          app.log.error({ reason: pinned.reason }, "platform sign: pin failed, record left unsigned");
          return reply.code(502).send({ error: "pin-failed", reason: "a file could not be pinned under the id the passport names, so nothing was signed; try again" });
        }
        const advanced = pending.advance(
          handle,
          "creator-set",
          (current) => ({ ...current, state: "signed", agentSignature: signature, signedAt: Number(chainNow) }) as PendingRecord,
        );
        if (advanced.kind !== "record") {
          return reply.code(409).send({ error: "record-refused", reason: advanced.kind === "refused" ? advanced.reason : "the record is gone" });
        }
        pending.dropFiles(handle);
        app.log.info({ platform: platform.name }, "platform: co-sign signed and pinned");
        return reply.send(recordAnswer(advanced.record, { digest: true }));
      } finally {
        signing.delete(lookup);
      }
    },
  );

  app.get(
    "/platform/status/:handle",
    { logLevel: "silent" },
    async (request: FastifyRequest<{ Params: { handle: string } }>, reply: FastifyReply) => {
      const pending = stores.pending;
      const handle = request.params.handle;
      if (pending === undefined || !isHandle(handle)) {
        return reply.code(404).send({ error: "not-found" });
      }

      const header = request.headers.authorization;
      let asPlatform: Platform | undefined;
      let identity: PrivyIdentity | undefined;
      if (looksLikePlatformKey(header)) {
        asPlatform = platformForKey(header, options.platforms, wallClock());
      } else {
        identity = await identify(app, request, options.keys);
      }
      if (asPlatform === undefined && identity === undefined) {
        app.log.warn({ ip: request.ip }, "rejected: platform status, no valid key or token");
        return reply.code(401).send({ error: "unauthorized" });
      }

      const opened = pending.open(handle);
      if (opened.kind === "missing" || (opened.kind === "record" && asPlatform !== undefined && !sameHash(opened.record.keyHash, asPlatform.keyHash))) {
        return reply.code(404).send({ error: "not-found" });
      }
      if (opened.kind === "refused") {
        app.log.error({ reason: opened.reason }, "platform record refused and dropped");
        return reply.code(409).send({ error: "record-refused", reason: opened.reason });
      }
      let record = opened.record;

      if (identity !== undefined) {
        let wallet: string | undefined;
        try {
          wallet = (await embeddedWallets(privy(), identity.userId))[0];
        } catch {
          wallet = undefined;
        }
        if (wallet === undefined || record.creator === null || getAddress(wallet) !== record.creator) {
          return reply.code(403).send({ error: "creator-mismatch", ...named(record) });
        }
      }

      let chainNow: bigint;
      try {
        chainNow = await chain.now();
      } catch {
        return reply.send({ ...recordAnswer(record, { digest: asPlatform !== undefined }), chain: "unknown" });
      }

      if (record.state === "signed") {
        let onChain;
        try {
          onChain = await chain.passport(record.fields.exactHash as Hex);
        } catch {
          return reply.send({ ...recordAnswer(record, { digest: asPlatform !== undefined }), chain: "unknown" });
        }
        if (onChain !== undefined) {
          // "registered" is said only when the chain holds this very passport: this creator, this
          // agent and this metadata (P13). Anything else under the same id is someone else's.
          const ours =
            onChain.creator === record.creator &&
            onChain.generatorAgentId === BigInt(record.agentId) &&
            onChain.metadataURI === record.fields.metadataURI &&
            onChain.manifestHash === record.fields.manifestHash;
          return reply.send({
            ...recordAnswer(record, { digest: asPlatform !== undefined }),
            state: ours ? "registered" : "failed",
            ...(ours ? { registeredAt: onChain.registeredAt.toString() } : { reason: "another passport already holds this picture" }),
          });
        }
      }

      // A signed record reaches here only after the chain read above found no passport for it.
      const expired = expireIfDue(pending, handle, record, chainNow, true);
      if (expired !== undefined) {
        record = expired;
      }
      return reply.send(recordAnswer(record, { digest: asPlatform !== undefined }));
    },
  );

  /**
   * The accepted tickets of this key waiting for their hand-over (P34): only those whose ownerOf,
   * read now, is still the platform's wallet, oldest first, at most MAX_DELIVERIES. A ticket whose
   * holder could not be read is left out of this poll rather than guessed. Every destination is
   * checked again as it leaves (P31), and the platform's SDK checks it once more before any send.
   */
  app.get("/platform/deliveries", async (request: FastifyRequest, reply: FastifyReply) => {
    const platform = platformForKey(request.headers.authorization, options.platforms, wallClock());
    if (platform === undefined) {
      request.log.warn({ ip: request.ip }, "rejected: /platform/deliveries no valid platform key");
      return reply.code(401).send({ error: "unauthorized" });
    }
    const service = claimService();
    if (service === undefined) {
      return reply.code(503).send({ error: "claims-unavailable" });
    }
    let tickets: Ticket[];
    try {
      tickets = service.store.read().tickets;
    } catch (error) {
      if (!(error instanceof ClaimStoreClosed)) throw error;
      request.log.error({ reason: error.message }, "rejected: /platform/deliveries the claim store is closed");
      return reply.code(503).send({ error: "claims-unavailable" });
    }
    const candidates = tickets
      .filter((ticket) => ticket.state === "accepted" && sameHash(ticket.keyHash, platform.keyHash))
      .sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0))
      .slice(0, DELIVERY_CANDIDATES);
    const stillHeld: boolean[] = [];
    for (let at = 0; at < candidates.length; at += DELIVERY_READS_AT_ONCE) {
      const chunk = candidates.slice(at, at + DELIVERY_READS_AT_ONCE);
      stillHeld.push(
        ...(await Promise.all(
          chunk.map(async (ticket) => {
            try {
              const owner = getAddress(await service.chain.ownerOf(ticket.passportId as Hex));
              return owner === ticket.creatorWallet && owner === platform.creatorWallet;
            } catch {
              return false;
            }
          }),
        )),
      );
    }
    const deliveries = candidates
      .filter((ticket, index) => stillHeld[index] === true && ticket.destination !== null && deliverable(ticket.destination, service, ticket.creatorWallet))
      .slice(0, MAX_DELIVERIES)
      .map((ticket) => ({ ticketId: ticket.ticketId, passportId: ticket.passportId, destination: ticket.destination as string }));
    return reply.send({ deliveries });
  });

  /** The platform's worker gave up on a ticket after its last try: accepted moves to failed and the person sees it (P34). */
  app.post(
    "/platform/deliveries/:ticketId/failed",
    async (request: FastifyRequest<{ Params: { ticketId: string } }>, reply: FastifyReply) => {
      const platform = platformForKey(request.headers.authorization, options.platforms, wallClock());
      if (platform === undefined) {
        request.log.warn({ ip: request.ip }, "rejected: /platform/deliveries failed, no valid platform key");
        return reply.code(401).send({ error: "unauthorized" });
      }
      const service = claimService();
      if (service === undefined) {
        return reply.code(503).send({ error: "claims-unavailable" });
      }
      const ticketId = request.params.ticketId;
      if (!isTicketId(ticketId)) {
        return reply.code(404).send({ error: "not-found" });
      }
      let outcome: ReturnType<typeof markFailed>;
      try {
        outcome = markFailed(service.store, ticketId, platform.keyHash, Number(wallClock()));
      } catch (error) {
        if (!(error instanceof ClaimStoreClosed)) throw error;
        return reply.code(503).send({ error: "claims-unavailable" });
      }
      if (!outcome.ok) {
        // Another key's ticket answers like an unknown one, so a key learns nothing about ids it does not own.
        return reply.code(outcome.reason === "not-accepted" ? 409 : 404).send({ error: outcome.reason === "not-accepted" ? "not-accepted" : "not-found" });
      }
      request.log.info({ platform: platform.name, ticketId }, "platform: delivery marked failed");
      return reply.send({ ticketId, state: "failed" });
    },
  );
}

/**
 * The answer for a ticket the store will not write: 403 for a key closed after too many refusals,
 * 429 at a cap, 503 when the store cannot be read. Undefined when the check passed.
 */
function ticketRefusal(check: () => string | null): { status: number; error: string } | undefined {
  let problem: string | null;
  try {
    problem = check();
  } catch (error) {
    if (error instanceof ClaimStoreClosed) return { status: 503, error: "claims-unavailable" };
    throw error;
  }
  if (problem === null) return undefined;
  if (problem === "closed") return { status: 403, error: "deliver-closed" };
  if (problem === "full") return { status: 429, error: "deliver-full" };
  return { status: 503, error: "claims-unavailable" };
}

/**
 * Expires a record whose time has passed on chain and hands back the expired record, or undefined
 * while it still has time. An awaiting record's time is its openBy, a later one's its deadline. An
 * expired record never moves again, and its frozen files go with it (P12).
 *
 * A signed record may have been registered before its deadline, so it is expired only by a caller
 * that has just read the chain and found no passport: `signedChecked`.
 */
function expireIfDue(
  pending: PendingStore,
  handle: string,
  record: PendingRecord,
  chainNow: bigint,
  signedChecked = false,
): PendingRecord | undefined {
  if (record.state === "expired") {
    return record;
  }
  if (record.state === "signed" && !signedChecked) {
    return undefined;
  }
  const endsAt = BigInt(record.deadline ?? record.openBy);
  if (chainNow <= endsAt) {
    return undefined;
  }
  const advanced = pending.advance(handle, record.state, (current) => expiredFrom(current, chainNow));
  pending.dropFiles(handle);
  return advanced.kind === "record" ? advanced.record : expiredFrom(record, chainNow);
}

/** The public facts a refusal still names, so a person told no still sees what they were sent (P2). */
function named(record: PendingRecord): Record<string, unknown> {
  return {
    agentId: record.agentId,
    platform: { name: record.platformName, agentId: record.agentId },
    exactHash: record.fields.exactHash,
  };
}

/** A record as its answers carry it. The digest is named only where the reader may act on it. */
function recordAnswer(record: PendingRecord, show: { digest: boolean }): Record<string, unknown> {
  const deadline = record.deadline === null ? undefined : BigInt(record.deadline);
  return {
    state: record.state,
    ...named(record),
    passport: passportAnswer(record.fields as PassportFields, record.creator ?? undefined, deadline),
    files: filesAnswer(record.files),
    openBy: record.openBy,
    ...(show.digest && record.digest !== null ? { digest: record.digest } : {}),
    ...(record.agentSignature === null ? {} : { agentSignature: record.agentSignature }),
  };
}

function filesAnswer(entries: Record<FileRole, FileEntry>): Record<string, unknown> {
  return Object.fromEntries(
    FILE_ROLES.map((role) => {
      const entry = entries[role];
      return [role, { cid: entry.cid, uri: ipfsUri(entry), gatewayUrl: gatewayUrl(ipfsUri(entry)), bytes: entry.bytes }];
    }),
  );
}

/** Two stored hashes compared in constant time. Both are 0x and 64 lowercase hex by their schemas. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a.slice(2), "hex");
  const right = Buffer.from(b.slice(2), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function wallClock(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Who sent this request, or undefined for a missing, expired or foreign Privy token. The reason is
 * logged on the root logger, without the URL, since these routes carry a handle in theirs.
 */
async function identify(app: FastifyInstance, request: FastifyRequest, keys?: PrivyKeys): Promise<PrivyIdentity | undefined> {
  const token = bearerToken(request.headers.authorization);
  if (token === undefined) return undefined;
  try {
    return await verifyPrivyToken(token, keys);
  } catch (error) {
    if (error instanceof InvalidToken) {
      app.log.warn({ ip: request.ip, reason: safeReason(error) }, "rejected: bad Privy token");
      return undefined;
    }
    throw error;
  }
}
