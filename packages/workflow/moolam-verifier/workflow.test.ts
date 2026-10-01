/**
 * Drives whole runs of both handlers through the CRE SDK's own test runtime, with the registry, both
 * receivers, the gateway and the verify service's routes mocked: a write only counts when the
 * transaction and the receiver both say it succeeded, and the look-alike step and the catch-up hold
 * L8 to L15 and L17 of kitchen/research/originality-threat-model.md.
 *
 * Not covered here: what Chainlink's real forwarder or the simulator actually return (the dry-run
 * simulate in the README shows that), node consensus across more than one node, the fingerprint
 * maths against the service's (packages/verifier/test/workflow-phash.test.ts and
 * workflow-blockhash.test.ts), the picture choice (packages/recheck-runner/test/workflow-picture.test.ts),
 * and the verify service's own routes (their tests live in packages/verifier).
 */
import { expect } from "bun:test";
import { getNetwork, type EVMLog } from "@chainlink/cre-sdk";
import {
	addContractMock,
	EvmMock,
	HttpActionsMock,
	newTestRuntime,
	REPORT_METADATA_HEADER_LENGTH,
	test,
} from "@chainlink/cre-sdk/test";
import { encode } from "jpeg-js";
import {
	bytesToHex,
	decodeAbiParameters,
	encodeAbiParameters,
	encodeEventTopics,
	hexToBytes,
	keccak256,
	parseAbi,
	parseAbiParameters,
	toBytes,
	type Address,
	type Hex,
} from "viem";
import simulatorConfig from "./config.json";
import networkConfig from "./config.network.json";
import { decodeJpeg } from "./decode";
import { dihedralFingerprints } from "./dihedral";
import { Budget, CRON_RUNS_PER_DAY, lookalikeWritesThisRun, readServiceAnswer } from "./lookalike";
import { configSchema, initWorkflow, onBacklogCron, onPassportRegistered } from "./workflow";

const LOOKALIKES: Address = "0x00000000000000000000000000000000000010aa";
const ACTIVATION = 1_700_000_000;
const NOW_MS = (ACTIVATION + 86_400) * 1000;

const config = configSchema.parse({ ...networkConfig, lookalikeReceiver: LOOKALIKES, activationTime: ACTIVATION });

const registryAbi = parseAbi([
	"event PassportRegistered(bytes32 indexed passportId, address indexed creator, uint256 indexed generatorAgentId, bytes32 parentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, string metadataURI)",
	"function getPassport(bytes32 id) view returns ((bytes32 exactHash, bytes32 parentId, address creator, uint256 generatorAgentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, uint64 registeredAt, bool disputed, string metadataURI))",
]);
const receiverAbi = parseAbi(["function lastExecutedAt(bytes32 passportId) view returns (uint64)"]);
const lookalikesAbi = parseAbi([
	"function originOf(bytes32 passportId) view returns ((bytes32 earlierId, uint16 phashDistance, uint16 blockhashDistance, bool earlierSealed, uint64 executedAt, uint64 writtenAt))",
]);

const id = (byte: string): Hex => `0x${byte.repeat(32)}`;
const PASSPORT_ID = id("ab");
const EARLIER = id("01");
const OTHER = id("02");
const THIRD = id("03");
const CREATOR: Address = "0x00000000000000000000000000000000000000c1";
const SOMEONE_ELSE: Address = "0x00000000000000000000000000000000000000c2";
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const TX_HASH_BASE64 = Buffer.from(new Uint8Array(32).fill(0x11)).toString("base64");
const TX = `0x${"11".repeat(32)}`;
const REGISTERED_AT = 1_700_050_000n;
const NEW_CID = "bafkreinewthumbnail";

const inline = (document: Record<string, unknown>): string =>
	`data:application/json,${encodeURIComponent(JSON.stringify(document))}`;

const thumbnail = (() => {
	const width = 64;
	const height = 48;
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const x = i % width;
		const y = Math.floor(i / width);
		data.set([x * 4, y * 5, (x * y) % 256, 255], i * 4);
	}
	return new Uint8Array(encode({ data, width, height }, 90).data);
})();

/** This picture's eight fingerprint pairs, exactly as the run measures them. */
const pairs = dihedralFingerprints(decodeJpeg(thumbnail));
const upright = pairs[0] as (typeof pairs)[number];
const quarterTurn = pairs[1] as (typeof pairs)[number];

const flipBits = (hex: string): Hex =>
	`0x${[...hex.slice(2)].map((c) => (15 - Number.parseInt(c, 16)).toString(16)).join("")}`;
/** Turns `bits` low bits of a hex fingerprint over, to place a stored value a known distance away. */
const nudge = (hex: string, bits: number): Hex => {
	const value = BigInt(hex) ^ ((1n << BigInt(bits)) - 1n);
	return `0x${value.toString(16).padStart(hex.length - 2, "0")}`;
};

interface Record_ {
	parentId?: Hex;
	creator?: Address;
	registeredAt: bigint;
	phash: Hex;
	blockhash: Hex;
	metadataURI?: string;
}

const passportRecord = (r: Record_) => ({
	exactHash: ZERO32,
	parentId: r.parentId ?? ZERO32,
	creator: r.creator ?? SOMEONE_ELSE,
	generatorAgentId: 0n,
	phash: BigInt(r.phash),
	blockhash256: r.blockhash,
	manifestHash: ZERO32,
	kind: 0,
	fingerprintVersion: 1,
	registeredAt: r.registeredAt,
	disputed: false,
	metadataURI: r.metadataURI ?? inline({ sealed: false, thumbnail: "ipfs://bafkreiearlier" }),
});

/** The new passport, stored with this picture's own fingerprints unless a test says otherwise. */
const newPassport = (over: Partial<Record_> = {}): Record_ => ({
	creator: CREATOR,
	registeredAt: REGISTERED_AT,
	phash: upright.phash as Hex,
	blockhash: upright.blockhash as Hex,
	metadataURI: inline({ thumbnail: `ipfs://${NEW_CID}` }),
	...over,
});

/** An earlier passport by someone else whose stored fingerprints are this picture's. */
const earlierLookalike = (over: Partial<Record_> = {}): Record_ => ({
	registeredAt: REGISTERED_AT - 100n,
	phash: upright.phash as Hex,
	blockhash: upright.blockhash as Hex,
	...over,
});

type WriteReply = { txStatus: string; receiverContractExecutionStatus?: string; errorMessage?: string };
const LANDED: WriteReply = {
	txStatus: "TX_STATUS_SUCCESS",
	receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
};

interface World {
	passports: Record<string, Record_>;
	unreadable?: string[];
	verdictFloor?: Record<string, bigint>;
	originFloor?: Record<string, bigint>;
	candidates?: { status: number; body: string };
	backlog?: { status: number; body: string };
	documents?: Record<string, { status: number; body: string }>;
	verdictReply?: WriteReply;
	lookalikeReply?: WriteReply;
}

const answer = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

const decodeVerdict = (payload: Hex) =>
	decodeAbiParameters(parseAbiParameters("uint256, uint64, bytes32, bool, uint16, bytes32"), payload);
const decodeLookalike = (payload: Hex) => {
	expect((payload.length - 2) / 2).toBe(256);
	const [kind, chainId, executedAt, passportId, earlierId, phashDistance, blockhashDistance, earlierSealed] =
		decodeAbiParameters(
			parseAbiParameters("bytes32, uint256, uint64, bytes32, bytes32, uint16, uint16, bool"),
			payload,
		);
	return { kind, chainId, executedAt, passportId, earlierId, phashDistance, blockhashDistance, earlierSealed };
};

const triggerLog = (): EVMLog => {
	const record = passportRecord(newPassport());
	const topics = encodeEventTopics({
		abi: registryAbi,
		eventName: "PassportRegistered",
		args: { passportId: PASSPORT_ID, creator: CREATOR, generatorAgentId: 0n },
	}) as Hex[];
	const data = encodeAbiParameters(parseAbiParameters("bytes32, uint64, bytes32, bytes32, uint8, uint8, string"), [
		ZERO32,
		record.phash,
		record.blockhash256,
		ZERO32,
		0,
		1,
		record.metadataURI,
	]);
	return { topics: topics.map((topic) => hexToBytes(topic)), data: hexToBytes(data) } as unknown as EVMLog;
};

const run = (world: World, trigger: "log" | "cron", runConfig: typeof config = config) => {
	const network = getNetwork({ chainFamily: "evm", chainSelectorName: runConfig.chain });
	if (!network) throw new Error(`network not found: ${runConfig.chain}`);
	const evm = EvmMock.testInstance(network.chainSelector.selector);
	const seen = {
		http: [] as string[],
		reads: [] as string[],
		verdicts: [] as ReturnType<typeof decodeVerdict>[],
		lookalikes: [] as ReturnType<typeof decodeLookalike>[],
		candidateRequests: [] as { fingerprints: { phash: string; blockhash: string }[]; asOf: number }[],
	};

	const registry = addContractMock(evm, { address: runConfig.registry as Address, abi: registryAbi });
	registry.getPassport = (passportId: unknown) => {
		const key = String(passportId).toLowerCase();
		seen.reads.push(`getPassport ${key}`);
		if (world.unreadable?.includes(key)) throw new Error("the node could not serve this read");
		const record = world.passports[key];
		return record === undefined ? passportRecord({ registeredAt: 0n, phash: "0x00", blockhash: ZERO32 }) : passportRecord(record);
	};

	const verdictReceiver = addContractMock(evm, { address: runConfig.receiver as Address, abi: receiverAbi });
	verdictReceiver.lastExecutedAt = (passportId: unknown) => {
		seen.reads.push(`lastExecutedAt ${String(passportId).toLowerCase()}`);
		return world.verdictFloor?.[String(passportId).toLowerCase()] ?? 0n;
	};
	verdictReceiver.writeReport = (input) => {
		seen.verdicts.push(decodeVerdict(bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))));
		return { ...(world.verdictReply ?? LANDED), txHash: TX_HASH_BASE64 };
	};

	const lookalikes = addContractMock(evm, { address: LOOKALIKES, abi: lookalikesAbi });
	lookalikes.originOf = (passportId: unknown) => {
		seen.reads.push(`originOf ${String(passportId).toLowerCase()}`);
		return {
			earlierId: ZERO32,
			phashDistance: 0,
			blockhashDistance: 0,
			earlierSealed: false,
			executedAt: world.originFloor?.[String(passportId).toLowerCase()] ?? 0n,
			writtenAt: 0n,
		};
	};
	lookalikes.writeReport = (input) => {
		seen.lookalikes.push(decodeLookalike(bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))));
		return { ...(world.lookalikeReply ?? LANDED), txHash: TX_HASH_BASE64 };
	};

	HttpActionsMock.testInstance().sendRequest = (input) => {
		seen.http.push(`${input.method} ${input.url}`);
		const base = runConfig.verifierUrl;
		if (input.url === `${base}/lookalikes/candidates`) {
			seen.candidateRequests.push(JSON.parse(new TextDecoder().decode(input.body)));
			const reply = world.candidates ?? answer({ status: "ok", candidates: [] });
			return { statusCode: reply.status, body: Buffer.from(reply.body).toString("base64") };
		}
		if (input.url.startsWith(`${base}/lookalikes/backlog?`)) {
			const reply = world.backlog ?? answer({ status: "ok", passports: [] });
			return { statusCode: reply.status, body: Buffer.from(reply.body).toString("base64") };
		}
		const cid = input.url.slice(runConfig.gateway.length);
		if (cid === NEW_CID) {
			return { statusCode: 200, body: Buffer.from(thumbnail).toString("base64") };
		}
		const document = world.documents?.[cid];
		if (document !== undefined) {
			return { statusCode: document.status, body: Buffer.from(document.body).toString("base64") };
		}
		return { statusCode: 404, body: "" };
	};

	const runtime = newTestRuntime(null, { timeProvider: () => NOW_MS }, runConfig);
	let outcome: { result: string } | { error: string };
	try {
		outcome = {
			result: trigger === "log" ? onPassportRegistered(runtime, triggerLog()) : onBacklogCron(runtime, {} as never),
		};
	} catch (error) {
		outcome = { error: error instanceof Error ? error.message : String(error) };
	}
	return { outcome, logs: runtime.getLogs().join("\n"), seen };
};

/** A world with the new passport and one earlier look-alike by someone else, the answer naming it. */
const lookalikeWorld = (earlier: Partial<Record_> = {}, extra: Partial<World> = {}): World => ({
	passports: { [PASSPORT_ID]: newPassport(), [EARLIER]: earlierLookalike(earlier) },
	candidates: answer({ status: "ok", candidates: [EARLIER] }),
	...extra,
});

const bareConfig = configSchema.parse(simulatorConfig);

// The verdict write, as before the look-alike step existed.

test("a write the receiver reverted fails the run and prints no report tx", () => {
	const { outcome, logs, seen } = run(
		{
			passports: { [PASSPORT_ID]: newPassport() },
			verdictReply: { txStatus: "TX_STATUS_SUCCESS", receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED" },
		},
		"log",
	);
	expect(outcome).toEqual({
		error: `the receiver refused the report, so no attestation was written (receiver status REVERTED) (transaction ${TX})`,
	});
	expect(logs).toContain(`write to ${config.receiver}: transaction SUCCESS, receiver REVERTED`);
	expect(logs).not.toContain("report tx");
	expect(seen.candidateRequests).toHaveLength(0);
});

test("a write with no receiver status fails the run", () => {
	const { outcome, logs } = run(
		{ passports: { [PASSPORT_ID]: newPassport() }, verdictReply: { txStatus: "TX_STATUS_SUCCESS" } },
		"log",
	);
	expect(outcome).toEqual({
		error: `the receiver refused the report, so no attestation was written (receiver status missing) (transaction ${TX})`,
	});
	expect(logs).not.toContain("report tx");
});

test("a write whose transaction failed fails the run with the status by name", () => {
	const { outcome, logs } = run(
		{
			passports: { [PASSPORT_ID]: newPassport() },
			verdictReply: {
				txStatus: "TX_STATUS_REVERTED",
				receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
				errorMessage: "out of gas",
			},
		},
		"log",
	);
	expect(outcome).toEqual({
		error: `the report transaction did not succeed (status REVERTED): out of gas (transaction ${TX})`,
	});
	expect(logs).not.toContain("report tx");
});

test("a write both sides accepted is the run's result, and the simulator's config runs no look-alike step", () => {
	const { outcome, logs, seen } = run({ passports: { [PASSPORT_ID]: newPassport() } }, "log", bareConfig);
	expect(outcome).toEqual({ result: `${PASSPORT_ID} distance 0 matched true tx ${TX}` });
	expect(logs).toContain(`recomputed ${upright.phash} distance 0 matched true`);
	expect(logs).toContain(`report tx ${TX}`);
	expect(logs).toContain("look-alike step off: config names no lookalikeReceiver");
	expect(seen.http).toHaveLength(1);
});

// L8: the service proposes, the chain decides.

test("L8: an earlier passport by someone else inside both thresholds is written with its distances", () => {
	const { outcome, logs, seen } = run(lookalikeWorld(), "log");
	expect("result" in outcome).toBe(true);
	expect(seen.verdicts).toHaveLength(1);
	expect(seen.lookalikes).toHaveLength(1);
	const written = seen.lookalikes[0]!;
	expect(written.kind).toBe(keccak256(toBytes("moolam.lookalike.v1")));
	expect(written.chainId).toBe(143n);
	expect(written.executedAt).toBe(BigInt(NOW_MS / 1000));
	expect(written.passportId).toBe(PASSPORT_ID);
	expect(written.earlierId).toBe(EARLIER);
	expect(written.phashDistance).toBe(0);
	expect(written.blockhashDistance).toBe(0);
	expect(written.earlierSealed).toBe(false);
	expect(logs).toContain(`look-alike written in tx ${TX}`);
	// The candidates call carries all eight of this run's pairs and the new passport's own time.
	expect(seen.candidateRequests).toEqual([
		{ fingerprints: pairs.map(({ phash, blockhash }) => ({ phash, blockhash })), asOf: Number(REGISTERED_AT) },
	]);
});

test("L8: a candidate stored as a quarter turn of the picture is found through the eight variants", () => {
	const { seen } = run(
		lookalikeWorld({ phash: quarterTurn.phash as Hex, blockhash: quarterTurn.blockhash as Hex }),
		"log",
	);
	expect(seen.lookalikes[0]!.earlierId).toBe(EARLIER);
});

test("L8: a candidate the chain reads as later never becomes the earlier id", () => {
	const { seen, logs } = run(lookalikeWorld({ registeredAt: REGISTERED_AT + 1n }), "log");
	expect(seen.lookalikes[0]!.earlierId).toBe(ZERO32);
	expect(logs).toContain("not before this passport's");
});

test("L8: a candidate by the same creator never becomes the earlier id", () => {
	const { seen } = run(lookalikeWorld({ creator: CREATOR }), "log");
	expect(seen.lookalikes[0]!.earlierId).toBe(ZERO32);
});

test("L8: a candidate too far apart never becomes the earlier id, on either hash", () => {
	const pHashOff = run(lookalikeWorld({ phash: nudge(upright.phash, 11) }), "log");
	expect(pHashOff.seen.lookalikes[0]!.earlierId).toBe(ZERO32);
	const blockOff = run(lookalikeWorld({ blockhash: nudge(upright.blockhash, 41) }), "log");
	expect(blockOff.seen.lookalikes[0]!.earlierId).toBe(ZERO32);
	const justInside = run(lookalikeWorld({ phash: nudge(upright.phash, 10), blockhash: nudge(upright.blockhash, 40) }), "log");
	expect(justInside.seen.lookalikes[0]!).toMatchObject({ earlierId: EARLIER, phashDistance: 10, blockhashDistance: 40 });
});

test("L8: a candidate the registry does not know never becomes the earlier id", () => {
	const { seen, logs } = run(
		{ passports: { [PASSPORT_ID]: newPassport() }, candidates: answer({ status: "ok", candidates: [EARLIER] }) },
		"log",
	);
	expect(seen.lookalikes[0]!.earlierId).toBe(ZERO32);
	expect(logs).toContain("is not in the registry");
});

test("L8: a candidate the node cannot read writes nothing and fails the run after the verdict landed", () => {
	const { outcome, seen } = run(lookalikeWorld({}, { unreadable: [EARLIER] }), "log");
	expect(seen.verdicts).toHaveLength(1);
	expect(seen.lookalikes).toHaveLength(0);
	expect(outcome).toMatchObject({ error: expect.stringContaining(`the verdict landed in tx ${TX}, but candidate ${EARLIER} could not be read`) });
});

test("L8: of several kept candidates the earliest is written", () => {
	const { seen } = run(
		{
			passports: {
				[PASSPORT_ID]: newPassport(),
				[EARLIER]: earlierLookalike({ registeredAt: REGISTERED_AT - 50n }),
				[OTHER]: earlierLookalike({ registeredAt: REGISTERED_AT - 500n }),
				[THIRD]: earlierLookalike({ registeredAt: REGISTERED_AT - 500n }),
			},
			candidates: answer({ status: "ok", candidates: [EARLIER, OTHER, THIRD] }),
		},
		"log",
	);
	expect(seen.lookalikes[0]!.earlierId).toBe(OTHER);
});

// L9, L10, L11.

test("L9: an Edited passport skips the look-alike step and asks the service nothing", () => {
	const world = lookalikeWorld();
	world.passports[PASSPORT_ID] = newPassport({ parentId: id("99") });
	const { outcome, seen } = run(world, "log");
	expect(outcome).toMatchObject({ result: expect.stringContaining("an Edited passport skips the look-alike step") });
	expect(seen.candidateRequests).toHaveLength(0);
	expect(seen.lookalikes).toHaveLength(0);
});

test("L10: a candidate registered in the same second is not earlier", () => {
	const { seen } = run(lookalikeWorld({ registeredAt: REGISTERED_AT }), "log");
	expect(seen.lookalikes[0]!.earlierId).toBe(ZERO32);
});

test("L11: a stored block hash this run's picture misses writes does not match and no look-alike", () => {
	const world = lookalikeWorld();
	world.passports[PASSPORT_ID] = newPassport({ blockhash: flipBits(upright.blockhash) });
	const { outcome, seen, logs } = run(world, "log");
	expect(seen.verdicts).toHaveLength(1);
	expect(seen.verdicts[0]![3]).toBe(false);
	expect(seen.verdicts[0]![4]).toBe(0);
	expect(logs).toContain("block hash distance 256 of 256");
	expect(seen.candidateRequests).toHaveLength(0);
	expect(seen.lookalikes).toHaveLength(0);
	expect(outcome).toMatchObject({ result: expect.stringContaining("do not match the stored ones") });
});

test("L11: the match threshold in config must be the shared one", () => {
	expect(() => configSchema.parse({ ...networkConfig, matchThreshold: 12 })).toThrow(/shared 10/);
});

// L12.

test("L12: an earlier passport whose document says sealed, or cannot be read, is reported sealed", () => {
	const sealedDoc = run(
		lookalikeWorld(
			{ metadataURI: "ipfs://bafkreisealeddoc" },
			{ documents: { bafkreisealeddoc: { status: 200, body: JSON.stringify({ sealed: true }) } } },
		),
		"log",
	);
	expect(sealedDoc.seen.lookalikes[0]!.earlierSealed).toBe(true);

	const publicDoc = run(
		lookalikeWorld(
			{ metadataURI: "ipfs://bafkreipublicdoc" },
			{ documents: { bafkreipublicdoc: { status: 200, body: JSON.stringify({ sealed: false, thumbnail: "ipfs://x" }) } } },
		),
		"log",
	);
	expect(publicDoc.seen.lookalikes[0]!.earlierSealed).toBe(false);

	const missing = run(lookalikeWorld({ metadataURI: "ipfs://bafkreigone" }), "log");
	expect(missing.seen.lookalikes[0]!.earlierSealed).toBe(true);

	const offRule = run(lookalikeWorld({ metadataURI: "https://example.com/doc.json" }), "log");
	expect(offRule.seen.lookalikes[0]!.earlierSealed).toBe(true);
	expect(offRule.seen.http.some((line) => line.includes("example.com"))).toBe(false);
});

// L13.

test("L13: a refused look-alike write fails the run and names the verdict that landed", () => {
	const { outcome, logs } = run(
		lookalikeWorld({}, {
			lookalikeReply: { txStatus: "TX_STATUS_SUCCESS", receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED" },
		}),
		"log",
	);
	expect(outcome).toMatchObject({
		error: expect.stringContaining(`the verdict landed in tx ${TX}, but the look-alike write did not land`),
	});
	expect(logs).toContain(`report tx ${TX}`);
	expect(logs).not.toContain("look-alike written");
});

// L17.

test("L17: a non-200 or malformed candidates answer writes nothing and fails the run", () => {
	const answers = [
		{ status: 429, body: JSON.stringify({ status: "ok", candidates: [] }) },
		{ status: 500, body: "" },
		answer({ status: "not-ready" }),
		{ status: 200, body: "not json" },
		answer({ status: "ok" }),
		answer({ status: "ok", candidates: [EARLIER, OTHER, THIRD, id("04")] }),
		answer({ status: "ok", candidates: [`0x${"CD".repeat(32)}`] }),
		answer({ status: "ok", candidates: [EARLIER, EARLIER] }),
		answer({ status: "ok", candidates: [ZERO32] }),
	];
	for (const candidates of answers) {
		const { outcome, seen } = run(lookalikeWorld({}, { candidates }), "log");
		expect(seen.verdicts).toHaveLength(1);
		expect(seen.lookalikes).toHaveLength(0);
		expect(outcome).toMatchObject({ error: expect.stringContaining("so no look-alike was written") });
	}
});

test("L17: with the zero address the step runs as a dry run, says so, and writes nothing", () => {
	const dry = configSchema.parse({
		...networkConfig,
		lookalikeReceiver: "0x0000000000000000000000000000000000000000",
		activationTime: ACTIVATION,
	});
	const found = run(lookalikeWorld(), "log", dry);
	expect(found.seen.candidateRequests).toHaveLength(1);
	expect(found.seen.lookalikes).toHaveLength(0);
	expect(found.logs).toContain("look-alike report not written: lookalikeReceiver is the zero address");
	expect(found.outcome).toMatchObject({ result: expect.stringContaining(`look-alike ${EARLIER} not written (dry run)`) });

	const silent = run(lookalikeWorld({}, { candidates: { status: 404, body: "" } }), "log", dry);
	expect(silent.outcome).toMatchObject({ result: expect.stringContaining("look-alike failed (the candidates route answered status 404") });
});

test("L17: the service's answers are read only in the one shape", () => {
	const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
	expect(readServiceAnswer("backlog", 200, body({ status: "ok", passports: [EARLIER] }), "passports", 7)).toEqual({
		kind: "ok",
		ids: [EARLIER],
	});
	expect(readServiceAnswer("backlog", 200, body({ status: "ok", passports: [EARLIER, OTHER] }), "passports", 1).kind).toBe("no-answer");
	expect(readServiceAnswer("backlog", 200, body({ status: "ok", candidates: [EARLIER] }), "passports", 7).kind).toBe("no-answer");
	expect(readServiceAnswer("backlog", 200, new Uint8Array([0xff, 0xfe]), "passports", 7).kind).toBe("no-answer");
	expect(readServiceAnswer("backlog", 200, body([EARLIER]), "passports", 7).kind).toBe("no-answer");
});

// L13, L14, L15: the catch-up.

const backlogWorld = (ids: Hex[], over: Partial<World> = {}): World => ({
	passports: Object.fromEntries(ids.map((passportId) => [passportId, newPassport()])),
	backlog: answer({ status: "ok", passports: ids }),
	...over,
});

test("L14: the backlog writes only the receiver whose floor is missing", () => {
	const both = id("a1");
	const verdictOnly = id("a2");
	const lookalikeOnly = id("a3");
	const before = BigInt(ACTIVATION - 1);
	const after = BigInt(ACTIVATION + 60);
	const { outcome, seen } = run(
		backlogWorld([both, verdictOnly, lookalikeOnly], {
			verdictFloor: { [both]: before, [verdictOnly]: 0n, [lookalikeOnly]: after },
			originFloor: { [both]: before, [verdictOnly]: after, [lookalikeOnly]: 0n },
		}),
		"cron",
	);
	expect(outcome).toEqual({
		result: `catch-up wrote ${both} verdict, ${both} look-alike, ${verdictOnly} verdict, ${lookalikeOnly} look-alike`,
	});
	expect(seen.verdicts.map((v) => v[2])).toEqual([both, verdictOnly]);
	expect(seen.lookalikes.map((l) => l.passportId)).toEqual([both, lookalikeOnly]);
});

test("L14: a passport with both floors at or after activation is left alone", () => {
	const done = id("a4");
	const at = BigInt(ACTIVATION);
	const { outcome, seen } = run(backlogWorld([done], { verdictFloor: { [done]: at }, originFloor: { [done]: at } }), "cron");
	expect(outcome).toEqual({ result: "catch-up wrote nothing" });
	expect(seen.http.filter((line) => line.includes(NEW_CID))).toHaveLength(0);
});

test("L13: a refused write in the catch-up fails the run with the passport named", () => {
	const missing = id("a5");
	const { outcome } = run(
		backlogWorld([missing], { verdictReply: { txStatus: "TX_STATUS_SUCCESS" }, originFloor: { [missing]: BigInt(ACTIVATION) } }),
		"cron",
	);
	expect(outcome).toMatchObject({ error: expect.stringContaining(`not done: ${missing} verdict: the receiver refused the report`) });
});

test("L15 and L17: a backlog that gives no answer writes nothing and fails the run", () => {
	for (const backlog of [{ status: 503, body: "" }, answer({ status: "not-ready" }), answer({ status: "ok", passports: "x" })]) {
		const { outcome, seen } = run(backlogWorld([], { backlog }), "cron");
		expect(seen.verdicts).toHaveLength(0);
		expect(outcome).toMatchObject({ error: expect.stringContaining("so nothing was written") });
	}
});

test("L15: the read budget holds at 15 HTTP calls and 15 reads with seven passports all missing", () => {
	const ids = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map(id);
	const world = backlogWorld(ids, {
		candidates: answer({ status: "ok", candidates: [EARLIER, OTHER, THIRD] }),
	});
	world.passports[EARLIER] = earlierLookalike();
	world.passports[OTHER] = earlierLookalike();
	world.passports[THIRD] = earlierLookalike();
	const { seen, logs } = run(world, "cron");
	expect(seen.http.length).toBeLessThanOrEqual(15);
	expect(seen.reads.length).toBeLessThanOrEqual(15);
	expect(seen.verdicts.length).toBeGreaterThanOrEqual(2);
	expect(logs).toContain("and the rest wait for the next run");
});

test("L15: the off switches", () => {
	const ids = [id("c1")];
	const noLookalikes = configSchema.parse({ ...networkConfig, lookalikeReceiver: LOOKALIKES, activationTime: ACTIVATION, lookalikesPerDay: 0 });
	const logRun = run(lookalikeWorld(), "log", noLookalikes);
	expect(logRun.seen.candidateRequests).toHaveLength(0);
	expect(logRun.logs).toContain("look-alike step off: lookalikesPerDay is 0");
	const cronRun = run(backlogWorld(ids), "cron", noLookalikes);
	expect(cronRun.seen.lookalikes).toHaveLength(0);
	expect(cronRun.seen.verdicts).toHaveLength(1);
	expect(cronRun.seen.reads.some((line) => line.startsWith("originOf"))).toBe(false);

	const notActivated = configSchema.parse({ ...networkConfig, lookalikeReceiver: LOOKALIKES });
	const idle = run(backlogWorld(ids), "cron", notActivated);
	expect(idle.outcome).toEqual({ result: "catch-up off: activationTime is not set" });
	expect(idle.seen.http).toHaveLength(0);

	expect(initWorkflow(config)).toHaveLength(2);
	expect(initWorkflow(configSchema.parse({ ...networkConfig, backlogPerRun: 0 }))).toHaveLength(1);
	expect(() => configSchema.parse({ ...networkConfig, backlogPerRun: 8 })).toThrow();
	expect(() => configSchema.parse({ ...networkConfig, lookalikeReceiver: networkConfig.receiver })).toThrow(/verdict receiver/);
});

test("L15: the daily ceiling spreads over the day's 144 runs and never exceeds it", () => {
	for (const perDay of [0, 1, 143, 144, 1000, 5000]) {
		let total = 0;
		for (let run = 0; run < CRON_RUNS_PER_DAY; run++) total += lookalikeWritesThisRun(perDay, run * 600 + 5);
		expect(total).toBe(perDay);
	}
	const budget = new Budget(1, 1);
	budget.spend(1, 1);
	expect(() => budget.spend(0, 1)).toThrow(/budget/);
});
