import {
	blockNumber,
	bytesToHex,
	consensusIdenticalAggregation,
	cre,
	encodeCallMsg,
	getNetwork,
	LATEST_BLOCK_NUMBER,
	logTriggerConfig,
	prepareReportRequest,
	protoBigIntToBigint,
	TxStatus,
	type EVMLog,
	type NodeRuntime,
	type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
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
import { choosePicture, type RecordReply } from "./picture";
import {
	MAX_DOCUMENT_BYTES,
	MAX_PICTURE_BYTES,
	pinnedBodyRefusal,
	pinnedFetchUrl,
} from "./pinned";

export const configSchema = z.object({
	chain: z.string(),
	registry: z.string(),
	receiver: z.string(),
	gateway: z.string(),
	/** The verify service, asked only for the unseal record of a passport registered sealed. */
	verifierUrl: z.string().startsWith("https://"),
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

/**
 * How many times the registry read is tried before the run gives up, and how long it waits between
 * tries. A log trigger fires at Chainlink's default confidence of SAFE, which runs ahead of the
 * last finalized block, so a read pinned to finality can look for a passport the finalized state
 * does not hold yet. The read is pinned to the block the log came from instead: that block already
 * contains the registration, and every node reads the same state whatever height its own RPC has
 * reached. The retries cover the node whose RPC has not caught up to that block yet. Three tries
 * and two seconds between them is at most four seconds added to a five minute execution budget,
 * and three of the fifteen contract reads a run is allowed.
 */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 2000;

const IPFS_SCHEME = "ipfs://";
const JSON_DATA_URI = "data:application/json,";

const httpClient = new cre.capabilities.HTTPClient();

/** The content id on its own, so a reader of the logs can fetch the same bytes we did. */
const referenceId = (reference: string): string => {
	const withoutScheme = reference.startsWith(IPFS_SCHEME)
		? reference.slice(IPFS_SCHEME.length)
		: reference;
	return withoutScheme.split("/")[0] ?? withoutScheme;
};

/**
 * One GET of pinned content. The capability has no switch for redirects: it fails on a 3xx by
 * itself, and pinnedBodyRefusal refuses any status but 200, so a redirect is never followed. The
 * byte cap is checked before the body is parsed or decoded.
 */
const fetchBytes = (
	nodeRuntime: NodeRuntime<Config>,
	url: string,
	what: string,
	cap: number,
): Uint8Array => {
	const response = httpClient
		.sendRequest(nodeRuntime, { url, method: "GET", timeout: "10s" })
		.result();

	const refused = pinnedBodyRefusal(`${what} fetch`, response.statusCode, response.body.length, cap);
	if (refused !== null) {
		throw new Error(`${refused} from ${url}`);
	}
	return response.body;
};

/**
 * The passport's metadata document. A passport either points at a JSON file on IPFS or carries the
 * document inline as a data URI, and both are read here, because the workflow has to work with
 * whatever the creator's app wrote on chain rather than a shape we would prefer. The inline one
 * makes no request. A fetched one must be `ipfs://<cid>`, read through the configured gateway: an
 * http(s) address a registrant wrote ends the run before any request is made.
 */
const readMetadata = (
	nodeRuntime: NodeRuntime<Config>,
	metadataURI: string,
	passportId: string,
): Record<string, unknown> => {
	let text: string;
	if (metadataURI.startsWith(JSON_DATA_URI)) {
		text = decodeURIComponent(metadataURI.slice(JSON_DATA_URI.length));
	} else {
		const url = pinnedFetchUrl(nodeRuntime.config.gateway, metadataURI);
		if (url === null) {
			throw new Error(
				`passport ${passportId} names metadata that is not an IPFS content id, so it is not read`,
			);
		}
		text = new TextDecoder().decode(fetchBytes(nodeRuntime, url, "metadata", MAX_DOCUMENT_BYTES));
	}

	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("passport metadata is not a JSON document");
	}
	return parsed as Record<string, unknown>;
};

/**
 * The verify service's unseal record for a passport registered sealed: one GET, asked only when the
 * document names no picture. The run never goes on from here with anything but a 200 whose record
 * choosePicture accepts, and a call that does not answer at all stops it with the passport id and
 * no URL, since the service's address is configuration and not something a log reader needs.
 */
const readUnsealRecord = (nodeRuntime: NodeRuntime<Config>, passportId: string): RecordReply => {
	const base = nodeRuntime.config.verifierUrl.replace(/\/+$/, "");
	let response: { statusCode: number; body: Uint8Array };
	try {
		response = httpClient
			.sendRequest(nodeRuntime, {
				url: `${base}/unseal/${passportId}`,
				method: "GET",
				timeout: "10s",
			})
			.result();
	} catch {
		throw new Error(`unseal record lookup for passport ${passportId} did not answer`);
	}

	let body: string;
	try {
		body = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
	} catch {
		throw new Error(
			`unseal record for passport ${passportId} is not readable text (status ${response.statusCode})`,
		);
	}
	return { status: response.statusCode, body };
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
	passportId: string,
): Verification => {
	const { gateway } = nodeRuntime.config;
	const metadata = readMetadata(nodeRuntime, metadataURI, passportId);

	let choice = choosePicture(metadata, passportId, gateway);
	if (choice.kind === "ask-record") {
		const record = readUnsealRecord(nodeRuntime, passportId);
		choice = choosePicture(metadata, passportId, gateway, record);
		if (choice.kind === "fetch") {
			nodeRuntime.log(
				`unseal record for passport ${passportId} read (status ${record.status}), thumbnail ${referenceId(choice.reference)}`,
			);
		}
	}
	if (choice.kind !== "fetch") {
		throw new Error(
			choice.kind === "refused" ? choice.reason : `passport ${passportId} has no picture to check`,
		);
	}

	const bytes = fetchBytes(nodeRuntime, choice.url, "thumbnail", MAX_PICTURE_BYTES);
	nodeRuntime.log(`thumbnail ${referenceId(choice.reference)} ${bytes.length} bytes`);

	const image = decodeJpeg(bytes);
	const recomputed = perceptualHash(image.pixels, image.width, image.height, image.channels);
	const distance = hamming64(recomputed, BigInt(storedPhashHex));

	return {
		recomputed: toHex64(recomputed),
		distance,
		matched: distance <= nodeRuntime.config.matchThreshold,
	};
};

/** One `getPassport` call at a fixed block height, decoded. Throws when the node cannot serve it. */
const readPassport = (
	runtime: Runtime<Config>,
	evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
	config: Config,
	callData: Hex,
	readAt: ReturnType<typeof blockNumber>,
) => {
	const call = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: config.registry as Address, data: callData }),
			blockNumber: readAt,
		})
		.result();

	return decodeFunctionResult({
		abi: registryAbi,
		functionName: "getPassport",
		data: bytesToHex(call.data),
	});
};

const statusName = (names: Record<number, string>, status: number | undefined): string =>
	status === undefined ? "missing" : (names[status] ?? `unknown (${status})`);

/**
 * Why a report write did not land, or null when it did.
 *
 * The transaction and the receiver are judged apart because the forwarder's transaction succeeds
 * even when the receiver refuses the report inside it, so a successful transaction alone can still
 * mean no attestation. Only a receiver status that says success counts: reverted, an unknown value
 * and a missing one all fail the run.
 */
export const writeRefusal = (
	write: Pick<EVM_PB.WriteReportReply, "txStatus" | "receiverContractExecutionStatus" | "errorMessage">,
): string | null => {
	if (write.txStatus !== TxStatus.SUCCESS) {
		const detail = write.errorMessage ? `: ${write.errorMessage}` : "";
		return `the report transaction did not succeed (status ${statusName(TxStatus, write.txStatus)})${detail}`;
	}
	if (write.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS) {
		return `the receiver refused the report, so no attestation was written (receiver status ${statusName(EVM_PB.ReceiverContractExecutionStatus, write.receiverContractExecutionStatus)})`;
	}
	return null;
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
	const triggerBlock = log.blockNumber ? protoBigIntToBigint(log.blockNumber) : undefined;
	let readAt = triggerBlock === undefined ? LATEST_BLOCK_NUMBER : blockNumber(triggerBlock);
	let where = triggerBlock === undefined ? "the latest block" : `block ${triggerBlock}`;

	const callData = encodeFunctionData({
		abi: registryAbi,
		functionName: "getPassport",
		args: [passportId],
	});

	let passport: ReturnType<typeof readPassport> | undefined;
	let lastFailure = "";
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		try {
			const candidate = readPassport(runtime, evmClient, config, callData, readAt);
			if (candidate.registeredAt !== 0n) {
				passport = candidate;
				break;
			}
			lastFailure = "the registry has no record at that block yet";
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
			// A node keeps recent state only. When the trigger is an old log, as it is for a re-check
			// of a passport registered days ago, the pinned read answers that the block is gone. The
			// fields this run uses (phash, metadataURI) never change after registration, so the
			// latest block holds the same answer and the remaining tries read there instead.
			if (readAt !== LATEST_BLOCK_NUMBER && /not found|historical|not available/i.test(lastFailure)) {
				readAt = LATEST_BLOCK_NUMBER;
				where = `the latest block, since the node keeps no state at block ${triggerBlock}`;
			}
		}
		runtime.log(
			`getPassport at ${where} attempt ${attempt} of ${READ_ATTEMPTS} failed: ${lastFailure}`,
		);
		if (attempt < READ_ATTEMPTS) sleep(READ_RETRY_MS);
	}
	if (!passport) {
		throw new Error(`passport ${passportId} is not in the registry at ${where}: ${lastFailure}`);
	}

	const storedPhash = toHex64(passport.phash);
	runtime.log(`passport ${passportId} stored phash ${storedPhash}`);

	const verification = runtime
		.runInNodeMode(verifyThumbnail, consensusIdenticalAggregation<Verification>(), {
			schema: verificationSchema,
		})(passport.metadataURI, storedPhash, passportId)
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

	const txHash = bytesToHex(write.txHash || new Uint8Array(32));
	runtime.log(
		`write to ${config.receiver}: transaction ${statusName(TxStatus, write.txStatus)}, receiver ${statusName(EVM_PB.ReceiverContractExecutionStatus, write.receiverContractExecutionStatus)}`,
	);
	const refused = writeRefusal(write);
	if (refused !== null) {
		// The recheck runner reads a `report tx` line as a verdict that landed, so a refusal never
		// prints one.
		throw new Error(`${refused} (transaction ${txHash})`);
	}
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
