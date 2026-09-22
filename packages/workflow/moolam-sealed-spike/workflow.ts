import {
	bytesToBase64,
	cre,
	handlerInTee,
	json,
	ok,
	prepareReportRequest,
	type TeeRuntime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { z } from "zod";
import { decodeJpeg } from "../moolam-verifier/decode";
import { hamming64, perceptualHash, toBytes32, toHex64 } from "../moolam-verifier/phash";

export const configSchema = z.object({
	schedule: z.string(),
	chainId: z.number(),
	passportId: z.string().regex(/^0x[0-9a-f]{64}$/),
	expectedPhash: z.string().regex(/^0x[0-9a-f]{16}$/),
	// Checked with a pattern rather than zod's url() on purpose: url() leans on the URL global,
	// which the sandbox does not have, so it rejects every address. https only, because both calls
	// carry a credential.
	accessLinkEndpoint: z.string().regex(/^https:\/\/\S+$/),
	privateFileUrl: z.string().regex(/^https:\/\/\S+$/),
	linkExpirySeconds: z.number().int().positive(),
	secretId: z.string().min(1),
	matchThreshold: z.number().int().nonnegative(),
});
type Config = z.infer<typeof configSchema>;

/**
 * Ten seconds is the ceiling the HTTP capability allows, and both calls here cross the public
 * internet to a storage provider, so they get all of it rather than a guess.
 */
const HTTP_TIMEOUT = "10s";

const httpClient = new cre.capabilities.HTTPClient();

/**
 * Asks the storage provider for a short lived link to the private file, using the credential the
 * enclave holds. The credential travels in the Authorization header of this one call and never
 * leaves the handler.
 *
 * Throws when the provider refuses the credential, or answers in a shape this code does not know.
 * Failing here is the point of the negative run: a wrong credential means no link, so no bytes,
 * so no verdict.
 */
const mintAccessLink = (runtime: TeeRuntime<Config>, credential: string): string => {
	const config = runtime.config;
	const ask = JSON.stringify({
		url: config.privateFileUrl,
		expires: config.linkExpirySeconds,
		date: Math.floor(runtime.now().getTime() / 1000),
		method: "GET",
	});

	const response = httpClient
		.sendRequest(runtime, {
			url: config.accessLinkEndpoint,
			method: "POST",
			// The capability takes a request body as base64, so the JSON document is encoded rather
			// than passed as a string.
			body: bytesToBase64(new TextEncoder().encode(ask)),
			multiHeaders: {
				Authorization: { values: [`Bearer ${credential}`] },
				"Content-Type": { values: ["application/json"] },
			},
			timeout: HTTP_TIMEOUT,
		})
		.result();

	if (!ok(response)) {
		throw new Error(
			`the access link endpoint refused the sealed credential: status ${response.statusCode}`,
		);
	}

	const answered = json(response);
	if (typeof answered !== "object" || answered === null) {
		throw new Error("the access link endpoint did not answer with a document");
	}
	const link = (answered as Record<string, unknown>).data;
	if (typeof link !== "string" || !link.startsWith("https://")) {
		throw new Error("the access link endpoint answered without a link");
	}
	return link;
};

/**
 * One re-check of a picture no public gateway will serve.
 *
 * Everything in here runs inside the enclave: the credential, the signed link built from it, and
 * the image bytes it buys. Only the verdict crosses to the DON side at the end, which is the whole
 * claim this spike exists to test.
 *
 * Throws when the credential is refused, when the private file cannot be fetched, or when the bytes
 * are not a JPEG this decoder reads. Every one of those ends the run without a verdict.
 */
export const onRecheckDue = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config;

	const credential = runtime.getSecret({ id: config.secretId }).result().value;

	const link = mintAccessLink(runtime, credential);

	const fetched = httpClient
		.sendRequest(runtime, { url: link, method: "GET", timeout: HTTP_TIMEOUT })
		.result();
	if (!ok(fetched)) {
		throw new Error(`the private file fetch returned status ${fetched.statusCode}`);
	}
	const bytes = fetched.body;
	if (bytes.length === 0) {
		throw new Error("the private file fetch returned no bytes");
	}

	const startedAt = Date.now();
	const image = decodeJpeg(bytes);
	const decodedAt = Date.now();
	const recomputed = perceptualHash(image.pixels, image.width, image.height, image.channels);
	const hashedAt = Date.now();

	const distance = hamming64(recomputed, BigInt(config.expectedPhash));
	const matched = distance <= config.matchThreshold;

	// These lines are what a simulation run is read from, and they are also the reason this file is
	// not a deployed workflow as it stands: Chainlink's guidance is that a production confidential
	// handler logs nothing, because a log leaves the enclave. Sizes and the verdict are safe to say
	// out loud, the credential and the signed link are not, and neither is written here.
	runtime.log(`private file ${bytes.length} bytes, ${image.width}x${image.height}`);
	runtime.log(`decode ${decodedAt - startedAt} ms, hash ${hashedAt - decodedAt} ms`);
	runtime.log(
		`recomputed ${toHex64(recomputed)} expected ${config.expectedPhash} distance ${distance} matched ${matched}`,
	);

	// The one crossing. From here on the values are on Workflow DON nodes, so only the verdict goes,
	// in the same six fields the production workflow signs for MoolamReceiver.
	const don = runtime.usingTheDons();

	const payload = encodeAbiParameters(
		parseAbiParameters(
			"uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed",
		),
		[
			BigInt(config.chainId),
			BigInt(Math.floor(runtime.now().getTime() / 1000)),
			config.passportId as `0x${string}`,
			matched,
			distance,
			toBytes32(recomputed),
		],
	);

	don.report(prepareReportRequest(payload)).result();

	return `${config.passportId} distance ${distance} matched ${matched} recomputed ${toHex64(recomputed)}`;
};

export const initWorkflow = (config: Config) => {
	const cron = new cre.capabilities.CronCapability();

	// An empty constraint accepts any registered enclave in any region. The spike never leaves the
	// simulator, and pinning it to nitro in us-west-2 would say more about the run than is true.
	return [handlerInTee(cron.trigger({ schedule: config.schedule }), onRecheckDue, {})];
};
