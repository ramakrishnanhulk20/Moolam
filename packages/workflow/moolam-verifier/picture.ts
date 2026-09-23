/**
 * Which picture a run fingerprints, decided without any network so it can be tested outside the
 * sandbox. No imports on purpose: packages/recheck-runner/test/workflow-picture.test.ts loads this
 * file directly under Node, where the CRE SDK does not load.
 */

const IPFS_SCHEME = "ipfs://";

/**
 * A content id and nothing else: letters and digits only. This is what keeps an address taken from
 * the unseal record from carrying a path, a query, a second host or a scheme into the gateway URL.
 * It does not check that the id is a well formed multihash; a gateway that cannot resolve it
 * answers with an error, and the run stops on that status like any other failed fetch.
 */
const CONTENT_ID = /^[A-Za-z0-9]+$/;

/** What the verify service's GET /unseal/{passportId} answered, as the node received it. */
export interface RecordReply {
	status: number;
	body: string;
}

export type PictureChoice =
	| { kind: "fetch"; url: string; reference: string; source: "document" | "unseal record" }
	| { kind: "ask-record" }
	| { kind: "refused"; reason: string };

/**
 * The one rule for comparing passport ids. The log's id and the record's id both go through it, so
 * a difference in letter case can neither pass a mismatch nor fail a match.
 */
export const passportKey = (value: string): string => value.toLowerCase();

/** Turns an ipfs:// reference, a bare content id or an https URL into something we can GET. */
export const toFetchUrl = (gateway: string, reference: string): string => {
	if (reference.startsWith("https://") || reference.startsWith("http://")) return reference;
	const path = reference.startsWith(IPFS_SCHEME) ? reference.slice(IPFS_SCHEME.length) : reference;
	return `${withSlash(gateway)}${path}`;
};

const withSlash = (base: string): string => (base.endsWith("/") ? base : `${base}/`);

/**
 * The picture this passport is checked against.
 *
 * A public passport's document names its picture and that is used as it always was. A passport
 * registered sealed names none, and its document can never be rewritten, so when the holder has
 * since published the picture the only place that says so is the unseal record beside it. The
 * first call for such a passport answers "ask-record"; the second, given the record reply, answers
 * with a gateway URL or a refusal.
 *
 * From the record only an ipfs:// thumbnail address is taken, and the URL is always built on the
 * configured gateway. The record's own https gateway link is ignored, so the verify service cannot
 * point the nodes at a host of its choosing. Every refusal names the status and the passport id and
 * never a URL or any text taken from the record.
 */
export const choosePicture = (
	document: Record<string, unknown>,
	passportId: string,
	gateway: string,
	record?: RecordReply,
): PictureChoice => {
	const reference = document.thumbnail ?? document.image;
	if (typeof reference === "string" && reference.length > 0) {
		return { kind: "fetch", url: toFetchUrl(gateway, reference), reference, source: "document" };
	}

	const sealedWithoutPicture =
		document.sealed === true && document.thumbnail == null && document.image == null;
	if (!sealedWithoutPicture) {
		return { kind: "refused", reason: "passport metadata has no thumbnail or image to check" };
	}
	if (record === undefined) {
		return { kind: "ask-record" };
	}

	if (record.status === 404) {
		return {
			kind: "refused",
			reason: `passport ${passportId} is sealed and its picture has not been published (unseal record status 404)`,
		};
	}
	if (record.status !== 200) {
		return {
			kind: "refused",
			reason: `unseal record lookup for passport ${passportId} answered status ${record.status}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(record.body);
	} catch {
		return {
			kind: "refused",
			reason: `unseal record for passport ${passportId} is not JSON (status 200)`,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			kind: "refused",
			reason: `unseal record for passport ${passportId} is not a JSON object (status 200)`,
		};
	}
	const answer = parsed as Record<string, unknown>;

	if (
		typeof answer.passportId !== "string" ||
		passportKey(answer.passportId) !== passportKey(passportId)
	) {
		return {
			kind: "refused",
			reason: `unseal record answered for passport ${passportId} names another passport (status 200)`,
		};
	}

	const cid = recordThumbnail(answer.thumbnail);
	if (cid === null) {
		return {
			kind: "refused",
			reason: `unseal record for passport ${passportId} names no ipfs:// thumbnail (status 200)`,
		};
	}

	return {
		kind: "fetch",
		url: `${withSlash(gateway)}${cid}`,
		reference: `${IPFS_SCHEME}${cid}`,
		source: "unseal record",
	};
};

/**
 * The thumbnail's content id, from the shape the route answers with: `{ cid, uri, gatewayUrl }`.
 * The uri must be ipfs:// followed by a content id and nothing else, and when the cid field is
 * present it must be that same id; two addresses that disagree are refused rather than picked from.
 */
const recordThumbnail = (value: unknown): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const thumbnail = value as Record<string, unknown>;
	if (typeof thumbnail.uri !== "string" || !thumbnail.uri.startsWith(IPFS_SCHEME)) return null;

	const cid = thumbnail.uri.slice(IPFS_SCHEME.length);
	if (!CONTENT_ID.test(cid)) return null;
	if (thumbnail.cid !== undefined && thumbnail.cid !== cid) return null;
	return cid;
};
