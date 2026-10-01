import path from "node:path";
import { getAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { env } from "../env.js";
import { dailyQuota, fileQuotaStore, type DailyQuota } from "../generate/quota.js";
import { fileDayStore, globalDay, type GlobalDay } from "../limits/globalDay.js";
import type { Platform } from "../platforms/platforms.js";
import { CLAIM_STATE_FILES, stateFile } from "../stateDir.js";
import { liveClaimChain, offlineClaimChain, type ClaimChain } from "./chain.js";
import { emailHash, type Pepper } from "./email.js";
import { offlinePreviewReader, previewReader, type PreviewReader } from "./preview.js";
import { DEFAULT_CLAIM_CAPS, VERIFIED_BY, claimStore, type ClaimCaps, type ClaimStore, type VerifiedBy } from "./store.js";
import { claimSweeper, type SweepCounts } from "./sweep.js";

/**
 * What the person routes let through (P38). A person opening My pictures a few times an hour reads
 * /claims well under 500 times a day; an address is shared by a household or an office, so it gets
 * twice that. The ceiling for everyone is CLAIM_REQUESTS_PER_DAY, and zero closes the routes.
 */
export interface ClaimLimits {
  perUserPerDay: number;
  perAddressPerDay: number;
  perDay: number;
  caps: ClaimCaps;
}

export const DEFAULT_CLAIM_LIMITS: ClaimLimits = {
  perUserPerDay: 500,
  perAddressPerDay: 1_000,
  perDay: env.CLAIM_REQUESTS_PER_DAY,
  caps: DEFAULT_CLAIM_CAPS,
};

export interface ClaimMeter {
  user: DailyQuota;
  address: DailyQuota;
  day: GlobalDay;
}

/** Everything the claim routes, the prepare route's deliverTo and the deliveries routes share. */
export interface ClaimService {
  store: ClaimStore;
  pepper: Pepper;
  chain: ClaimChain;
  preview: PreviewReader;
  platforms: readonly Platform[];
  registry: Address;
  caps: ClaimCaps;
  meter: ClaimMeter;
  sweep: () => Promise<SweepCounts | undefined>;
}

/** Either the service, or the one reason the claim routes answer 503 instead, which names no value. */
export type ClaimSetup = { open: true; service: ClaimService } | { open: false; why: string };

export interface ClaimSetupOptions {
  /** Where the four claim files live. Left out, the data folder's named files, or none under a test runner. */
  dir?: string;
  platforms: readonly Platform[];
  pepper: Pepper | undefined;
  chain?: ClaimChain;
  preview?: PreviewReader;
  limits?: Partial<ClaimLimits>;
  log: (line: string) => void;
}

/**
 * Builds the claim service, or says why it stays closed: no pepper, or nowhere to keep tickets.
 * Under a test runner the chain and the gateway are offline unless a test hands in its own, so no
 * unit suite reaches either.
 */
export function claimSetup(options: ClaimSetupOptions): ClaimSetup {
  if (options.pepper === undefined) {
    return { open: false, why: "CLAIM_PEPPER and CLAIM_PEPPER_VERSION are not set" };
  }
  const where = (name: string): string | undefined => (options.dir === undefined ? stateFile(name) : path.join(options.dir, name));
  const ticketsFile = where(CLAIM_STATE_FILES.tickets);
  const userFile = where(CLAIM_STATE_FILES.userQuota);
  const addressFile = where(CLAIM_STATE_FILES.addressQuota);
  const dayFile = where(CLAIM_STATE_FILES.dayCeiling);
  if (ticketsFile === undefined || userFile === undefined || addressFile === undefined || dayFile === undefined) {
    return { open: false, why: "this host has no data folder it can write" };
  }
  const limits: ClaimLimits = { ...DEFAULT_CLAIM_LIMITS, ...options.limits };
  const offline = env.NODE_ENV === "test";
  const store = claimStore(ticketsFile, options.log);
  const chain = options.chain ?? (offline ? offlineClaimChain() : liveClaimChain());
  const sweeper = claimSweeper({ store, chain, platforms: options.platforms, pepper: options.pepper, log: options.log });
  return {
    open: true,
    service: {
      store,
      pepper: options.pepper,
      chain,
      preview: options.preview ?? (offline ? offlinePreviewReader() : previewReader()),
      platforms: options.platforms,
      registry: getAddress(env.MOOLAM_REGISTRY_ADDRESS),
      caps: limits.caps,
      meter: {
        user: dailyQuota(limits.perUserPerDay, { store: fileQuotaStore(userFile), log: options.log }),
        address: dailyQuota(limits.perAddressPerDay, { store: fileQuotaStore(addressFile), log: options.log }),
        // The day counter's fail-closed file, under a name of its own: only "prepares" is taken
        // here, standing for a claim request, and every other action is shut.
        day: globalDay({ prepares: limits.perDay, generations: 0, edits: 0, unseals: 0, links: 0 }, Date.now, {
          store: fileDayStore(dayFile),
          log: options.log,
        }),
      },
      sweep: sweeper.run,
    },
  };
}

/**
 * Whether a wallet may be handed to a platform as where a passport goes (P31): checksummed exactly
 * as getAddress writes it, not the zero address, not the registry, not the ticket's platform
 * wallet when one is named and not any listed platform's wallet, since a passport sent there was never handed to a
 * person. Run at accept and again on every read-back before a platform sees the address.
 */
export function deliverable(destination: string, service: Pick<ClaimService, "platforms" | "registry">, creatorWallet?: string): boolean {
  let address: Address;
  try {
    address = getAddress(destination);
  } catch {
    return false;
  }
  if (address !== destination || address === zeroAddress || address === service.registry) return false;
  if (creatorWallet !== undefined && address === getAddress(creatorWallet)) return false;
  return !service.platforms.some((platform) => getAddress(platform.creatorWallet) === address);
}

/** The most a deliverTo field may weigh before it is parsed: an address is at most 254 code points. */
export const MAX_DELIVER_TO_BYTES = 2_048;

const deliverToSchema = z.strictObject({ email: z.string(), verifiedBy: z.enum(VERIFIED_BY) });

/**
 * The deliverTo field of a platform prepare, read into the email's hash and the platform's word for
 * how it checked the address, or null for anything else: over the byte cap, not JSON, a key beyond
 * the two, a verifiedBy outside the three words, or an address normaliseEmail refuses. The address
 * is hashed here and goes no further (P29); the route answers a null with the field's name only.
 */
export function readDeliverTo(raw: string, pepper: Pepper): { emailHash: string; verifiedBy: VerifiedBy } | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_DELIVER_TO_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const shape = deliverToSchema.safeParse(parsed);
  if (!shape.success) return null;
  const hash = emailHash(shape.data.email, pepper);
  return hash === null ? null : { emailHash: hash, verifiedBy: shape.data.verifiedBy };
}
