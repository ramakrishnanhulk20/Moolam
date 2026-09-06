// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {Kind, PassportInput} from "../src/interfaces/IMoolamRegistry.sol";
import {WebAuthnFixture} from "../test/utils/WebAuthnFixture.sol";

/// @notice The prove-it script. It binds a passkey to the deployer wallet, writes a Captured
///         passport for a real photo, writes a Generated passport for the C2PA signed version of
///         that photo co-signed by the demo agent's owner, and appends one edit. Every number here
///         is a fingerprint the verifier package actually measured, not a made up value.
/// @dev The passkey signature is a real WebAuthn assertion built exactly the way the unit tests
///      build one, with user presence and user verification set, so this run is the first time the
///      whole path touches Monad's P-256 precompile at 0x0100 rather than Foundry's own.
///      Two entry points: `run` sends the four transactions, `links` prints their hashes and
///      explorer links afterwards, because a script cannot see its own transaction hashes.
contract LiveProof is Script {
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";
    string internal constant EXPLORER = "https://monadvision.com/tx/";

    /// @dev Fingerprints of packages/verifier/test-assets/original.jpg, measured by the verifier
    ///      spike and recorded in kitchen/reports/WO-0a-output.txt. The photo carries no C2PA
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

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("Dry run: nothing was sent. Add --broadcast to write these three passports.");
        }
    }

    /// @notice Prints the hash and explorer link of every transaction the last live proof sent.
    /// @dev Run after `run --broadcast`, without broadcasting.
    function links() external view {
        VmSafe.BroadcastTxSummary[] memory calls =
            vm.getBroadcasts("MoolamRegistry", MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Call);

        if (calls.length == 0) {
            console2.log("No broadcast found yet. Run the live proof with --broadcast first.");
            return;
        }

        // The cheatcode returns newest first, so walk it backwards to print them in the order the
        // proof sent them: bind, captured, generated, edit.
        for (uint256 i = calls.length; i > 0; --i) {
            VmSafe.BroadcastTxSummary memory tx_ = calls[i - 1];
            // The console and the string cheatcode are calls, but this loop only prints, and it
            // runs over a fixed four item list that never touches the chain.
            // forge-lint: disable-next-line(calls-loop)
            console2.log(string.concat(EXPLORER, vm.toString(tx_.txHash)));
            console2.log("  block", tx_.blockNumber, "success", tx_.success);
        }
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
