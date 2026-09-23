import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart, { type Multipart } from "@fastify/multipart";
import type { x402HTTPResourceServer } from "@x402/core/server";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import type { PrivyKeys } from "./auth/privy.js";
import { checkRegistry } from "./boot/registryChecks.js";
import { consentReader, offlineConsentReader, type ConsentReader } from "./consentRead.js";
import { disputeReader, offlineDisputeReader, type DisputeReader } from "./disputeRead.js";
import { MAX_UPLOAD_BYTES, PACKAGE_ROOT, env, type ExpectedRoute } from "./env.js";
import { waitingGate } from "./generate/gate.js";
import { HammingIndex } from "./index.js";
import { globalDay, type GlobalDay } from "./limits/globalDay.js";
import { matchImage, type MatchResult } from "./match.js";
import {
  fileQueueStore,
  memoryQueueStore,
  recheckQueue,
  type QueueStore,
  type RecheckQueue,
} from "./recheck/queue.js";
import { editRoutes } from "./routes/edit.js";
import { generateRoutes } from "./routes/generate.js";
import { healthRoutes } from "./routes/health.js";
import { prepareRoutes } from "./routes/prepare.js";
import { recheckRoutes, type DocumentReader } from "./routes/recheck.js";
import { SEALED_LINKS_PER_DAY, privateCopyStatus, sealedRoutes } from "./routes/sealed.js";
import { BadRequest } from "./routes/shared.js";
import { unsealRoutes } from "./routes/unseal.js";
import { verifyRoutes } from "./routes/verify.js";
import { verifyPaidRoutes } from "./routes/verifyPaid.js";
import {
  offlinePictureReader,
  pictureReader,
  readMetadataDocument,
  unsealRecordFor,
  type PictureReader,
  type UnsealRecordFinder,
} from "./unseal.js";
import { paymentServerFromEnv } from "./x402/plugin.js";
import { EnvioSource } from "./source/EnvioSource.js";
import { JsonFileSource } from "./source/JsonFileSource.js";
import type { PassportSource } from "./source/PassportSource.js";
import type { Hex, PassportRecord } from "./types.js";

const RATE_LIMIT_PER_MINUTE = 60;

/**
 * How many images may be matched at the same time.
 *
 * Matching decodes the picture nine times over, so the rate limit alone does
 * not bound memory: sixty large uploads inside one minute would all decode at
 * once. Two runs in flight keeps the peak to roughly two decodes while queued
 * callers simply wait their turn.
 */
const MAX_CONCURRENT_MATCHES = 2;

/**
 * The cap on a body this service will parse into memory.
 *
 * Only the JSON and text parsers go through it. The multipart parser reads the request stream
 * itself and is bounded by its own fileSize limit, so uploads are still 20 MB. 16 KB is far more
 * than a { "url": "..." } body or a generate prompt needs, and it means an unauthenticated caller
 * cannot make this process buffer megabytes before a single check has run.
 */
const MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * The routes whose answers must never sit in a cache, proxy or browser store.
 *
 * A sealed registration hands back the only copy of a picture, and a refusal on any of the three
 * can repeat a title, a prompt or a field the caller sent. It is set in the hook rather than in
 * the handlers because the answers that most need it are the ones no handler writes: the 401
 * before the body is read, the 413 raised in the middle of the upload, and the 429 the rate
 * limiter sends. Judging by the path rather than by what the route decided means an answer cannot
 * lose the header by taking an early exit.
 */
const UNCACHEABLE = new Set([
  "/prepare",
  "/generate",
  "/edit",
  "/unseal",
  "/recheck/request",
  "/recheck/claim",
  "/recheck/done",
  // Every answer here either is a read link to a private copy or refuses one, and a link is a
  // bearer secret until it expires.
  "/sealed/link",
  // The holder's delete names a wallet's passport and says what was deleted for them.
  "/sealed/forget",
]);

/**
 * How long the sealed lookup behind a re-check request gets.
 *
 * Shorter than the ten seconds an unseal allows, because this caller is waiting on a button and
 * the answer is only used to refuse early: a gateway that does not answer in time lets the request
 * through and the runner sorts it out.
 */
const SEALED_LOOKUP_MS = 5_000;

/** The live metadata read behind a sealed lookup, bounded the same way as the lookup itself. */
const liveDocument: DocumentReader = async (uri) => await readMetadataDocument(uri, { timeoutMs: SEALED_LOOKUP_MS });

/** The live unseal record finder, with both of its reads held to the same bound. */
const liveRecord: UnsealRecordFinder = async (passportId) =>
  await unsealRecordFor(passportId, {
    lookup: { timeoutMs: SEALED_LOOKUP_MS },
    read: { timeoutMs: SEALED_LOOKUP_MS },
  });

/** The multipart parser's code for a body with more text fields than the limit below allows. */
const FIELDS_LIMIT = "FST_FIELDS_LIMIT";

/** What a file part's read throws when the parser cut it off to report something else. */
const PREMATURE_CLOSE = "ERR_STREAM_PREMATURE_CLOSE";

/**
 * How many queued parts a cut-off file read looks through for the parser's own reason. Only the
 * fields the limit let in can be queued ahead of it, so this is far more than can ever be there.
 */
const CAUSE_SEARCH_PARTS = 64;

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

type PartsReader = FastifyRequest["parts"];
type Parts = ReturnType<PartsReader>;

/**
 * Looks behind a file read the parser cut off, for the reason it cut it.
 *
 * When a body carries more text fields than the limit, the multipart plugin stops the parse and
 * destroys the file part that is still streaming, and it queues the real reason behind that part.
 * The file read only ever sees the stream closing under it, so without this the caller is told
 * "Premature close", which names nothing they can fix. Any other reason, a caller that hung up
 * among them, is left as it was.
 */
async function causeBehind(inner: Parts): Promise<Error | undefined> {
  try {
    for (let pulled = 0; pulled < CAUSE_SEARCH_PARTS; pulled += 1) {
      const next = await inner.next();
      if (next.done === true) {
        return undefined;
      }
    }
  } catch (error) {
    return codeOf(error) === FIELDS_LIMIT ? new BadRequest("too-many-fields") : undefined;
  }
  return undefined;
}

/**
 * The multipart reader every route uses, with the field limit named as what it is.
 *
 * The limit itself is the plugin's and is unchanged: a sixth text field still stops the parse. What
 * changes is the answer. The limit surfaces either straight out of the part iterator, or, when a
 * file was streaming at the time, as a premature close on that file; both come out here as one
 * BadRequest("too-many-fields"), which every multipart route already answers as 400 with its
 * message as the error.
 */
function partsNamingTheFieldLimit(parts: PartsReader): PartsReader {
  return function (this: FastifyRequest, options) {
    const inner = parts.call(this, options);
    const guarded = async function* () {
      try {
        while (true) {
          let next: IteratorResult<Multipart>;
          try {
            next = await inner.next();
          } catch (error) {
            throw codeOf(error) === FIELDS_LIMIT ? new BadRequest("too-many-fields") : error;
          }
          if (next.done === true) {
            return;
          }
          const part = next.value;
          if (part.type === "file") {
            const read = part.toBuffer.bind(part);
            part.toBuffer = async () => {
              try {
                return await read();
              } catch (error) {
                if (codeOf(error) !== PREMATURE_CLOSE) {
                  throw error;
                }
                throw (await causeBehind(inner)) ?? error;
              }
            };
          }
          yield part;
        }
      } finally {
        await inner.return?.(undefined);
      }
    };
    return guarded();
  };
}

/** The path on its own. A query string is not part of which route a request reached. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Whether this answer may sit in a cache.
 *
 * The four POSTs above carry a title, a prompt, a wallet or a whole picture. The unseal reads are
 * here for a different reason: whether a passport is still sealed is the one fact on this service
 * that changes from private to public in an instant, and a cached "still sealed" would show a
 * sealed plate over a picture that is already out.
 */
function uncacheable(method: string, url: string): boolean {
  const path = pathOf(url);
  if (path === "/unseal" || path.startsWith("/unseal/")) {
    return true;
  }
  // The runner's own read of the queue, for a third reason: it is the one answer here that only
  // exists because a caller held the runner's token, and it must not be replayed to anyone else.
  if (path === "/recheck/queue") {
    return true;
  }
  return method === "POST" && UNCACHEABLE.has(path);
}

export interface Verifier {
  index: HammingIndex;
  lookupExact: (sha256: Hex) => PassportRecord | undefined;
  version: string;
  /** Matches an image, waiting for a free slot so heavy uploads cannot pile up. */
  runMatch: (bytes: Buffer) => Promise<MatchResult>;
  runPrepare: <T>(task: () => Promise<T>) => Promise<T>;
  /** Rebuilds the index from the source. Never throws: a failed refresh keeps the copy in hand. */
  reload: () => Promise<void>;
  /** Reads what a passport's holder has stated about AI use, for the verify answers. */
  consent: ConsentReader;
  /** Reads whether a passport is under dispute, which is how that statement should be read. */
  dispute: DisputeReader;
  /** Reads whether a passport's picture is public, sealed, or sealed and published later. */
  picture: PictureReader;
  /** The routes this host mounted, so /health can say what it is able to serve. */
  routes: string[];
}

/** The index and the exact-lookup map, replaced together so no request sees a half-built pair. */
interface LoadedIndex {
  index: HammingIndex;
  byId: Map<Hex, PassportRecord>;
}

async function loadIndex(source: PassportSource): Promise<LoadedIndex> {
  const records = await source.load();
  return {
    index: new HammingIndex(records),
    byId: new Map<Hex, PassportRecord>(records.map((record) => [record.id, record])),
  };
}

/**
 * The variables a route named in EXPECT_ROUTES is missing, in the words a .env file uses.
 *
 * Every entry is checked, not just the first, so one failed boot names the whole list to fix.
 */
function missingVariablesFor(route: ExpectedRoute): string[] {
  const missing: string[] = [];
  const alsoNeedsPrepare = (): void => {
    if (env.PINATA_JWT === undefined) missing.push("PINATA_JWT");
    if (env.PRIVY_APP_ID === undefined) missing.push("PRIVY_APP_ID");
  };

  if (route === "prepare") {
    alsoNeedsPrepare();
  }
  if (route === "generate") {
    alsoNeedsPrepare();
    if (env.OPENAI_API_KEY === undefined && env.OPENROUTER_API_KEY === undefined) {
      missing.push("OPENAI_API_KEY or OPENROUTER_API_KEY");
    }
    if (env.PRIVY_APP_SECRET === undefined) missing.push("PRIVY_APP_SECRET");
    if (env.PRIVY_AUTHORIZATION_KEY === undefined) missing.push("PRIVY_AUTHORIZATION_KEY");
    if (env.GENERATOR_WALLET_ID === undefined) missing.push("GENERATOR_WALLET_ID");
  }
  if (route === "edit") {
    alsoNeedsPrepare();
    if (env.PRIVY_APP_SECRET === undefined) missing.push("PRIVY_APP_SECRET");
    if (env.PRIVY_AUTHORIZATION_KEY === undefined) missing.push("PRIVY_AUTHORIZATION_KEY");
    if (env.PRIVY_EDIT_SIGNER_ID === undefined) missing.push("PRIVY_EDIT_SIGNER_ID");
    if (env.PRIVY_EDIT_POLICY_ID === undefined) missing.push("PRIVY_EDIT_POLICY_ID");
  }
  if (route === "verify/paid") {
    if (!env.X402_ENABLED) missing.push("X402_ENABLED");
    if (env.X402_PAY_TO_ADDRESS === undefined) missing.push("X402_PAY_TO_ADDRESS");
    if (env.VERIFIER_BASE_URL.length === 0) missing.push("VERIFIER_BASE_URL");
  }
  return missing;
}

declare module "fastify" {
  interface FastifyInstance {
    verifier: Verifier;
    /** What the whole world has spent today on the three routes that cost money. */
    globalDay: GlobalDay;
    /** Who has asked for a Chainlink second opinion and what the runner did about it. */
    recheck: RecheckQueue;
  }
}

const version = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;

/**
 * Picks the passport source named in the environment.
 *
 * Throws when "envio" is chosen without an endpoint. Failing loudly beats
 * booting with an empty index and telling every caller their image is
 * unregistered.
 */
export function sourceFromEnv(): PassportSource {
  if (env.PASSPORT_SOURCE === "json") {
    return new JsonFileSource(env.PASSPORT_SOURCE_PATH);
  }
  if (env.ENVIO_GRAPHQL_URL === undefined) {
    throw new Error('PASSPORT_SOURCE "envio" needs ENVIO_GRAPHQL_URL');
  }
  return new EnvioSource({ url: env.ENVIO_GRAPHQL_URL });
}

/**
 * Builds the verify service and loads the passport index.
 *
 * The index is read into memory rather than queried per request because a
 * Hamming search is a full scan by design, and rebuilding it per call would put
 * a file read in front of every verification. It is rebuilt in the background
 * every INDEX_REFRESH_MS so an image registered a minute ago verifies, which a
 * load-once index could never do; a refresh that fails keeps the copy in hand.
 *
 * The passport id is the sha256 of the registered bytes, which is what makes
 * the exact lookup a plain map hit.
 *
 * The prepare route is mounted only when this host has both a Pinata token to
 * pin with and a Privy app id to check creators against, or when a caller hands
 * in its own key set. A host without them still verifies images; it just cannot
 * be the studio's backend, and it says so once at boot instead of failing.
 *
 * The generate route needs everything prepare needs plus a key for the image
 * model and the Privy credentials that let it ask the enclave to sign as the
 * generator agent, so it is mounted on the same terms and says once at boot when
 * it is off.
 *
 * The edit route needs what prepare needs plus the Privy credentials and the two ids of the
 * signer the creator granted, so it is mounted on the same terms and says once at boot when it is
 * off. It does not need an image model key: nothing is drawn.
 *
 * The unseal route needs exactly what prepare needs and is mounted on the same
 * condition, so a host that can run the studio can always publish a sealed
 * picture the studio registered.
 *
 * The re-check queue is mounted on every host, because asking for a second opinion costs this
 * service nothing to take and nothing to serve. Its three runner routes need RUNNER_TOKEN and say
 * so with a 503 when the host has not set one.
 *
 * The paid route is mounted only when the environment enables it, or when a
 * caller hands in its own payment server. Everything else about the service is
 * the same either way, so switching payment on adds a route and changes nothing
 * that already works.
 *
 * Both verify routes also read the matched passport's consent statement from the
 * MoolamConsent contract at CONSENT_ADDRESS, and whether that passport is under
 * dispute from the registry at MOOLAM_REGISTRY_ADDRESS, and whether its picture is
 * public, sealed, or sealed and published later, from its metadata document and
 * its unseal record. None of these reads can fail a verification: each is bounded
 * by its own timeout and answers "unavailable" when its source does not.
 *
 * Throws when the source cannot be read or holds malformed records, when x402 is on without a
 * base URL to quote, when EXPECT_ROUTES names a route this host cannot mount, and when the
 * registry check finds the chain disagreeing with what this host would sign.
 */
export async function buildServer(
  options: {
    source?: PassportSource;
    logger?: boolean;
    payments?: x402HTTPResourceServer;
    prepare?: { keys?: PrivyKeys };
    generate?: { keys?: PrivyKeys };
    edit?: { keys?: PrivyKeys };
    unseal?: { keys?: PrivyKeys };
    sealed?: { keys?: PrivyKeys; linkToken?: string };
    consent?: ConsentReader;
    dispute?: DisputeReader;
    picture?: PictureReader;
    checks?: { registry?: () => Promise<void> };
    recheck?: {
      store?: QueueStore;
      runnerToken?: string;
      readDocument?: DocumentReader;
      findRecord?: UnsealRecordFinder;
    };
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: MAX_JSON_BODY_BYTES,
    // Behind a proxy, request.ip has to come from the forwarded header or every caller in the
    // world shares one rate-limit bucket. TRUST_PROXY names which hops may be believed. It is
    // never `true` and never a hop count: Fastify 5.12 reads `true` as "take the leftmost
    // forwarded entry", and that entry is written by the caller, which would hand every caller a
    // bucket of their own choosing.
    trustProxy: env.TRUST_PROXY === "" ? false : env.TRUST_PROXY,
  });

  // Registered before any route or plugin, because a child context copies the hooks the root had
  // at the moment it was created: a hook added later would miss every route registered above it.
  // These four are on every answer, the 404 and the error page included. Fastify advertises no
  // framework header of its own, so there is none to switch off.
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    // The studio calls this service from another origin, so "cross-origin" is the only value here
    // that cannot break it. "same-origin" would, and it is the value a template would have given.
    reply.header("cross-origin-resource-policy", "cross-origin");
    if (uncacheable(request.method, request.url)) {
      reply.header("cache-control", "no-store");
    }
  });

  const source = options.source ?? sourceFromEnv();
  let current = await loadIndex(source);
  const lookupExact = (sha256: Hex): PassportRecord | undefined => current.byId.get(sha256.toLowerCase() as Hex);
  const gate = waitingGate(MAX_CONCURRENT_MATCHES, env.MATCH_WAIT_MS);
  // Under a test runner the default reader makes no network call: a unit suite must not depend on
  // a public RPC being up. A test that wants a statement passes its own reader.
  const consent = options.consent ?? (env.NODE_ENV === "test" ? offlineConsentReader() : consentReader());
  const dispute = options.dispute ?? (env.NODE_ENV === "test" ? offlineDisputeReader() : disputeReader());
  const picture =
    options.picture ??
    (env.NODE_ENV === "test"
      ? offlinePictureReader()
      : pictureReader({ readDocument: liveDocument, findRecord: liveRecord }));

  const reload = async (): Promise<void> => {
    try {
      // One assignment, so an in-flight request reads either the old pair or the new one.
      current = await loadIndex(source);
      app.log.info({ records: current.index.size }, "passport index refreshed");
    } catch (error) {
      app.log.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        "index refresh failed, serving the copy already loaded",
      );
    }
  };

  const canPrepare = env.PINATA_JWT !== undefined && env.PRIVY_APP_ID !== undefined;
  const canGenerate =
    canPrepare &&
    (env.OPENAI_API_KEY !== undefined || env.OPENROUTER_API_KEY !== undefined) &&
    env.PRIVY_APP_SECRET !== undefined &&
    env.PRIVY_AUTHORIZATION_KEY !== undefined &&
    env.GENERATOR_WALLET_ID !== undefined;
  const canEdit =
    canPrepare &&
    env.PRIVY_APP_SECRET !== undefined &&
    env.PRIVY_AUTHORIZATION_KEY !== undefined &&
    env.PRIVY_EDIT_SIGNER_ID !== undefined &&
    env.PRIVY_EDIT_POLICY_ID !== undefined;

  // The paid route quotes its own address to the payer, so a host that does not know its public
  // URL must not serve it: the quote would name nothing and the payment could not be matched back.
  if (env.X402_ENABLED && env.VERIFIER_BASE_URL.length === 0) {
    throw new Error("VERIFIER_BASE_URL is required when X402_ENABLED is true");
  }

  const payments = options.payments ?? (env.X402_ENABLED ? paymentServerFromEnv() : undefined);
  const mounts: Record<ExpectedRoute, boolean> = {
    prepare: options.prepare !== undefined || canPrepare,
    generate: options.generate !== undefined || canGenerate,
    edit: options.edit !== undefined || canEdit,
    "verify/paid": payments !== undefined,
  };

  // Unsealing needs exactly what a prepare needs, a token to pin with and an app id to check
  // creators against, so it rides on the same condition rather than on a name of its own in
  // EXPECT_ROUTES: a host that can run the studio can always finish what the studio started.
  const canUnseal = options.unseal !== undefined || mounts.prepare;

  const refusals = env.EXPECT_ROUTES.filter((route) => !mounts[route]).map((route) => {
    const missing = missingVariablesFor(route);
    return `${route} needs ${missing.length === 0 ? "settings this host does not have" : missing.join(", ")}`;
  });
  if (refusals.length > 0) {
    throw new Error(`EXPECT_ROUTES names routes this host cannot mount: ${refusals.join("; ")}`);
  }

  // The generator signs passports offline, so a registry or an agent owner that does not match
  // this host's settings produces signatures the chain rejects one image at a time. Read it once
  // here instead. The default reads the chain, so it is only used for a route the environment
  // itself mounts, and never under a test runner: a caller that wires the route with its own keys
  // passes its own check.
  const defaultCheck =
    canGenerate && env.NODE_ENV !== "test" ? async (): Promise<void> => await checkRegistry(env) : undefined;
  const registryCheck = options.checks?.registry ?? defaultCheck;
  if (mounts.generate && registryCheck !== undefined) {
    await registryCheck();
  }

  // One counter per server, not per module, so two servers in one test file never share a budget.
  app.decorate(
    "globalDay",
    globalDay({
      prepares: env.GLOBAL_PREPARES_PER_DAY,
      generations: env.GLOBAL_GENERATIONS_PER_DAY,
      edits: env.GLOBAL_EDITS_PER_DAY,
      unseals: env.GLOBAL_UNSEALS_PER_DAY,
      links: SEALED_LINKS_PER_DAY,
    }),
  );

  // One queue per server for the same reason, and under a test runner it keeps nothing: a unit
  // suite must not leave a file behind in the repo, and two servers in one file must not read each
  // other's requests.
  app.decorate(
    "recheck",
    recheckQueue({
      store:
        options.recheck?.store ??
        (env.NODE_ENV === "test" ? memoryQueueStore() : fileQueueStore(env.RECHECK_QUEUE_PATH)),
      log: (line) => {
        app.log.warn(line);
      },
    }),
  );

  app.decorate("verifier", {
    get index(): HammingIndex {
      return current.index;
    },
    lookupExact,
    version,
    runMatch: (bytes: Buffer) => gate(() => matchImage(bytes, current.index, lookupExact)),
    runPrepare: <T>(task: () => Promise<T>) => gate(task),
    reload,
    consent,
    dispute,
    picture,
    routes: [
      "verify",
      ...(mounts["verify/paid"] ? ["verify/paid"] : []),
      ...(mounts.prepare ? ["prepare"] : []),
      ...(mounts.generate ? ["generate"] : []),
      ...(mounts.edit ? ["edit"] : []),
      ...(canUnseal ? ["unseal", "sealed"] : []),
      "health",
    ],
  });

  // The studio uploads straight from the browser, so the app's own origin has to
  // be allowed by name. An origin that is not on the list gets no CORS header
  // back, which the browser turns into a refusal on its side.
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length === 0 ? false : env.CORS_ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  // Five text fields: the studio's /prepare sends title, kind, training, sealed and privateRecheck.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });
  // Added on the root before any route is registered, so every route's context copies it.
  app.addHook("preValidation", async (request) => {
    if (request.isMultipart()) {
      request.parts = partsNamingTheFieldLimit(request.parts);
    }
  });

  await app.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    onExceeded: (request) => {
      request.log.warn({ ip: request.ip, url: request.url }, "rejected: rate limit exceeded");
    },
  });

  await app.register(healthRoutes);
  await app.register(verifyRoutes);

  // One memory of which private copies are kept, shared by /sealed/status, the holder's delete and
  // the re-check queue, so the three can never disagree about a passport inside the same minute.
  const copies = privateCopyStatus();

  // Mounted on every host, with or without a runner: the public request and status routes are the
  // whole point of the queue, and the three runner routes say for themselves when no token is set.
  // The default sealed lookup is off under a test runner, like the consent and dispute readers
  // above, so no unit suite depends on a gateway or Pinata being up.
  await app.register(recheckRoutes, {
    queue: app.recheck,
    runnerToken: options.recheck?.runnerToken ?? env.RUNNER_TOKEN,
    readDocument: options.recheck?.readDocument ?? (env.NODE_ENV === "test" ? undefined : liveDocument),
    findRecord: options.recheck?.findRecord ?? (env.NODE_ENV === "test" ? undefined : liveRecord),
    privateCopy: copies,
  });

  if (mounts.prepare) {
    await app.register(prepareRoutes, options.prepare ?? {});
  } else {
    app.log.info(
      "prepare route off: it needs PINATA_JWT to pin and PRIVY_APP_ID to check creators, and this host has neither or only one",
    );
  }

  if (mounts.generate) {
    await app.register(generateRoutes, options.generate ?? {});
  } else {
    app.log.info(
      "generate route off: on top of what /prepare needs it wants an image model key, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY and GENERATOR_WALLET_ID, and this host is missing at least one",
    );
  }

  if (mounts.edit) {
    await app.register(editRoutes, options.edit ?? {});
  } else {
    app.log.info(
      "edit route off: on top of what /prepare needs it wants PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_EDIT_SIGNER_ID and PRIVY_EDIT_POLICY_ID, and this host is missing at least one",
    );
  }

  if (canUnseal) {
    await app.register(unsealRoutes, options.unseal ?? options.prepare ?? {});
  } else {
    app.log.info("unseal route off: it needs the same PINATA_JWT and PRIVY_APP_ID that /prepare needs");
  }

  // The private copy routes ride on the unseal condition: a host that can unseal holds the Pinata
  // token the lookups need and the Privy app id the holder's delete checks against.
  if (canUnseal) {
    await app.register(sealedRoutes, {
      copies,
      queue: app.recheck,
      linkToken: options.sealed?.linkToken ?? env.SEALED_LINK_TOKEN,
      keys: (options.sealed ?? options.unseal ?? options.prepare ?? {}).keys,
    });
  } else {
    app.log.info("sealed routes off: they need the same PINATA_JWT and PRIVY_APP_ID that /prepare needs");
  }

  if (payments !== undefined) {
    await app.register(verifyPaidRoutes, { payments });
  }

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ ip: request.ip, method: request.method, url: request.url }, "rejected: unknown route");
    return reply.code(404).type("application/json").send({ error: `no route for ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    request.log.warn({ ip: request.ip, url: request.url, status, reason: error.message }, "rejected: request failed");
    return reply.code(status).send({ error: status >= 500 ? "verifier failed to handle the request" : error.message });
  });

  if (env.INDEX_REFRESH_MS > 0) {
    const timer = setInterval(() => {
      void reload();
    }, env.INDEX_REFRESH_MS);
    // A refresh that is only waiting for its next tick must not keep the process alive.
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }

  app.log.info(
    {
      records: current.index.size,
      source: env.PASSPORT_SOURCE,
      corsOrigins: env.CORS_ORIGINS.length,
      routes: app.verifier.routes,
      refreshMs: env.INDEX_REFRESH_MS,
    },
    "passport index loaded",
  );
  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: env.VERIFIER_PORT, host: "0.0.0.0" });
}

// Only listen when this file is the entry point, so tests can build the server
// without binding a port.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
