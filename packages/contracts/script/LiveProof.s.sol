// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {Kind, Passport, PassportInput} from "../src/interfaces/IMoolamRegistry.sol";
import {WebAuthnFixture} from "../test/utils/WebAuthnFixture.sol";

/// @notice The prove-it script. It binds a passkey to the deployer wallet, writes a Captured
///         passport for a real photo, writes a Generated passport for the C2PA signed version of
///         that photo co-signed by the demo agent's owner, and appends one edit. Every number here
///         is a fingerprint the verifier package actually measured, not a made up value.
///         The Generated and Edited passports are proof fixtures. The picture is a camera photo, and
///         the agent co-signs it only to exercise the agent signature path, so the registry, which
///         cannot be changed, says for good that the demo agent made a photograph. `run` and
///         `links` both say so when they print them.
/// @dev The passkey signature is a real WebAuthn assertion built exactly the way the unit tests
///      build one, with user presence and user verification set, so this run is the first time the
///      whole path touches Monad's P-256 precompile at 0x0100 rather than Foundry's own.
///      Two entry points: `run` sends the four transactions, `links` finds their hashes on the
///      chain afterwards and prints explorer links, because a script cannot see its own
///      transaction hashes.
contract LiveProof is Script {
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";
    string internal constant EXPLORER = "https://monadvision.com/tx/";
    /// @dev Monad makes a block about every 0.4 seconds, so one second spans three blocks at most.
    ///      Ten covers that with room, and stays far under any RPC's eth_getLogs range cap.
    uint256 internal constant SAME_SECOND_BLOCKS = 10;
    /// @dev The script sends the bind first, and with --slow each transaction waits for the one
    ///      before it, so the bind lands a few blocks before the captured passport. 99 keeps the
    ///      range inside a 100 block eth_getLogs cap.
    uint256 internal constant BIND_LOOKBACK = 99;
    string internal constant FIXTURE_NOTE =
        "  proof fixture: a camera photo the demo agent co-signed, not a picture an AI made";

    /// @dev Fingerprints of packages/verifier/test-assets/original.jpg, measured by the verifier
    ///      spike and recorded in proofs/spike.txt. The photo carries no C2PA
    ///      manifest, so its manifest hash is zero.
    bytes32 internal constant ORIGINAL_SHA256 = 0xb95adc0cf9b3bb3af90bafa247b5a49dd5c5d50877537b47f7b000c5a573354c;
    uint64 internal constant ORIGINAL_PHASH = 0x336b806a7e894e76;
    bytes32 internal constant ORIGINAL_BLOCKHASH =
        0x000f003f187f3eff1878047c3c7d3c7b3e7f00ff01ff0007000300071fff3fff;

    /// @dev signed.jpg is the same photo with a C2PA manifest embedded. The spike measured that
    ///      signing moved the perceptual hash 0 of 64 bits and the block hash 0 of 256, so the two
    ///      fingerprints below are the same numbers as above while the exact hash differs.
    bytes32 internal constant SIGNED_SHA256 = 0x7b4732f365aa235556b4b11b8916fd544f10acc034ae7e0b9e39068becae1a50;
    bytes32 internal constant SIGNED_MANIFEST_HASH =
        0x43e6e3a61c1e49aae9135e12b0a6b354d0c56a27f11ca1cb2489cc5222e24e62;

    /// @dev strip-metadata.jpg is signed.jpg with its metadata stripped, which the spike measured
    ///      as 0 of 64 and 0 of 256 away, and which destroys the C2PA manifest. That is the exact
    ///      case this project exists for: the manifest is gone, the fingerprint is not.
    bytes32 internal constant STRIPPED_SHA256 = 0x9f0f2bde58513560923b5883ded38af5f13a15879f144fb17e44adde17252c35;

    /// @dev Version 1 is sharp-phash 64 bit plus blockhash 256 bit, the pair the verifier computes.
    uint8 internal constant FINGERPRINT_VERSION = 1;

    error WrongChain(uint256 actual, uint256 expected);
    error DeploymentFileMissing();
    error DemoAgentMissing();
    error ProofKeyMissing();

    /// @notice Binds the passkey and writes the three passports.
    /// @dev Reverts WrongChain off Monad mainnet, DeploymentFileMissing before a deploy, and
    ///      ProofKeyMissing when PROOF_P256_PRIVATE_KEY is not in the environment. Each step is
    ///      skipped with a printed line if it already happened, so the script can be run again.
    function run() external {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (!vm.exists(DEPLOYMENT_FILE)) {
            console2.log("Nothing to prove yet: there is no", DEPLOYMENT_FILE);
            console2.log("Deploy first with npm run deploy:mainnet, then npm run agent:register.");
            revert DeploymentFileMissing();
        }

        string memory deployment = vm.readFile(DEPLOYMENT_FILE);
        MoolamRegistry registry = MoolamRegistry(vm.parseJsonAddress(deployment, ".registry"));
        uint256 generatorAgentId = vm.parseJsonUint(deployment, ".demoAgentId", 0);
        if (generatorAgentId == 0) {
            console2.log("The deployment file has no demoAgentId. Run npm run agent:register first.");
            revert DemoAgentMissing();
        }

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 proofKey = vm.envOr("PROOF_P256_PRIVATE_KEY", uint256(0));
        if (proofKey == 0) {
            console2.log("PROOF_P256_PRIVATE_KEY is missing from .env.");
            console2.log("Add a random 32 byte hex value, for example from: openssl rand -hex 32");
            revert ProofKeyMissing();
        }

        address creator = vm.addr(deployerKey);

        console2.log("registry        ", address(registry));
        console2.log("creator wallet  ", creator);
        console2.log("generator agent ", generatorAgentId);

        vm.startBroadcast(deployerKey);
        _bind(registry, creator, proofKey);
        uint256 capturedId = _captured(registry, creator, proofKey);
        uint256 generatedId = _generated(registry, creator, proofKey, deployerKey, generatorAgentId);
        uint256 editedId = _edited(registry, creator, generatorAgentId, deployerKey);
        vm.stopBroadcast();

        console2.log("captured  token id", capturedId);
        console2.log("generated token id", generatedId);
        console2.log("edited    token id", editedId);
        console2.log("The generated and edited passports are proof fixtures: a camera photo the demo");
        console2.log("agent co-signed to exercise the agent path, not a picture an AI made.");

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("Dry run: nothing was sent. Add --broadcast to write these three passports.");
        }
    }

    /// @notice Prints, read from the chain, the transaction that wrote each proof passport and the
    ///         passkey bind just before them, with explorer links.
    /// @dev Run after `run --broadcast`, without broadcasting, against Monad mainnet. Foundry saves no
    ///      contract name for a call to a contract the script did not deploy, so the broadcast
    ///      cheatcodes never find these calls, and the broadcast folder is outside what a script may
    ///      read. The chain answers instead: each passport stores the second it was written, a binary
    ///      search over block headers finds the first block of that second, and eth_getLogs over the
    ///      next few blocks returns the transaction. Reverts WrongChain off Monad mainnet and
    ///      DeploymentFileMissing before a deploy.
    function links() external view {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();

        string memory deployment = vm.readFile(DEPLOYMENT_FILE);
        MoolamRegistry registry = MoolamRegistry(vm.parseJsonAddress(deployment, ".registry"));
        uint256 low = vm.parseJsonUint(deployment, ".block");
        uint256 head = vm.getBlockNumber();

        (uint64 capturedAt, address creator) = _writtenAt(registry, ORIGINAL_SHA256);
        (uint64 generatedAt,) = _writtenAt(registry, SIGNED_SHA256);
        (uint64 editedAt,) = _writtenAt(registry, STRIPPED_SHA256);

        uint256 capturedBlock =
            _printWrite("captured  passport", address(registry), ORIGINAL_SHA256, capturedAt, low, head);
        if (_printWrite("generated passport", address(registry), SIGNED_SHA256, generatedAt, low, head) != 0) {
            console2.log(FIXTURE_NOTE);
        }
        if (_printWrite("edited    passport", address(registry), STRIPPED_SHA256, editedAt, low, head) != 0) {
            console2.log(FIXTURE_NOTE);
        }

        console2.log("passkey bind for", creator);
        if (capturedBlock == 0) {
            console2.log("  not looked up: the captured passport was not found above.");
            return;
        }
        bytes32[] memory bindTopics = new bytes32[](2);
        bindTopics[0] = MoolamRegistry.PasskeyBound.selector;
        bindTopics[1] = bytes32(uint256(uint160(creator)));
        if (
            _printLast(vm.eth_getLogs(capturedBlock - BIND_LOOKBACK, capturedBlock, address(registry), bindTopics)) == 0
        ) {
            console2.log(
                "  none in the", BIND_LOOKBACK, "blocks before the captured passport: bound in an earlier run."
            );
        }
    }

    /// @dev When the passport exists, the second it was written and its creator. Zero otherwise.
    function _writtenAt(MoolamRegistry registry, bytes32 id) private view returns (uint64 at, address creator) {
        if (!registry.passportExists(id)) return (0, address(0));
        Passport memory p = registry.getPassport(id);
        return (p.registeredAt, p.creator);
    }

    /// @dev Prints the PassportRegistered transaction for `id` and returns its block, or zero when
    ///      the passport is not on chain or no log was found.
    function _printWrite(string memory label, address registry, bytes32 id, uint64 writtenAt, uint256 low, uint256 high)
        private
        view
        returns (uint256 found)
    {
        console2.log(label, vm.toString(id));
        if (writtenAt == 0) {
            console2.log("  not on chain. Run the live proof with --broadcast first.");
            return 0;
        }
        uint256 from = _firstBlockOfSecond(writtenAt, low, high);
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = MoolamRegistry.PassportRegistered.selector;
        topics[1] = id;
        found = _printLast(vm.eth_getLogs(from, from + SAME_SECOND_BLOCKS, registry, topics));
        if (found == 0) {
            console2.log("  on chain, but no PassportRegistered log in blocks", from, from + SAME_SECOND_BLOCKS);
        }
    }

    /// @dev The first block in [low, high] whose timestamp is at least `timestamp`. The range is the
    ///      registry's deploy block to the head, so the loop reads about 27 headers at most. Headers
    ///      rather than rollFork, because rolling the fork asks the RPC for state at old blocks,
    ///      which a node without archive state refuses.
    function _firstBlockOfSecond(uint64 timestamp, uint256 low, uint256 high) private view returns (uint256) {
        while (low < high) {
            uint256 mid = (low + high) / 2;
            // A cheatcode read of one header, not a contract call, and the halving bounds the loop.
            // forge-lint: disable-next-line(calls-loop)
            if (_timestampOf(mid) < timestamp) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    /// @dev The timestamp is the twelfth field of an Ethereum style block header, which Monad keeps.
    function _timestampOf(uint256 blockNumber) private view returns (uint256) {
        // forge-lint: disable-next-line(calls-loop)
        return RLP.readUint256(RLP.decodeList(vm.getRawBlockHeader(blockNumber))[11]);
    }

    /// @dev Prints the newest log's transaction as an explorer link and returns its block, or zero
    ///      when there is none.
    function _printLast(VmSafe.EthGetLogs[] memory logs) private pure returns (uint256) {
        if (logs.length == 0) return 0;
        VmSafe.EthGetLogs memory last = logs[logs.length - 1];
        console2.log(string.concat("  ", EXPLORER, vm.toString(last.transactionHash)));
        console2.log("  block", last.blockNumber);
        return last.blockNumber;
    }

    function _bind(MoolamRegistry registry, address creator, uint256 proofKey) private {
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(proofKey);
        (bytes32 boundX, bytes32 boundY) = registry.getPasskey(creator);
        if (boundX == qx && boundY == qy) {
            console2.log("passkey already bound, skipping");
            return;
        }

        bytes32 digest = registry.hashBind(creator, qx, qy, registry.bindNonce(creator));
        registry.bindPasskey(qx, qy, WebAuthnFixture.sign(proofKey, digest));
        console2.log("bound passkey qx", vm.toString(qx));
    }

    function _captured(MoolamRegistry registry, address creator, uint256 proofKey) private returns (uint256 tokenId) {
        PassportInput memory p = _input(ORIGINAL_SHA256, creator, "original.jpg");
        p.kind = Kind.Captured;
        p.manifestHash = bytes32(0);

        if (registry.passportExists(p.exactHash)) {
            console2.log("captured passport already on chain, skipping");
            return uint256(p.exactHash);
        }

        return registry.register(p, WebAuthnFixture.sign(proofKey, registry.hashPassport(p)), bytes(""));
    }

    function _generated(
        MoolamRegistry registry,
        address creator,
        uint256 proofKey,
        uint256 agentOwnerKey,
        uint256 generatorAgentId
    ) private returns (uint256 tokenId) {
        PassportInput memory p = _input(SIGNED_SHA256, creator, "signed.jpg");
        p.kind = Kind.Generated;
        p.generatorAgentId = generatorAgentId;
        p.manifestHash = SIGNED_MANIFEST_HASH;

        if (registry.passportExists(p.exactHash)) {
            console2.log("generated passport already on chain, skipping");
            return uint256(p.exactHash);
        }

        bytes32 digest = registry.hashPassport(p);
        return registry.register(
            p, WebAuthnFixture.sign(proofKey, digest), WebAuthnFixture.signAsAgent(agentOwnerKey, digest)
        );
    }

    function _edited(MoolamRegistry registry, address creator, uint256 generatorAgentId, uint256 agentOwnerKey)
        private
        returns (uint256 tokenId)
    {
        PassportInput memory p = _input(STRIPPED_SHA256, creator, "strip-metadata.jpg");
        p.kind = Kind.Edited;
        p.parentId = SIGNED_SHA256;
        p.generatorAgentId = generatorAgentId;
        p.manifestHash = bytes32(0);

        if (registry.passportExists(p.exactHash)) {
            console2.log("edit already on chain, skipping");
            return uint256(p.exactHash);
        }

        return registry.appendEdit(p, WebAuthnFixture.signAsAgent(agentOwnerKey, registry.hashPassport(p)));
    }

    function _input(bytes32 exactHash, address creator, string memory fileName)
        private
        view
        returns (PassportInput memory p)
    {
        p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: 0,
            phash: ORIGINAL_PHASH,
            blockhash256: ORIGINAL_BLOCKHASH,
            manifestHash: bytes32(0),
            kind: Kind.Captured,
            fingerprintVersion: FINGERPRINT_VERSION,
            // A data URI, not a placeholder CID: the record points at something that really says
            // what the image is until the app uploads the real manifest bundle.
            metadataURI: string.concat(
                'data:application/json,{"name":"', fileName, '","source":"moolam live proof on Monad mainnet"}'
            ),
            // forge-lint: disable-next-line(unsafe-typecast)
            deadline: uint64(block.timestamp + 1 hours)
        });
    }
}
