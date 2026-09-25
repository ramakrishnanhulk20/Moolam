/**
 * Which picture a run fingerprints, decided without any network so it can be tested outside the
 * sandbox. Its only import is pinned.ts, which imports nothing, so
 * packages/recheck-runner/test/workflow-picture.test.ts can still load this file under Node, where
 * the CRE SDK does not load.
 */

import { pinnedContentId, pinnedFetchUrl } from "./pinned";

const IPFS_SCHEME = "ipfs://";

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

/**
 * The picture this passport is checked against.
 *
 * A public passport's document names its picture, and it is fetched only when that address is
 * `ipfs://<cid>`, through the configured gateway; any other address a registrant wrote, http(s)
 * included, is refused before a request is made. A passport
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
		const url = pinnedFetchUrl(gateway, reference);
		if (url === null) {
			return {
				kind: "refused",
				reason: `passport ${passportId} names a picture that is not an IPFS content id, so it is not fetched`,
			};
		}
		return { kind: "fetch", url, reference, source: "document" };
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

	const pinned = `${IPFS_SCHEME}${cid}`;
	const url = pinnedFetchUrl(gateway, pinned);
	if (url === null) {
		return {
			kind: "refused",
			reason: `unseal record for passport ${passportId} names no ipfs:// thumbnail (status 200)`,
		};
	}
	return { kind: "fetch", url, reference: pinned, source: "unseal record" };
};

/**
 * The thumbnail's content id, from the shape the route answers with: `{ cid, uri, gatewayUrl }`.
 * The uri must be ipfs:// followed by a content id and nothing else, and when the cid field is
 * present it must be that same id; two addresses that disagree are refused rather than picked from.
 */
const recordThumbnail = (value: unknown): string | null => {
	if (typeof value !== "object" || value === null) return null;
	const thumbnail = value as Record<string, unknown>;
	const cid = pinnedContentId(thumbnail.uri);
	if (cid === null) return null;
	if (thumbnail.cid !== undefined && thumbnail.cid !== cid) return null;
	return cid;
};
