import {
	blockNumber,
	bytesToBase64,
	bytesToHex,
	cre,
	encodeCallMsg,
	getNetwork,
	handlerInTee,
	LATEST_BLOCK_NUMBER,
	logTriggerConfig,
	prepareReportRequest,
	protoBigIntToBigint,
	TxStatus,
	type EVMLog,
	type Runtime,
	type TeeRuntime,
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
import { decodeJpeg, type DecodedImage } from "../moolam-verifier/decode";
import { hamming64, perceptualHash, toBytes32, toHex64 } from "../moolam-verifier/phash";
import {
	FETCH_TRIES,
	GATEWAY_HOST,
	MAX_DOCUMENT_BYTES,
	firstAnswer,
	metadataFetchUrl,
	passportKey,
	privateFileRefusal,
	privatelyRecheckable,
	readLinkAnswer,
	refusal,
	reportLine,
	verdictLine,
} from "./private-copy";

// Patterns rather than zod's url(): url() leans on the URL global, which the sandbox does not have.
const HTTPS_ADDRESS = /^https:\/\/\S+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const configSchema = z.object({
	chain: z.string(),
	registry: z.string().regex(EVM_ADDRESS),
	/** The second receiver, pinned to this workflow's name, never the public one. */
	receiver: z.string().regex(EVM_ADDRESS),
	/** The gateway the public metadata document is read through. */
	gateway: z.string().regex(HTTPS_ADDRESS),
	/** The dedicated gateway a private download link must be on, as a bare lower case host. */
	privateGatewayHost: z.string().regex(GATEWAY_HOST),
	/** The verify service, asked for one short lived link to one passport's private copy. */
	verifierUrl: z.string().regex(HTTPS_ADDRESS),
	secretId: z.string().min(1),
	matchThreshold: z.number().int().nonnegative(),
});
type Config = z.infer<typeof configSchema>;

const registryAbi = parseAbi([
	"event PassportRegistered(bytes32 indexed passportId, address indexed creator, uint256 indexed generatorAgentId, bytes32 parentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, string metadataURI)",
	"function getPassport(bytes32 id) view returns ((bytes32 exactHash, bytes32 parentId, address creator, uint256 generatorAgentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, uint64 registeredAt, bool disputed, string metadataURI))",
]);

const PASSPORT_REGISTERED_TOPIC = keccak256(
	toBytes(
		"PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
	),
);

/** The public workflow's limit, for the same receiver bytecode and the same attest call. */
const GAS_LIMIT = "1000000";

/** The public workflow's retry rule for the registry read, for the same reason: see its workflow.ts. */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 2000;

/** The HTTP capability's ceiling, given to every call because each one crosses the public internet. */
const HTTP_TIMEOUT = "10s";

const httpClient = new cre.capabilities.HTTPClient();

interface Answer {
	statusCode: number;
	body: Uint8Array;
}

/**
 * One HTTP call from inside the enclave. A call that does not answer ends the run naming the call
 * and the passport, and never the capability's own error text, which can carry the address it was
 * given. This is the sealed workflow's own fetch: the public one prints the URL on failure (D7).
 */
const answered = (what: string, passportId: string, call: () => Answer): Answer => {
	try {
		const response = call();
		return { statusCode: response.statusCode, body: response.body };
	} catch {
		throw new Error(refusal.noAnswer(what, passportId));
	}
};

const utf8 = (bytes: Uint8Array): string | null => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
};

/**
 * The passport's public metadata document, read through the configured gateway from an ipfs://
 * address and from nothing else. An http(s) or data address ends the run before any request (D8).
 */
const readMetadata = (runtime: TeeRuntime<Config>, metadataURI: string, passportId: string): unknown => {
	const url = metadataFetchUrl(runtime.config.gateway, metadataURI);
	if (url === null) {
		throw new Error(refusal.metadataNotIpfs(passportId));
	}

	const response = answered("the metadata fetch", passportId, () =>
		firstAnswer(FETCH_TRIES, () =>
			httpClient.sendRequest(runtime, { url, method: "GET", timeout: HTTP_TIMEOUT }).result(),
		),
	);
	if (response.statusCode !== 200) {
		throw new Error(refusal.metadataStatus(passportId, response.statusCode));
	}
	if (response.body.length > MAX_DOCUMENT_BYTES) {
		throw new Error(refusal.metadataTooLarge(passportId, response.body.length));
	}

	const text = utf8(response.body);
	try {
		if (text === null) throw new Error("not text");
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(refusal.metadataUnreadable(passportId));
	}
};

/**
 * One POST to the verify service's /sealed/link, carrying the sealed link token. The service mints
 * a link only while the runner holds a claim on this passport, and the answer is opened only when
 * it is https on the configured private gateway host.
 */
const requestLink = (runtime: TeeRuntime<Config>, token: string, passportId: string): string => {
	const base = runtime.config.verifierUrl.replace(/\/+$/, "");
	// The capability takes a request body as base64.
	const body = bytesToBase64(new TextEncoder().encode(JSON.stringify({ passportId })));

	const response = answered("the private link request", passportId, () =>
		httpClient
			.sendRequest(runtime, {
				url: `${base}/sealed/link`,
				method: "POST",
				body,
				multiHeaders: {
					Authorization: { values: [`Bearer ${token}`] },
					"Content-Type": { values: ["application/json"] },
				},
				timeout: HTTP_TIMEOUT,
			})
			.result(),
	);

	const answer = readLinkAnswer(
		response.statusCode,
		utf8(response.body) ?? "",
		runtime.config.privateGatewayHost,
		passportId,
	);
	if (answer.kind === "refused") {
		throw new Error(answer.reason);
	}
	return answer.url;
};

/**
 * One link, fetched up to FETCH_TRIES times while it does not answer. The status and the size are
 * checked before a byte reaches the decoder.
 */
const fetchPrivateCopy = (runtime: TeeRuntime<Config>, link: string, passportId: string): Uint8Array => {
	const response = answered("the private copy fetch", passportId, () =>
		firstAnswer(FETCH_TRIES, () =>
			httpClient.sendRequest(runtime, { url: link, method: "GET", timeout: HTTP_TIMEOUT }).result(),
		),
	);
	const refused = privateFileRefusal(response.statusCode, response.body.length, passportId);
	if (refused !== null) {
		throw new Error(refused);
	}
	return response.body;
};

/** One `getPassport` call at a fixed block height, decoded. Throws when the node cannot serve it. */
const readPassportAt = (
	don: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	registry: string,
	callData: Hex,
	readAt: ReturnType<typeof blockNumber>,
) => {
	const call = evmClient
		.callContract(don, {
			call: encodeCallMsg({ from: zeroAddress, to: registry as Address, data: callData }),
			blockNumber: readAt,
		})
		.result();

	return decodeFunctionResult({
		abi: registryAbi,
		functionName: "getPassport",
		data: bytesToHex(call.data),
	});
};

/**
 * The passport as the registry holds it, read on the DON side at the log's block with the public
 * workflow's fallback to the latest block when the node keeps no state that old. Chain reads never
 * run inside the enclave, and nothing private goes into this one: the id is public.
 */
const readPassport = (
	runtime: TeeRuntime<Config>,
	don: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	passportId: Hex,
	log: EVMLog,
) => {
	const triggerBlock = log.blockNumber ? protoBigIntToBigint(log.blockNumber) : undefined;
	let readAt = triggerBlock === undefined ? LATEST_BLOCK_NUMBER : blockNumber(triggerBlock);
	let where = triggerBlock === undefined ? "the latest block" : `block ${triggerBlock}`;
	const callData = encodeFunctionData({ abi: registryAbi, functionName: "getPassport", args: [passportId] });

	let lastFailure = "";
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			const candidate = readPassportAt(don, evmClient, runtime.config.registry, callData, readAt);
			if (candidate.registeredAt !== 0n) {
				return candidate;
			}
			lastFailure = "the registry has no record at that block yet";
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
			if (readAt !== LATEST_BLOCK_NUMBER && /not found|historical|not available/i.test(lastFailure)) {
				readAt = LATEST_BLOCK_NUMBER;
				where = `the latest block, since the node keeps no state at block ${triggerBlock}`;
			}
		}
		runtime.log(`getPassport at ${where} attempt ${attempt} of ${READ_ATTEMPTS} failed: ${lastFailure}`);
		if (attempt < READ_ATTEMPTS) sleep(READ_RETRY_MS);
	}
	throw new Error(`passport ${passportId} is not in the registry at ${where}: ${lastFailure}`);
};

/**
 * One private re-check of a sealed picture, run inside the enclave.
 *
 * The sealed link token, the link it buys and the thumbnail bytes stay in this handler. Only the
 * passport id goes out for the chain read, and only the six-field verdict crosses to the DON side
 * at the end, to the second receiver. Three HTTP calls per run: the metadata document, the link,
 * the private copy. Every refusal ends the run with no report and names the passport and a status,
 * never an address or the token.
 */
export const onPassportRegistered = (runtime: TeeRuntime<Config>, log: EVMLog): string => {
	const config = runtime.config;

	const decoded = decodeEventLog({
		abi: registryAbi,
		data: bytesToHex(log.data),
		topics: log.topics.map((topic: Uint8Array) => bytesToHex(topic)) as [Hex, ...Hex[]],
	});
	if (decoded.eventName !== "PassportRegistered") {
		throw new Error(`unexpected event ${decoded.eventName}`);
	}
	const passportId = passportKey(decoded.args.passportId) as Hex;

	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);
	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
	const don = runtime.usingTheDons();

	const passport = readPassport(runtime, don, evmClient, passportId, log);
	const storedPhash = toHex64(passport.phash);
	runtime.log(`passport ${passportId} stored phash ${storedPhash}`);

	const document = readMetadata(runtime, passport.metadataURI, passportId);
	if (!privatelyRecheckable(document)) {
		throw new Error(refusal.notRecheckable(passportId));
	}
	runtime.log(`passport ${passportId} asks for a private re-check`);

	let token: string;
	try {
		token = runtime.getSecret({ id: config.secretId }).result().value;
	} catch {
		throw new Error(refusal.tokenMissing(passportId));
	}
	if (token === "") {
		throw new Error(refusal.tokenMissing(passportId));
	}

	const link = requestLink(runtime, token, passportId);
	const bytes = fetchPrivateCopy(runtime, link, passportId);

	let image: DecodedImage;
	try {
		image = decodeJpeg(bytes);
	} catch {
		throw new Error(refusal.fileNotJpeg(passportId));
	}
	const recomputed = perceptualHash(image.pixels, image.width, image.height, image.channels);
	const distance = hamming64(recomputed, BigInt(storedPhash));
	const matched = distance <= config.matchThreshold;

	runtime.log(`private copy for passport ${passportId} ${bytes.length} bytes`);
	runtime.log(verdictLine(toHex64(recomputed), distance, matched));

	// The one crossing. The chain id and the moment travel inside the signed payload, as in the
	// public workflow, so the receiver refuses a replay on another chain or of an older run.
	const executedAt = BigInt(Math.floor(runtime.now().getTime() / 1000));
	const payload = encodeAbiParameters(
		parseAbiParameters(
			"uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed",
		),
		[BigInt(network.chainId), executedAt, passportId, matched, distance, toBytes32(recomputed)],
	);

	const report = don.report(prepareReportRequest(payload)).result();
	const write = evmClient
		.writeReport(don, {
			receiver: config.receiver,
			report,
			gasConfig: { gasLimit: GAS_LIMIT },
		})
		.result();

	if (write.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`report write for passport ${passportId} failed: ${write.errorMessage || write.txStatus}`);
	}

	const txHash = bytesToHex(write.txHash || new Uint8Array(32));
	runtime.log(reportLine(txHash));

	return `${passportId} distance ${distance} matched ${matched} tx ${txHash}`;
};

export const initWorkflow = (config: Config) => {
	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

	// An empty constraint accepts any registered enclave in any region, as the spike did. Nitro in
	// us-west-2 is the only kind there is today, so pinning it would add nothing.
	return [
		handlerInTee(
			evmClient.logTrigger(
				logTriggerConfig({
					addresses: [config.registry as Hex],
					topics: [[PASSPORT_REGISTERED_TOPIC]],
				}),
			),
			onPassportRegistered,
			{},
		),
	];
};
