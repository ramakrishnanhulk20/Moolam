import {
	blockNumber,
	bytesToBase64,
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
	type CronPayload,
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
import { hammingHex } from "./blockhash";
import { decodeJpeg } from "./decode";
import { DIHEDRAL_NAMES, dihedralFingerprints, type FingerprintPair } from "./dihedral";
import {
	Budget,
	isOriginal,
	judgeCandidates,
	lookalikeWritesThisRun,
	MAX_BACKLOG,
	MAX_CANDIDATES,
	readServiceAnswer,
	type ServiceAnswer,
} from "./lookalike";
import { LOOKALIKE_BLOCKHASH_BITS, LOOKALIKE_PHASH_BITS } from "./lookalike-rule";
import { hamming64, toBytes32, toHex64 } from "./phash";
import { choosePicture, type RecordReply } from "./picture";
import {
	MAX_DOCUMENT_BYTES,
	MAX_PICTURE_BYTES,
	pinnedBodyRefusal,
	pinnedFetchUrl,
} from "./pinned";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const configSchema = z
	.object({
		chain: z.string(),
		registry: z.string(),
		receiver: z.string(),
		gateway: z.string(),
		/** The verify service: the unseal record of a sealed passport, and the two look-alike routes. */
		verifierUrl: z.string().startsWith("https://"),
		matchThreshold: z.number(),
		/**
		 * MoolamLookalikes. Absent turns the look-alike step off, as the simulator's config.json has
		 * it; the zero address runs the step without writing, until the receiver is deployed.
		 */
		lookalikeReceiver: z.string().regex(ADDRESS).optional(),
		/**
		 * Unix seconds from which a receiver's floor counts as the network's. Absent or 0 means not
		 * set yet, and the catch-up then writes nothing.
		 */
		activationTime: z.number().int().min(0).optional(),
		/** Passports the catch-up asks for per run, 0 to turn the catch-up off. */
		backlogPerRun: z.number().int().min(0).max(MAX_BACKLOG).default(MAX_BACKLOG),
		/** Look-alike reports a day the catch-up may write, 0 to turn the look-alike step off. */
		lookalikesPerDay: z.number().int().min(0).default(1000),
	})
	.refine((config) => config.matchThreshold === LOOKALIKE_PHASH_BITS, {
		message: `matchThreshold must be the shared ${LOOKALIKE_PHASH_BITS}, from lookalike-rule.ts`,
	})
	.refine(
		(config) =>
			config.lookalikeReceiver === undefined ||
			config.lookalikeReceiver.toLowerCase() !== config.receiver.toLowerCase(),
		{ message: "lookalikeReceiver must not be the verdict receiver" },
	);
type Config = z.infer<typeof configSchema>;

const pairSchema = z.object({
	variant: z.enum(DIHEDRAL_NAMES as [FingerprintPair["variant"], ...FingerprintPair["variant"][]]),
	phash: z.string(),
	blockhash: z.string(),
});

const measurementSchema = z.object({
	recomputed: z.string(),
	distance: z.number(),
	blockhashDistance: z.number(),
	matched: z.boolean(),
	pairs: z.array(pairSchema),
});
type Measurement = z.infer<typeof measurementSchema>;

const answerSchema = z.object({
	kind: z.enum(["ok", "no-answer"]),
	ids: z.array(z.string()),
	reason: z.string(),
});
type FlatAnswer = z.infer<typeof answerSchema>;

const registryAbi = parseAbi([
	"event PassportRegistered(bytes32 indexed passportId, address indexed creator, uint256 indexed generatorAgentId, bytes32 parentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, string metadataURI)",
	"function getPassport(bytes32 id) view returns ((bytes32 exactHash, bytes32 parentId, address creator, uint256 generatorAgentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, uint64 registeredAt, bool disputed, string metadataURI))",
]);

const receiverAbi = parseAbi(["function lastExecutedAt(bytes32 passportId) view returns (uint64)"]);

const lookalikesAbi = parseAbi([
	"function originOf(bytes32 passportId) view returns ((bytes32 earlierId, uint16 phashDistance, uint16 blockhashDistance, bool earlierSealed, uint64 executedAt, uint64 writtenAt))",
]);

const PASSPORT_REGISTERED_TOPIC = keccak256(
	toBytes(
		"PassportRegistered(bytes32,address,uint256,bytes32,uint64,bytes32,bytes32,uint8,uint8,string)",
	),
);

/**
 * The first word of every look-alike report. MoolamLookalikes refuses a report without it, and the
 * verdict receiver reads its first word as a chain id, so neither receiver accepts the other's.
 */
const LOOKALIKE_KIND = keccak256(toBytes("moolam.lookalike.v1"));

const ZERO_ID: Hex = `0x${"0".repeat(64)}`;

/**
 * From the contracts' own gas report: attest costs at most 154k, and the receiver test measured
 * 267k for the whole forwarder call including the signature check. A million leaves room for a
 * passport whose attestation list is long, and still caps what one run can spend.
 */
const GAS_LIMIT = "1000000";

/**
 * The look-alike receiver calls nothing: the forwarder and template's share of the verdict path
 * (267k less attest's 154k, about 113k) plus one decode, two new storage slots and one event, about
 * 60k, is under 180k. Monad charges the limit rather than the gas used, so this sits near twice
 * that instead of at the verdict's million.
 */
const LOOKALIKE_GAS_LIMIT = "400000";

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

/**
 * The most HTTP calls measuring one picture can make: the document, the unseal record of a sealed
 * passport, and the thumbnail. A run reserves all three before it starts, whatever the document
 * turns out to be.
 */
const PICTURE_CALLS = 3;

/** The catch-up looks only at passports registered at least this long before the run. */
const BACKLOG_LAG_SECONDS = 600;

/**
 * Both look-alike routes answer the same bytes to the same request, so nodes may share one answer
 * for a minute instead of each asking the service. Best effort: a node that misses the cache asks
 * for itself and gets the same body.
 */
const SHARED_ANSWER = { store: true, maxAge: "60s" };

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
 * One node's own measurement: download the picture the passport points at, fingerprint it in all
 * eight turns and mirrors, and measure how far the upright one is from the fingerprints the creator
 * registered. A match needs both: the pHash within the match threshold and the block hash within
 * the shared 40 bits, so a passport carrying an honest pHash beside a made-up block hash does not
 * match (L11). Every node does this by itself and consensus only accepts the run when a quorum
 * produced the identical answer, so the downloaded bytes never have to match across nodes, only
 * the verdict and the sixteen fingerprints do.
 */
const measureThumbnail = (
	nodeRuntime: NodeRuntime<Config>,
	metadataURI: string,
	storedPhashHex: string,
	storedBlockhash: string,
	passportId: string,
): Measurement => {
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

	const pairs = dihedralFingerprints(decodeJpeg(bytes));
	const upright = pairs[0];
	if (upright === undefined || upright.variant !== "identity") {
		throw new Error("the eight fingerprints did not start with the upright picture");
	}
	const distance = hamming64(BigInt(upright.phash), BigInt(storedPhashHex));
	const blockhashDistance = hammingHex(upright.blockhash, storedBlockhash);

	return {
		recomputed: upright.phash,
		distance,
		blockhashDistance,
		matched:
			distance <= nodeRuntime.config.matchThreshold && blockhashDistance <= LOOKALIKE_BLOCKHASH_BITS,
		pairs,
	};
};

/** The answer a node got, flattened so consensus compares one plain shape. */
const flat = (answer: ServiceAnswer): FlatAnswer =>
	answer.kind === "ok"
		? { kind: "ok", ids: answer.ids, reason: "" }
		: { kind: "no-answer", ids: [], reason: answer.reason };

/**
 * One POST to the candidates route with this run's eight fingerprint pairs and the new passport's
 * registration time. Whatever comes back is only a proposal: the run proves each id on chain.
 */
const askCandidates = (
	nodeRuntime: NodeRuntime<Config>,
	pairs: FingerprintPair[],
	asOf: number,
): FlatAnswer => {
	const base = nodeRuntime.config.verifierUrl.replace(/\/+$/, "");
	const request = {
		fingerprints: pairs.map((pair) => ({ phash: pair.phash, blockhash: pair.blockhash })),
		asOf,
	};
	let response: { statusCode: number; body: Uint8Array };
	try {
		response = httpClient
			.sendRequest(nodeRuntime, {
				url: `${base}/lookalikes/candidates`,
				method: "POST",
				// The capability takes a request body as base64.
				body: bytesToBase64(new TextEncoder().encode(JSON.stringify(request))),
				multiHeaders: { "Content-Type": { values: ["application/json"] } },
				timeout: "10s",
				cacheSettings: SHARED_ANSWER,
			})
			.result();
	} catch {
		return flat({ kind: "no-answer", reason: "the candidates route did not answer" });
	}
	return flat(readServiceAnswer("candidates", response.statusCode, response.body, "candidates", MAX_CANDIDATES));
};

/** One GET to the backlog route for up to `n` passports registered before `asOf`, oldest first. */
const askBacklog = (nodeRuntime: NodeRuntime<Config>, asOf: number, n: number): FlatAnswer => {
	const base = nodeRuntime.config.verifierUrl.replace(/\/+$/, "");
	let response: { statusCode: number; body: Uint8Array };
	try {
		response = httpClient
			.sendRequest(nodeRuntime, {
				url: `${base}/lookalikes/backlog?asOf=${asOf}&n=${n}`,
				method: "GET",
				timeout: "10s",
				cacheSettings: SHARED_ANSWER,
			})
			.result();
	} catch {
		return flat({ kind: "no-answer", reason: "the backlog route did not answer" });
	}
	return flat(readServiceAnswer("backlog", response.statusCode, response.body, "passports", n));
};

/**
 * Whether the earlier passport's picture is kept from view: its document read by the pinned rule
 * (R7) says `sealed: true`, or the document cannot be read at all. An unreadable document counts as
 * sealed, which shows no picture, never as public (L12).
 */
const readSealed = (nodeRuntime: NodeRuntime<Config>, metadataURI: string, passportId: string): boolean => {
	try {
		return readMetadata(nodeRuntime, metadataURI, passportId).sealed === true;
	} catch {
		return true;
	}
};

const evmClientFor = (config: Config) => {
	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);
	return { network, evmClient: new cre.capabilities.EVMClient(network.chainSelector.selector) };
};
type Chain = ReturnType<typeof evmClientFor>;

/** One view call at a block height, as raw return data. Throws when the node cannot serve it. */
const callView = (
	runtime: Runtime<Config>,
	chain: Chain,
	to: string,
	data: Hex,
	readAt: ReturnType<typeof blockNumber>,
): Hex => {
	const call = chain.evmClient
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: to as Address, data }),
			blockNumber: readAt,
		})
		.result();
	return bytesToHex(call.data);
};

/** One `getPassport` call at a fixed block height, decoded. Throws when the node cannot serve it. */
const readPassport = (
	runtime: Runtime<Config>,
	chain: Chain,
	passportId: Hex,
	readAt: ReturnType<typeof blockNumber>,
) =>
	decodeFunctionResult({
		abi: registryAbi,
		functionName: "getPassport",
		data: callView(
			runtime,
			chain,
			runtime.config.registry,
			encodeFunctionData({ abi: registryAbi, functionName: "getPassport", args: [passportId] }),
			readAt,
		),
	});
type Passport = ReturnType<typeof readPassport>;

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

/** Signs a payload into a report and writes it to one receiver. */
const writeTo = (runtime: Runtime<Config>, chain: Chain, receiver: string, payload: Hex, gasLimit: string) => {
	const report = runtime.report(prepareReportRequest(payload)).result();
	const write = chain.evmClient
		.writeReport(runtime, { receiver, report, gasConfig: { gasLimit } })
		.result();
	const txHash = bytesToHex(write.txHash || new Uint8Array(32));
	runtime.log(
		`write to ${receiver}: transaction ${statusName(TxStatus, write.txStatus)}, receiver ${statusName(EVM_PB.ReceiverContractExecutionStatus, write.receiverContractExecutionStatus)}`,
	);
	return { txHash, refused: writeRefusal(write) };
};

const nowSeconds = (runtime: Runtime<Config>): number => Math.floor(runtime.now().getTime() / 1000);

/**
 * Chainlink's guidance for a state changing write: a signed report can be sent again after a first
 * attempt failed, or sent on another chain, so the chain it was built for and the moment it was
 * built travel inside the signed payload. The receiver rejects both kinds of replay.
 */
const writeVerdict = (
	runtime: Runtime<Config>,
	chain: Chain,
	passportId: Hex,
	measurement: Measurement,
): string => {
	const payload = encodeAbiParameters(
		parseAbiParameters(
			"uint256 chainId, uint64 executedAt, bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed",
		),
		[
			BigInt(chain.network.chainId),
			BigInt(nowSeconds(runtime)),
			passportId,
			measurement.matched,
			measurement.distance,
			toBytes32(BigInt(measurement.recomputed)),
		],
	);
	const { txHash, refused } = writeTo(runtime, chain, runtime.config.receiver, payload, GAS_LIMIT);
	if (refused !== null) {
		// The recheck runner reads a `report tx` line as a verdict that landed, so a refusal never
		// prints one.
		throw new Error(`${refused} (transaction ${txHash})`);
	}
	runtime.log(`report tx ${txHash}`);
	return txHash;
};

/** The node-mode measurement, through consensus. Throws when the picture cannot be checked. */
const measure = (runtime: Runtime<Config>, passportId: Hex, passport: Passport): Measurement =>
	runtime
		.runInNodeMode(measureThumbnail, consensusIdenticalAggregation<Measurement>(), {
			schema: measurementSchema,
		})(passport.metadataURI, toHex64(passport.phash), passport.blockhash256, passportId)
		.result();

const logMeasurement = (runtime: Runtime<Config>, measurement: Measurement): void => {
	// The recheck runner reads this exact line for the verdict, so the block hash goes on its own.
	runtime.log(
		`recomputed ${measurement.recomputed} distance ${measurement.distance} matched ${measurement.matched}`,
	);
	runtime.log(`block hash distance ${measurement.blockhashDistance} of 256`);
};

type LookalikeSwitch = { on: true; receiver: string; dryRun: boolean } | { on: false; why: string };

/**
 * Whether the look-alike step runs at all. Off when config names no receiver (the simulator's
 * config.json) or the daily ceiling is 0. With the zero address it runs every read and call and
 * writes nothing, so a dry run can show the step before MoolamLookalikes exists.
 */
const lookalikeSwitch = (config: Config): LookalikeSwitch => {
	if (config.lookalikeReceiver === undefined) {
		return { on: false, why: "config names no lookalikeReceiver" };
	}
	if (config.lookalikesPerDay === 0) {
		return { on: false, why: "lookalikesPerDay is 0" };
	}
	return {
		on: true,
		receiver: config.lookalikeReceiver,
		dryRun: BigInt(config.lookalikeReceiver) === 0n,
	};
};

type LookalikeOutcome =
	| { kind: "skipped"; why: string }
	| { kind: "found"; earlierId: Hex; tx: string | null }
	| { kind: "failed"; reason: string };

/**
 * The look-alike step for one original passport whose own picture this run has measured. The
 * verify service proposes up to three candidates; each is read from the registry here and kept only
 * as judgeCandidates allows (L8, L10, L11). The earliest kept, or the zero id for none among the
 * candidates, is written to MoolamLookalikes with both distances and whether its picture is kept
 * from view (L12). No answer from the service, a candidate the chain would not serve, and a refused
 * write all write nothing and come back as "failed" (L13, L17).
 *
 * Costs at most 2 HTTP calls (the candidates route, the earlier passport's document) and 3 contract
 * reads, which the caller has reserved.
 */
const lookalikeStep = (
	runtime: Runtime<Config>,
	chain: Chain,
	budget: Budget,
	sw: Extract<LookalikeSwitch, { on: true }>,
	passportId: Hex,
	passport: Passport,
	measurement: Measurement,
): LookalikeOutcome => {
	if (!isOriginal(passport)) {
		return { kind: "skipped", why: "an Edited passport skips the look-alike step" };
	}
	if (!measurement.matched) {
		return {
			kind: "skipped",
			why: "this run's fingerprints do not match the stored ones, so it proves no look-alike",
		};
	}

	budget.spend(1, 0);
	const answer = runtime
		.runInNodeMode(askCandidates, consensusIdenticalAggregation<FlatAnswer>(), { schema: answerSchema })(
			measurement.pairs,
			Number(passport.registeredAt),
		)
		.result();
	if (answer.kind !== "ok") {
		return { kind: "failed", reason: `${answer.reason}, so no look-alike was written` };
	}
	runtime.log(`look-alike candidates proposed: ${answer.ids.length === 0 ? "none" : answer.ids.join(", ")}`);

	const records: { id: string; record: Passport }[] = [];
	for (const id of answer.ids) {
		budget.spend(0, 1);
		let record: Passport;
		try {
			record = readPassport(runtime, chain, id as Hex, LATEST_BLOCK_NUMBER);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { kind: "failed", reason: `candidate ${id} could not be read (${detail}), so no look-alike was written` };
		}
		records.push({ id, record });
	}

	const judgement = judgeCandidates(
		{ id: passportId, registeredAt: passport.registeredAt, creator: passport.creator },
		measurement.pairs,
		records,
	);
	for (const line of judgement.refused) runtime.log(`look-alike ${line}`);

	const kept = judgement.kept;
	let earlierSealed = false;
	if (kept !== null) {
		const earlier = records.find((entry) => entry.id.toLowerCase() === kept.id);
		budget.spend(1, 0);
		try {
			earlierSealed = runtime
				.runInNodeMode(readSealed, consensusIdenticalAggregation<boolean>())(earlier?.record.metadataURI ?? "", kept.id)
				.result();
		} catch {
			earlierSealed = true;
		}
	}
	const earlierId = (kept?.id ?? ZERO_ID) as Hex;
	runtime.log(
		kept === null
			? "look-alike: no earlier passport by someone else among the candidates"
			: `look-alike: earlier passport ${kept.id} registered ${kept.registeredAt}, pHash ${kept.phashDistance} and block hash ${kept.blockhashDistance} bits apart, sealed ${earlierSealed}`,
	);

	if (sw.dryRun) {
		runtime.log("look-alike report not written: lookalikeReceiver is the zero address until MoolamLookalikes is deployed");
		return { kind: "found", earlierId, tx: null };
	}

	const payload = encodeAbiParameters(
		parseAbiParameters(
			"bytes32 kind, uint256 chainId, uint64 executedAt, bytes32 passportId, bytes32 earlierId, uint16 phashDistance, uint16 blockhashDistance, bool earlierSealed",
		),
		[
			LOOKALIKE_KIND,
			BigInt(chain.network.chainId),
			BigInt(nowSeconds(runtime)),
			passportId,
			earlierId,
			kept?.phashDistance ?? 0,
			kept?.blockhashDistance ?? 0,
			earlierSealed,
		],
	);
	const { txHash, refused } = writeTo(runtime, chain, sw.receiver, payload, LOOKALIKE_GAS_LIMIT);
	if (refused !== null) {
		return { kind: "failed", reason: `the look-alike write did not land: ${refused} (transaction ${txHash})` };
	}
	// Worded apart from the verdict's `report tx` line, which the recheck runner reads.
	runtime.log(`look-alike written in tx ${txHash}`);
	return { kind: "found", earlierId, tx: txHash };
};

const describeOutcome = (outcome: LookalikeOutcome): string => {
	if (outcome.kind === "skipped") return `look-alike skipped (${outcome.why})`;
	if (outcome.kind === "failed") return `look-alike failed (${outcome.reason})`;
	return `look-alike ${outcome.earlierId === ZERO_ID ? "none" : outcome.earlierId} ${outcome.tx === null ? "not written (dry run)" : `tx ${outcome.tx}`}`;
};

export const onPassportRegistered = (runtime: Runtime<Config>, log: EVMLog): string => {
	const config = runtime.config;
	const budget = new Budget();

	const decoded = decodeEventLog({
		abi: registryAbi,
		data: bytesToHex(log.data),
		topics: log.topics.map((topic: Uint8Array) => bytesToHex(topic)) as [Hex, ...Hex[]],
	});
	if (decoded.eventName !== "PassportRegistered") {
		throw new Error(`unexpected event ${decoded.eventName}`);
	}
	const passportId = decoded.args.passportId;
	const chain = evmClientFor(config);

	// The event is only the wake-up call. Everything the attestation is built from is read back out
	// of the registry, so a forged log cannot talk this workflow into signing a report about it.
	const triggerBlock = log.blockNumber ? protoBigIntToBigint(log.blockNumber) : undefined;
	let readAt = triggerBlock === undefined ? LATEST_BLOCK_NUMBER : blockNumber(triggerBlock);
	let where = triggerBlock === undefined ? "the latest block" : `block ${triggerBlock}`;

	let passport: Passport | undefined;
	let lastFailure = "";
	for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
		budget.spend(0, 1);
		try {
			const candidate = readPassport(runtime, chain, passportId, readAt);
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

	runtime.log(`passport ${passportId} stored phash ${toHex64(passport.phash)}`);

	budget.spend(PICTURE_CALLS, 0);
	const measurement = measure(runtime, passportId, passport);
	logMeasurement(runtime, measurement);

	const txHash = writeVerdict(runtime, chain, passportId, measurement);
	const verdict = `${passportId} distance ${measurement.distance} matched ${measurement.matched} tx ${txHash}`;

	// The verdict has landed before any of this starts, so nothing in the look-alike step can hold
	// it back. Worst case for the whole run: 3 registry reads, 3 picture calls, then 1 candidates
	// call, 3 candidate reads and 1 document, so 5 of 15 HTTP calls and 6 of 15 reads.
	const sw = lookalikeSwitch(config);
	if (!sw.on) {
		runtime.log(`look-alike step off: ${sw.why}`);
		return verdict;
	}
	const outcome = lookalikeStep(runtime, chain, budget, sw, passportId, passport, measurement);
	runtime.log(describeOutcome(outcome));
	if (outcome.kind === "failed" && !sw.dryRun) {
		throw new Error(`the verdict landed in tx ${txHash}, but ${outcome.reason}`);
	}
	return `${verdict}; ${describeOutcome(outcome)}`;
};

/**
 * The catch-up, every ten minutes: passports Chainlink's log trigger dropped or that were
 * registered before activation. The backlog route names them; the chain decides what is missing.
 * For each id the run reads the passport, the verdict receiver's floor and, for an original, the
 * look-alike receiver's floor, and writes only what has no record at or after activation (L13, L14).
 *
 * Budget, by design (L15). 1 HTTP call for the backlog. Per passport: 2 reads for the passport and
 * the verdict floor, 1 more for the look-alike floor of an original; then, only when something is
 * missing, 3 HTTP calls for the picture, and for a missing look-alike 2 more calls (candidates,
 * document) and 3 more reads (the candidates). The worst passport is 5 calls and 6 reads, so at
 * least two fit in 15 and 15; one that needs only its verdict is 3 calls and 2 reads, so four fit.
 * A passport is started only when its worst case still fits, and the rest wait for the next run,
 * which the backlog offers again because their floors are still missing.
 */
export const onBacklogCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
	const config = runtime.config;
	const activationTime = config.activationTime ?? 0;
	if (activationTime === 0) {
		runtime.log("catch-up off: activationTime is not set, so no floor can be judged");
		return "catch-up off: activationTime is not set";
	}

	const budget = new Budget();
	const chain = evmClientFor(config);
	const now = nowSeconds(runtime);
	const asOf = now - BACKLOG_LAG_SECONDS;

	budget.spend(1, 0);
	const backlog = runtime
		.runInNodeMode(askBacklog, consensusIdenticalAggregation<FlatAnswer>(), { schema: answerSchema })(
			asOf,
			config.backlogPerRun,
		)
		.result();
	if (backlog.kind !== "ok") {
		throw new Error(`${backlog.reason}, so nothing was written`);
	}
	runtime.log(`backlog as of ${asOf}: ${backlog.ids.length === 0 ? "empty" : backlog.ids.join(", ")}`);

	const sw = lookalikeSwitch(config);
	const lookalikesOn = sw.on && !sw.dryRun;
	let lookalikesLeft = lookalikesOn ? lookalikeWritesThisRun(config.lookalikesPerDay, now) : 0;
	if (!lookalikesOn) {
		runtime.log(`catch-up writes verdicts only: ${sw.on ? "lookalikeReceiver is the zero address" : sw.why}`);
	}

	const done: string[] = [];
	const failures: string[] = [];
	for (const id of backlog.ids) {
		const passportId = id as Hex;
		if (!budget.fits(0, lookalikesOn ? 3 : 2)) {
			runtime.log(`budget spent: ${passportId} and the rest wait for the next run`);
			break;
		}

		budget.spend(0, 1);
		let passport: Passport;
		try {
			passport = readPassport(runtime, chain, passportId, LATEST_BLOCK_NUMBER);
		} catch (error) {
			failures.push(`${passportId} could not be read (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		if (passport.registeredAt === 0n) {
			runtime.log(`${passportId} is not in the registry, skipped`);
			continue;
		}

		budget.spend(0, 1);
		const verdictFloor = decodeFunctionResult({
			abi: receiverAbi,
			functionName: "lastExecutedAt",
			data: callView(
				runtime,
				chain,
				config.receiver,
				encodeFunctionData({ abi: receiverAbi, functionName: "lastExecutedAt", args: [passportId] }),
				LATEST_BLOCK_NUMBER,
			),
		});
		const verdictMissing = verdictFloor < BigInt(activationTime);

		let lookalikeMissing = false;
		if (lookalikesOn && sw.on && isOriginal(passport)) {
			budget.spend(0, 1);
			const origin = decodeFunctionResult({
				abi: lookalikesAbi,
				functionName: "originOf",
				data: callView(
					runtime,
					chain,
					sw.receiver,
					encodeFunctionData({ abi: lookalikesAbi, functionName: "originOf", args: [passportId] }),
					LATEST_BLOCK_NUMBER,
				),
			});
			lookalikeMissing = origin.executedAt < BigInt(activationTime);
			if (lookalikeMissing && lookalikesLeft === 0) {
				runtime.log(`${passportId}: this run's share of lookalikesPerDay is used, its look-alike waits`);
				lookalikeMissing = false;
			}
		}

		if (!verdictMissing && !lookalikeMissing) {
			runtime.log(`${passportId}: nothing missing`);
			continue;
		}
		const needHttp = PICTURE_CALLS + (lookalikeMissing ? 2 : 0);
		const needChain = lookalikeMissing ? MAX_CANDIDATES : 0;
		if (!budget.fits(needHttp, needChain)) {
			runtime.log(`budget spent: ${passportId} and the rest wait for the next run`);
			break;
		}

		budget.spend(PICTURE_CALLS, 0);
		let measurement: Measurement;
		try {
			measurement = measure(runtime, passportId, passport);
		} catch (error) {
			failures.push(`${passportId} could not be measured (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		logMeasurement(runtime, measurement);

		if (verdictMissing) {
			try {
				writeVerdict(runtime, chain, passportId, measurement);
				done.push(`${passportId} verdict`);
			} catch (error) {
				failures.push(`${passportId} verdict: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (lookalikeMissing && sw.on) {
			const outcome = lookalikeStep(runtime, chain, budget, sw, passportId, passport, measurement);
			runtime.log(`${passportId}: ${describeOutcome(outcome)}`);
			if (outcome.kind === "failed") {
				failures.push(`${passportId}: ${outcome.reason}`);
			} else if (outcome.kind === "found" && outcome.tx !== null) {
				lookalikesLeft -= 1;
				done.push(`${passportId} look-alike`);
			}
		}
	}

	const summary = `catch-up wrote ${done.length === 0 ? "nothing" : done.join(", ")}`;
	if (failures.length > 0) {
		throw new Error(`${summary}; not done: ${failures.join("; ")}`);
	}
	return summary;
};

export const initWorkflow = (config: Config) => {
	const { evmClient } = evmClientFor(config);

	// The log trigger stays first: the recheck runner and the README simulate with --trigger-index 0.
	const onRegistration = cre.handler(
		evmClient.logTrigger(
			logTriggerConfig({
				addresses: [config.registry as Hex],
				topics: [[PASSPORT_REGISTERED_TOPIC]],
			}),
		),
		onPassportRegistered,
	);
	if (config.backlogPerRun === 0) {
		return [onRegistration];
	}
	return [
		onRegistration,
		cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: "0 */10 * * * *" }), onBacklogCron),
	];
};
