/**
 * Drives one whole run of onPassportRegistered through the CRE SDK's own test runtime, with the
 * chain and the gateway mocked, to prove a write only counts when both the transaction and the
 * receiver say it succeeded.
 *
 * Not covered here: what Chainlink's real forwarder or the simulator actually return (the dry-run
 * simulate in the README shows that), node consensus across more than one node, the fingerprint
 * maths (packages/verifier/test/workflow-phash.test.ts) and the picture choice
 * (packages/recheck-runner/test/workflow-picture.test.ts).
 */
import { expect } from "bun:test";
import { getNetwork, type EVMLog } from "@chainlink/cre-sdk";
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { encode } from "jpeg-js";
import {
	encodeAbiParameters,
	encodeEventTopics,
	hexToBytes,
	parseAbi,
	parseAbiParameters,
	type Address,
	type Hex,
} from "viem";
import networkConfig from "./config.network.json";
import { decodeJpeg } from "./decode";
import { perceptualHash } from "./phash";
import { configSchema, onPassportRegistered } from "./workflow";

const config = configSchema.parse(networkConfig);

const registryAbi = parseAbi([
	"event PassportRegistered(bytes32 indexed passportId, address indexed creator, uint256 indexed generatorAgentId, bytes32 parentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, string metadataURI)",
	"function getPassport(bytes32 id) view returns ((bytes32 exactHash, bytes32 parentId, address creator, uint256 generatorAgentId, uint64 phash, bytes32 blockhash256, bytes32 manifestHash, uint8 kind, uint8 fingerprintVersion, uint64 registeredAt, bool disputed, string metadataURI))",
]);

const PASSPORT_ID: Hex = `0x${"ab".repeat(32)}`;
const CREATOR: Address = "0x00000000000000000000000000000000000000c1";
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const TX_HASH_BASE64 = Buffer.from(new Uint8Array(32).fill(0x11)).toString("base64");
const METADATA_URI = `data:application/json,${encodeURIComponent(JSON.stringify({ thumbnail: "ipfs://bafkreitestthumbnail" }))}`;

const thumbnail = (() => {
	const width = 64;
	const height = 64;
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data.set([(i % width) * 4, Math.floor(i / width) * 4, 128, 255], i * 4);
	}
	return new Uint8Array(encode({ data, width, height }, 90).data);
})();

const storedPhash = (() => {
	const image = decodeJpeg(thumbnail);
	return perceptualHash(image.pixels, image.width, image.height, image.channels);
})();

const triggerLog = (): EVMLog => {
	const topics = encodeEventTopics({
		abi: registryAbi,
		eventName: "PassportRegistered",
		args: { passportId: PASSPORT_ID, creator: CREATOR, generatorAgentId: 0n },
	}) as Hex[];
	const data = encodeAbiParameters(
		parseAbiParameters("bytes32, uint64, bytes32, bytes32, uint8, uint8, string"),
		[ZERO32, storedPhash, ZERO32, ZERO32, 0, 1, METADATA_URI],
	);
	return { topics: topics.map((topic) => hexToBytes(topic)), data: hexToBytes(data) } as unknown as EVMLog;
};

/** What the forwarder's write answers, in the protobuf JSON shape the SDK mock accepts. */
type WriteReply = {
	txStatus: string;
	receiverContractExecutionStatus?: string;
	errorMessage?: string;
};

const runWith = (reply: WriteReply) => {
	const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chain });
	if (!network) throw new Error(`network not found: ${config.chain}`);
	const evm = EvmMock.testInstance(network.chainSelector.selector);

	const registry = addContractMock(evm, { address: config.registry as Address, abi: registryAbi });
	registry.getPassport = () => ({
		exactHash: ZERO32,
		parentId: ZERO32,
		creator: CREATOR,
		generatorAgentId: 0n,
		phash: storedPhash,
		blockhash256: ZERO32,
		manifestHash: ZERO32,
		kind: 0,
		fingerprintVersion: 1,
		registeredAt: 1_700_000_000n,
		disputed: false,
		metadataURI: METADATA_URI,
	});

	const receiver = addContractMock(evm, { address: config.receiver as Address, abi: [] });
	receiver.writeReport = () => ({ ...reply, txHash: TX_HASH_BASE64 });

	HttpActionsMock.testInstance().sendRequest = () => ({
		statusCode: 200,
		body: Buffer.from(thumbnail).toString("base64"),
	});

	const runtime = newTestRuntime(null, {}, config);
	let outcome: { result: string } | { error: string };
	try {
		outcome = { result: onPassportRegistered(runtime, triggerLog()) };
	} catch (error) {
		outcome = { error: error instanceof Error ? error.message : String(error) };
	}
	const logs = runtime.getLogs().join("\n");
	return { outcome, logs };
};

test("a write the receiver reverted fails the run and prints no report tx", () => {
	const { outcome, logs } = runWith({
		txStatus: "TX_STATUS_SUCCESS",
		receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED",
	});
	expect(outcome).toEqual({
		error: `the receiver refused the report, so no attestation was written (receiver status REVERTED) (transaction 0x${"11".repeat(32)})`,
	});
	expect(logs).toContain(`write to ${config.receiver}: transaction SUCCESS, receiver REVERTED`);
	expect(logs).not.toContain("report tx");
});

test("a write with no receiver status fails the run", () => {
	const { outcome, logs } = runWith({ txStatus: "TX_STATUS_SUCCESS" });
	expect(outcome).toEqual({
		error: `the receiver refused the report, so no attestation was written (receiver status missing) (transaction 0x${"11".repeat(32)})`,
	});
	expect(logs).not.toContain("report tx");
});

test("a write whose transaction failed fails the run with the status by name", () => {
	const { outcome, logs } = runWith({
		txStatus: "TX_STATUS_REVERTED",
		receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
		errorMessage: "out of gas",
	});
	expect(outcome).toEqual({
		error: `the report transaction did not succeed (status REVERTED): out of gas (transaction 0x${"11".repeat(32)})`,
	});
	expect(logs).not.toContain("report tx");
});

test("a write both sides accepted is the run's result", () => {
	const { outcome, logs } = runWith({
		txStatus: "TX_STATUS_SUCCESS",
		receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
	});
	expect(outcome).toEqual({
		result: `${PASSPORT_ID} distance 0 matched true tx 0x${"11".repeat(32)}`,
	});
	expect(logs).toContain(`report tx 0x${"11".repeat(32)}`);
});
