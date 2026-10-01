/**
 * The look-alike step's decisions, kept apart from the CRE SDK so each one is tested on its own:
 * what counts as an answer from the verify service, which proposed candidate the chain proves
 * earlier, how many reads and calls a run may still make, and how many look-alike reports a catch-up
 * run may write. workflow.ts does the reading and the writing.
 */

import { hammingHex } from "./blockhash";
import type { FingerprintPair } from "./dihedral";
import { LOOKALIKE_BLOCKHASH_BITS, LOOKALIKE_PHASH_BITS, registeredBefore } from "./lookalike-rule";
import { hamming64 } from "./phash";
import { passportKey } from "./picture";

/** The most candidates the route may name, and so the most `getPassport` reads they can cost. */
export const MAX_CANDIDATES = 3;

/** The most passports one backlog answer may name, the route's own cap on `n`. */
export const MAX_BACKLOG = 7;

const PASSPORT_ID = /^0x[0-9a-f]{64}$/;
const ZERO_ID = `0x${"0".repeat(64)}`;

export type ServiceAnswer = { kind: "ok"; ids: string[] } | { kind: "no-answer"; reason: string };

/**
 * What one of the verify service's look-alike routes said, as the run may use it.
 *
 * Only a 200 whose body is UTF-8 JSON with `status` "ok" and a list under `field` of distinct,
 * lower case passport ids, at most `max` of them, is an answer. "not-ready", any other status, a
 * body that is not JSON, a list too long, an id in any other form and a repeated id are all "no
 * answer", so a route that is down, rate limited or wrong can never be read as "none found" (L17).
 * Fields beyond the two read here are ignored. The reason names the status and never the body.
 */
export const readServiceAnswer = (
	route: string,
	status: number,
	body: Uint8Array,
	field: "candidates" | "passports",
	max: number,
): ServiceAnswer => {
	if (status !== 200) {
		return { kind: "no-answer", reason: `the ${route} route answered status ${status}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return { kind: "no-answer", reason: `the ${route} route answered 200 with a body that is not JSON` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "no-answer", reason: `the ${route} route answered 200 with a body that is not a JSON object` };
	}
	const answer = parsed as Record<string, unknown>;
	if (answer.status === "not-ready") {
		return { kind: "no-answer", reason: `the ${route} route is not ready` };
	}
	const ids = answer[field];
	if (answer.status !== "ok" || !Array.isArray(ids)) {
		return { kind: "no-answer", reason: `the ${route} route answered 200 in a shape this workflow does not read` };
	}
	if (ids.length > max) {
		return { kind: "no-answer", reason: `the ${route} route named ${ids.length} passports, over its cap of ${max}` };
	}
	if (!ids.every((id): id is string => typeof id === "string" && PASSPORT_ID.test(id))) {
		return { kind: "no-answer", reason: `the ${route} route named something that is not a lower case passport id` };
	}
	if (new Set(ids).size !== ids.length || ids.includes(ZERO_ID)) {
		return { kind: "no-answer", reason: `the ${route} route named a passport twice or named the zero id` };
	}
	return { kind: "ok", ids };
};

/** The registry's record of a passport, in the fields the look-alike step reads. */
export interface ChainPassport {
	registeredAt: bigint;
	creator: string;
	parentId: string;
	phash: bigint;
	blockhash256: string;
}

/** An original has no parent. Only an original gets the look-alike step (L9). */
export const isOriginal = (passport: Pick<ChainPassport, "parentId">): boolean => BigInt(passport.parentId) === 0n;

/** The one comparison for creators: both come from the same decoder, compared without letter case. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface Closeness {
	phashDistance: number;
	blockhashDistance: number;
}

/**
 * The closest of this run's eight fingerprint pairs to a stored fingerprint, counting only a pair
 * inside both shared thresholds on the same variant, or null when none is. Closest means the lower
 * pHash distance, then the lower block hash distance.
 */
export const closestPair = (pairs: readonly FingerprintPair[], phash: bigint, blockhash: string): Closeness | null => {
	let best: Closeness | null = null;
	for (const pair of pairs) {
		const phashDistance = hamming64(BigInt(pair.phash), phash);
		const blockhashDistance = hammingHex(pair.blockhash, blockhash);
		if (phashDistance > LOOKALIKE_PHASH_BITS || blockhashDistance > LOOKALIKE_BLOCKHASH_BITS) continue;
		if (
			best === null ||
			phashDistance < best.phashDistance ||
			(phashDistance === best.phashDistance && blockhashDistance < best.blockhashDistance)
		) {
			best = { phashDistance, blockhashDistance };
		}
	}
	return best;
};

export interface Kept extends Closeness {
	id: string;
	registeredAt: bigint;
}

export interface Judgement {
	kept: Kept | null;
	/** One line per refused candidate, for the run's log. */
	refused: string[];
}

/**
 * Which proposed candidate this run proves to be the earlier look-alike, from chain reads and this
 * run's own fingerprints only (L8). A candidate counts when the registry knows it, it was registered
 * strictly before the new passport by the shared rule (a tie is never earlier, L10), its creator is
 * someone else, and one of this run's eight variants of the new picture sits inside both thresholds
 * of its stored fingerprints (L11). The new passport is an original, so every earlier passport is
 * in another edit family and no parent walk is needed (L9). Of those kept, the earliest is chosen;
 * two kept in the same second fall to the lower id, so every node picks the same one.
 */
export const judgeCandidates = (
	passport: { id: string; registeredAt: bigint; creator: string },
	pairs: readonly FingerprintPair[],
	candidates: readonly { id: string; record: ChainPassport }[],
): Judgement => {
	const refused: string[] = [];
	let kept: Kept | null = null;
	for (const { id, record } of candidates) {
		if (passportKey(id) === passportKey(passport.id)) {
			refused.push(`candidate ${id} is this passport`);
			continue;
		}
		if (record.registeredAt === 0n) {
			refused.push(`candidate ${id} is not in the registry`);
			continue;
		}
		if (!registeredBefore(record, passport)) {
			refused.push(
				`candidate ${id} was registered at ${record.registeredAt}, not before this passport's ${passport.registeredAt}`,
			);
			continue;
		}
		if (sameAddress(record.creator, passport.creator)) {
			refused.push(`candidate ${id} has the same creator`);
			continue;
		}
		const closeness = closestPair(pairs, record.phash, record.blockhash256);
		if (closeness === null) {
			refused.push(`candidate ${id} is outside ${LOOKALIKE_PHASH_BITS} pHash or ${LOOKALIKE_BLOCKHASH_BITS} block hash bits on every variant`);
			continue;
		}
		const candidate: Kept = { id: passportKey(id), registeredAt: record.registeredAt, ...closeness };
		if (
			kept === null ||
			registeredBefore(candidate, kept) ||
			(candidate.registeredAt === kept.registeredAt && candidate.id < kept.id)
		) {
			kept = candidate;
		}
	}
	return { kept, refused };
};

/**
 * CRE's per-run quotas: 15 HTTP calls and 15 contract reads. Every call a handler makes is taken
 * from one of these, and a step only starts when the most it could still cost fits, so a run stops
 * short rather than being cut off by the quota halfway through a write.
 */
export const HTTP_CALLS_PER_RUN = 15;
export const CHAIN_READS_PER_RUN = 15;

export class Budget {
	http: number;
	chain: number;

	constructor(http = HTTP_CALLS_PER_RUN, chain = CHAIN_READS_PER_RUN) {
		this.http = http;
		this.chain = chain;
	}

	/** Whether this many more calls and reads still fit. */
	fits(http: number, chain: number): boolean {
		return http <= this.http && chain <= this.chain;
	}

	/** Takes calls or reads from what is left. Throws rather than go past a quota. */
	spend(http: number, chain: number): void {
		if (!this.fits(http, chain)) {
			throw new Error(`the run's budget has ${this.http} HTTP calls and ${this.chain} reads left, not ${http} and ${chain}`);
		}
		this.http -= http;
		this.chain -= chain;
	}
}

/** One catch-up run every ten minutes is 144 a day. */
export const CRON_RUNS_PER_DAY = 144;
const CRON_INTERVAL_SECONDS = 600;

/**
 * How many look-alike reports the catch-up run at `nowSeconds` may write, so that the day's 144 runs
 * together write at most `perDay` (L15). Each run gets the whole share, and the remainder goes one
 * each to the first runs of the UTC day, so 1,000 a day is 7 for the first 136 runs and 6 after. 0
 * writes none. The workflow keeps no count across runs, so this is the bound by construction; the
 * verify service's own ceiling on its routes is the second one.
 */
export const lookalikeWritesThisRun = (perDay: number, nowSeconds: number): number => {
	if (perDay <= 0) return 0;
	const slot = Math.floor((nowSeconds % 86_400) / CRON_INTERVAL_SECONDS);
	return Math.floor(perDay / CRON_RUNS_PER_DAY) + (slot < perDay % CRON_RUNS_PER_DAY ? 1 : 0);
};
