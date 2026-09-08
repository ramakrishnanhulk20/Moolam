import {
	bytesToHex,
	consensusIdenticalAggregation,
	cre,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	logTriggerConfig,
	prepareReportRequest,
	TxStatus,
	type EVMLog,
	type NodeRuntime,
	type Runtime,
} from "@chainlink/cre-sdk";
import {
	decodeEventLog,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	keccak256,
	parseAbi,
	parseAbiParameters,
	toBytes,
	zeroAddress,
	type Address,
	type Hex,
} from "viem";
import { z } from "zod";
import { decodeJpeg } from "./decode";
import { hamming64, perceptualHash, toBytes32, toHex64 } from "./phash";

export const configSchema = z.object({
	chain: z.string(),
	registry: z.string(),
	receiver: z.string(),
	gateway: z.string(),
	matchThreshold: z.number(),
});
type Config = z.infer<typeof configSchema>;

const verificationSchema = z.object({
	recomputed: z.string(),
	distance: z.number(),
	matched: z.boolean(),
});
type Verification = z.infer<typeof verificationSchema>;

const registryAbi = parseAbi([
	"event PassportRegistered(bytes32 indexed passportId, address indexed creator, uint256 indexed generatorAgentId, bytes32 parentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, string metadataURI)",
	"function getPassport(bytes32 id) view returns ((bytes32 exactHash, bytes32 parentId, address creator, uint256 generatorAgentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, uint64 registeredAt, bool disputed, string metadataURI))",
]);

const PASSPORT_REGISTERED_TOPIC = keccak256(
	toBytes(
		"PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
	),
);

/**
 * From the contracts' own gas report: attest costs at most 154k, and the receiver test measured
 * 267k for the whole forwarder call including the signature check. A million leaves room for a
 * passport whose attestation list is long, and still caps what one run can spend.
 */
const GAS_LIMIT = "1000000";

const IPFS_SCHEME = "ipfs://";
const JSON_DATA_URI = "data:application/json,";

const httpClient = new cre.capabilities.HTTPClient();

/** Turns an ipfs:// reference, a bare content id or an https URL into something we can GET. */
const toFetchUrl = (gateway: string, reference: string): string => {
	if (reference.startsWith("https://") || reference.startsWith("http://")) return reference;
	const path = reference.startsWith(IPFS_SCHEME) ? reference.slice(IPFS_SCHEME.length) : reference;
	const base = gateway.endsWith("/") ? gateway : `${gateway}/`;
	return `${base}${path}`;
};

/** The content id on its own, so a reader of the logs can fetch the same bytes we did. */
const referenceId = (reference: string): string => {
	const withoutScheme = reference.startsWith(IPFS_SCHEME)
		? reference.slice(IPFS_SCHEME.length)
		: reference;
	return withoutScheme.split("/")[0] ?? withoutScheme;
};

const fetchBytes = (nodeRuntime: NodeRuntime<Config>, url: string, what: string): Uint8Array => {
	const response = httpClient
		.sendRequest(nodeRuntime, { url, method: "GET", timeout: "10s" })
		.result();

	if (response.statusCode !== 200) {
		throw new Error(`${what} fetch returned status ${response.statusCode} from ${url}`);
	}
	return response.body;
};

/**
 * The passport's metadata document. A passport either points at a JSON file on IPFS or carries the
 * document inline as a data URI, and both are read here, because the workflow has to work with
 * whatever the creator's app wrote on chain rather than a shape we would prefer.
 */
const readMetadata = (
	nodeRuntime: NodeRuntime<Config>,
	metadataURI: string,
): Record<string, unknown> => {
	let text: string;
	if (metadataURI.startsWith(JSON_DATA_URI)) {
		text = decodeURIComponent(metadataURI.slice(JSON_DATA_URI.length));
	} else {
		const url = toFetchUrl(nodeRuntime.config.gateway, metadataURI);
		text = new TextDecoder().decode(fetchBytes(nodeRuntime, url, "metadata"));
	}

	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("passport metadata is not a JSON document");
	}
	return parsed as Record<string, unknown>;
};

/**
 * One node's own answer: download the picture the passport points at, fingerprint it, and measure
 * how far that is from the fingerprint the creator registered. Every node does this by itself and
 * consensus only accepts the run when a quorum produced the identical answer, so the downloaded
 * bytes never have to match across nodes, only the verdict does.
 */
const verifyThumbnail = (
	nodeRuntime: NodeRuntime<Config>,
	metadataURI: string,
	storedPhashHex: string,
): Verification => {
	const metadata = readMetadata(nodeRuntime, metadataURI);
	const reference = metadata.thumbnail ?? metadata.image;
	if (typeof reference !== "string" || reference.length === 0) {
		throw new Error("passport metadata has no thumbnail or image to check");
	}

	const bytes = fetchBytes(
		nodeRuntime,
		toFetchUrl(nodeRuntime.config.gateway, reference),
		"thumbnail",
	);
	nodeRuntime.log(`thumbnail ${referenceId(reference)} ${bytes.length} bytes`);

	const image = decodeJpeg(bytes);
	const recomputed = perceptualHash(image.pixels, image.width, image.height, image.channels);
	const distance = hamming64(recomputed, BigInt(storedPhashHex));

	return {
		recomputed: toHex64(recomputed),
		distance,
		matched: distance <= nodeRuntime.config.matchThreshold,
	};
};

export const onPassportRegistered = (runtime: Runtime<Config>, log: EVMLog): string => {
	const config = runtime.config;

	const decoded = decodeEventLog({
		abi: registryAbi,
		data: bytesToHex(log.data),
		topics: log.topics.map((topic: Uint8Array) => bytesToHex(topic)) as [Hex, ...Hex[]],
	});
	if (decoded.eventName !== "PassportRegistered") {
		throw new Error(`unexpected event ${decoded.eventName}`);
	}
	const passportId = decoded.args.passportId;

	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);
	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

	// The event is only the wake-up call. Everything the attestation is built from is read back out
	// of the registry, so a forged log cannot talk this workflow into signing a report about it.
	const call = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: config.registry as Address,
				data: encodeFunctionData({
					abi: registryAbi,
					functionName: "getPassport",
					args: [passportId],
				}),
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result();

	const passport = decodeFunctionResult({
		abi: registryAbi,
		functionName: "getPassport",
		data: bytesToHex(call.data),
	});
	if (passport.registeredAt === 0n) {
		throw new Error(`passport ${passportId} is not in the registry`);
	}

	const storedPhash = toHex64(passport.phash);
	runtime.log(`passport ${passportId} stored phash ${storedPhash}`);

	const verification = runtime
		.runInNodeMode(verifyThumbnail, consensusIdenticalAggregation<Verification>(), {
			schema: verificationSchema,
		})(passport.metadataURI, storedPhash)
		.result();

	runtime.log(
		`recomputed ${verification.recomputed} distance ${verification.distance} matched ${verification.matched}`,
	);

	// Chainlink's guidance for a state changing write: a signed report can be sent again after a
	// first attempt failed, or sent on another chain, so the chain it was built for and the moment
	// it was built travel inside the signed payload. The receiver rejects both kinds of replay.
	const executedAt = BigInt(Math.floor(runtime.now().getTime() / 1000));
	const payload = encodeAbiParameters(
		parseAbiParameters(
			"uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed",
		),
		[
			BigInt(network.chainId),
			executedAt,
			passportId,
			verification.matched,
			verification.distance,
			toBytes32(BigInt(verification.recomputed)),
		],
	);

	const report = runtime.report(prepareReportRequest(payload)).result();
	const write = evmClient
		.writeReport(runtime, {
			receiver: config.receiver,
			report,
			gasConfig: { gasLimit: GAS_LIMIT },
		})
		.result();

	if (write.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`report write failed: ${write.errorMessage || write.txStatus}`);
	}

	const txHash = bytesToHex(write.txHash || new Uint8Array(32));
	runtime.log(`report tx ${txHash}`);

	return `${passportId} distance ${verification.distance} matched ${verification.matched} tx ${txHash}`;
};

export const initWorkflow = (config: Config) => {
	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

	return [
		cre.handler(
			evmClient.logTrigger(
				logTriggerConfig({
					addresses: [config.registry as Hex],
					topics: [[PASSPORT_REGISTERED_TOPIC]],
				}),
			),
			onPassportRegistered,
		),
	];
};
