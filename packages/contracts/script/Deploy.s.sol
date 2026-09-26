// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @notice Deploys the three Moolam contracts to Monad mainnet in one repeatable run, wires the
///         receiver into the policy, and closes the policy's setup window in the same transaction
///         batch so there is never a window where an unlisted address could be added without the
///         24 hour delay.
/// @dev Two entry points. `run` deploys. `record` runs afterwards, reads Foundry's own broadcast
///      artifact, and writes deployments/monad-mainnet.json. They are split because a script cannot
///      see its own transaction hashes: Foundry sends the batch only after `run` has returned.
contract Deploy is Script {
    /// @dev The canonical ERC-8004 Identity Registry on Monad mainnet. The registry reads agent
    ///      ownership from here, so a deploy against an address with no code would produce a
    ///      contract that can never accept a Generated passport.
    address internal constant AGENT_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    /// @dev The production Chainlink KeystoneForwarder on Monad mainnet. Simulation runs use the
    ///      mock forwarder at 0x9eF6468C5f37b976E57d52054c693269479A784d, switched in afterwards
    ///      with the template's setForwarderAddress.
    address internal constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    /// @dev What a challenger stakes to flag a passport, in MON.
    uint256 internal constant DISPUTE_BOND = 1 ether;

    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";
    /// @dev The name in packages/workflow/moolam-verifier/workflow.yaml. CRE_WORKFLOW_NAME
    ///      overrides it when a run needs a different workflow.
    string internal constant DEFAULT_WORKFLOW_NAME = "moolam-verifier";

    error WrongChain(uint256 actual, uint256 expected);
    error IdentityRegistryHasNoCode(address agentIdentity);
    error MissingWorkflowAuthor();
    error DeploymentFileMissing();
    /// @notice No broadcast on disk sent this transaction kind to the recorded address.
    error NotInBroadcast(string contractName, address recorded);

    /// @notice Deploys the policy, the registry and the receiver, pins the receiver to the Moolam
    ///         workflow, then lists the receiver and finalizes the policy bootstrap.
    /// @dev Reverts WrongChain when pointed at anything but Monad mainnet,
    ///      IdentityRegistryHasNoCode when the ERC-8004 registry is missing, and
    ///      MissingWorkflowAuthor when CRE_WALLET_ADDRESS is not set to a real address.
    /// @return policy The deployed VerifierPolicy.
    /// @return registry The deployed MoolamRegistry.
    /// @return moolamReceiver The deployed MoolamReceiver.
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
        // The author goes in first. Chainlink's template refuses every report when a name is
        // pinned without an author, so setting the name first would brick the receiver for as long
        // as the two transactions are apart.
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

    /// @notice Fills in the transaction hashes and confirmed block of the deploy the file records.
    /// @dev Run after `run --broadcast`, without broadcasting. The broadcast cheatcodes search every
    ///      run of every script on this chain by contract name, so each result is kept only when its
    ///      contract address is one `run` wrote into the deployment file. Reverts
    ///      DeploymentFileMissing before a deploy and NotInBroadcast when an address has no matching
    ///      transaction, so a record can never name another run's transaction or write zeros. A
    ///      consent hash already in the file is carried over.
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
        // DeployConsent writes its hash into the same object later, and this object replaces the
        // whole key, so running record again must not drop it.
        if (vm.keyExistsJson(deployment, ".txHashes.consent")) {
            hashesJson = vm.serializeBytes32(hashes, "consent", vm.parseJsonBytes32(deployment, ".txHashes.consent"));
        }

        vm.writeJson(hashesJson, DEPLOYMENT_FILE, ".txHashes");
        vm.writeJson(vm.toString(uint256(registryTx.blockNumber)), DEPLOYMENT_FILE, ".block");

        console2.log("Recorded transaction hashes into", DEPLOYMENT_FILE);
        console2.log("registry deployed in block", registryTx.blockNumber);
    }

    /// @dev The one creation of `contractName` that produced `recorded`.
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

    /// @dev The hashes of every call sent to `recorded`, oldest first. The cheatcode lists newest
    ///      first, so for the policy this reads bootstrapAddReceiver then finalizeBootstrap.
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
        // Filled by `record` in the second half of the deploy command, once the hashes exist.
        json = vm.serializeString(root, "txHashes", "pending");

        vm.writeJson(json, DEPLOYMENT_FILE);
        console2.log("Wrote", DEPLOYMENT_FILE);
    }
}
