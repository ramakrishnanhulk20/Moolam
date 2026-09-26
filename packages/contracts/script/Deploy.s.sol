// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @notice Deploys the three Moolam contracts to Monad mainnet, lists the receiver and closes the
///         policy's setup window in the same batch.
/// @dev `record` is separate because a script cannot see its own transaction hashes until it ends.
contract Deploy is Script {
    address internal constant AGENT_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    // Chainlink's production KeystoneForwarder, not the simulator's mock.
    address internal constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    uint256 internal constant DISPUTE_BOND = 1 ether;

    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";
    string internal constant DEFAULT_WORKFLOW_NAME = "moolam-verifier";

    error WrongChain(uint256 actual, uint256 expected);
    error IdentityRegistryHasNoCode(address agentIdentity);
    error MissingWorkflowAuthor();
    error DeploymentFileMissing();
    error NotInBroadcast(string contractName, address recorded);

    /// @notice Deploys, pins the receiver to the Moolam workflow, lists it and closes the bootstrap.
    function run() external returns (VerifierPolicy policy, MoolamRegistry registry, MoolamReceiver moolamReceiver) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (AGENT_IDENTITY.code.length == 0) revert IdentityRegistryHasNoCode(AGENT_IDENTITY);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        string memory workflowName = vm.envOr("CRE_WORKFLOW_NAME", DEFAULT_WORKFLOW_NAME);
        address workflowAuthor = vm.envAddress("CRE_WALLET_ADDRESS");
        if (workflowAuthor == address(0)) revert MissingWorkflowAuthor();

        vm.startBroadcast(deployerKey);
        policy = new VerifierPolicy(deployer, deployer, deployer, DISPUTE_BOND);
        registry = new MoolamRegistry(deployer, address(policy), AGENT_IDENTITY);
        moolamReceiver = new MoolamReceiver(FORWARDER, address(registry));
        // Author first: a name with no author makes the template refuse every report.
        moolamReceiver.setExpectedAuthor(workflowAuthor);
        moolamReceiver.setExpectedWorkflowName(workflowName);
        policy.bootstrapAddReceiver(address(moolamReceiver));
        policy.finalizeBootstrap();
        vm.stopBroadcast();

        console2.log("chain id        ", block.chainid);
        console2.log("deployer        ", deployer);
        console2.log("block           ", block.number);
        console2.log("VerifierPolicy  ", address(policy));
        console2.log("MoolamRegistry  ", address(registry));
        console2.log("MoolamReceiver  ", address(moolamReceiver));
        console2.log("agent identity  ", AGENT_IDENTITY);
        console2.log("forwarder       ", FORWARDER);
        console2.log("workflow name   ", workflowName);
        console2.log("workflow author ", workflowAuthor);
        console2.log("dispute bond    ", DISPUTE_BOND);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _writeAddresses(deployer, address(policy), address(registry), address(moolamReceiver));
        } else {
            console2.log("Dry run: no transaction was sent and no deployment file was written.");
        }
    }

    /// @notice Fills in the transaction hashes and block of the recorded deploy. Run after `run`.
    /// @dev Matches by address, since the broadcast cheatcodes return every run of every script.
    function record() external {
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();
        string memory deployment = vm.readFile(DEPLOYMENT_FILE);
        address policy = vm.parseJsonAddress(deployment, ".policy");

        VmSafe.BroadcastTxSummary memory policyTx = _creation("VerifierPolicy", policy);
        VmSafe.BroadcastTxSummary memory registryTx =
            _creation("MoolamRegistry", vm.parseJsonAddress(deployment, ".registry"));
        VmSafe.BroadcastTxSummary memory receiverTx =
            _creation("MoolamReceiver", vm.parseJsonAddress(deployment, ".receiver"));
        bytes32[] memory callHashes = _callsTo("VerifierPolicy", policy);

        string memory hashes = "txHashes";
        string memory hashesJson = vm.serializeBytes32(hashes, "policy", policyTx.txHash);
        hashesJson = vm.serializeBytes32(hashes, "registry", registryTx.txHash);
        hashesJson = vm.serializeBytes32(hashes, "receiver", receiverTx.txHash);
        hashesJson = vm.serializeBytes32(hashes, "policyCalls", callHashes);
        // Carry over the hash DeployConsent wrote, since this replaces the whole key.
        if (vm.keyExistsJson(deployment, ".txHashes.consent")) {
            hashesJson = vm.serializeBytes32(hashes, "consent", vm.parseJsonBytes32(deployment, ".txHashes.consent"));
        }

        vm.writeJson(hashesJson, DEPLOYMENT_FILE, ".txHashes");
        vm.writeJson(vm.toString(uint256(registryTx.blockNumber)), DEPLOYMENT_FILE, ".block");

        console2.log("Recorded transaction hashes into", DEPLOYMENT_FILE);
        console2.log("registry deployed in block", registryTx.blockNumber);
    }

    function _creation(string memory contractName, address recorded)
        private
        view
        returns (VmSafe.BroadcastTxSummary memory)
    {
        VmSafe.BroadcastTxSummary[] memory found =
            vm.getBroadcasts(contractName, MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Create);
        for (uint256 i = 0; i < found.length; ++i) {
            if (found[i].contractAddress == recorded) return found[i];
        }
        revert NotInBroadcast(contractName, recorded);
    }

    /// @dev Oldest first. The cheatcode lists newest first.
    function _callsTo(string memory contractName, address recorded) private view returns (bytes32[] memory hashes) {
        VmSafe.BroadcastTxSummary[] memory found =
            vm.getBroadcasts(contractName, MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Call);
        uint256 count = 0;
        for (uint256 i = 0; i < found.length; ++i) {
            if (found[i].contractAddress == recorded) ++count;
        }
        if (count == 0) revert NotInBroadcast(contractName, recorded);

        hashes = new bytes32[](count);
        for (uint256 i = 0; i < found.length; ++i) {
            if (found[i].contractAddress == recorded) hashes[--count] = found[i].txHash;
        }
    }

    function _writeAddresses(address deployer, address policy, address registry, address moolamReceiver) private {
        string memory root = "deployment";
        string memory json = vm.serializeUint(root, "chainId", block.chainid);
        json = vm.serializeAddress(root, "deployer", deployer);
        json = vm.serializeUint(root, "block", block.number);
        json = vm.serializeUint(root, "timestamp", block.timestamp);
        json = vm.serializeAddress(root, "policy", policy);
        json = vm.serializeAddress(root, "registry", registry);
        json = vm.serializeAddress(root, "receiver", moolamReceiver);
        json = vm.serializeAddress(root, "agentIdentity", AGENT_IDENTITY);
        json = vm.serializeAddress(root, "forwarder", FORWARDER);
        json = vm.serializeString(root, "txHashes", "pending");

        vm.writeJson(json, DEPLOYMENT_FILE);
        console2.log("Wrote", DEPLOYMENT_FILE);
    }
}
