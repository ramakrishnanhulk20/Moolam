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

    error WrongChain(uint256 actual, uint256 expected);
    error IdentityRegistryHasNoCode(address agentIdentity);
    error NothingRecorded();

    /// @notice Deploys the policy, the registry and the receiver, then lists the receiver and
    ///         finalizes the policy bootstrap.
    /// @dev Reverts WrongChain when pointed at anything but Monad mainnet and
    ///      IdentityRegistryHasNoCode when the ERC-8004 registry is missing.
    /// @return policy The deployed VerifierPolicy.
    /// @return registry The deployed MoolamRegistry.
    /// @return moolamReceiver The deployed MoolamReceiver.
    function run() external returns (VerifierPolicy policy, MoolamRegistry registry, MoolamReceiver moolamReceiver) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (AGENT_IDENTITY.code.length == 0) revert IdentityRegistryHasNoCode(AGENT_IDENTITY);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        policy = new VerifierPolicy(deployer, deployer, deployer, DISPUTE_BOND);
        registry = new MoolamRegistry(deployer, address(policy), AGENT_IDENTITY);
        moolamReceiver = new MoolamReceiver(FORWARDER, address(registry));
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
        console2.log("dispute bond    ", DISPUTE_BOND);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _writeAddresses(deployer, address(policy), address(registry), address(moolamReceiver));
        } else {
            console2.log("Dry run: no transaction was sent and no deployment file was written.");
        }
    }

    /// @notice Fills in the transaction hashes and confirmed block of the last broadcast.
    /// @dev Run after `run --broadcast`, without broadcasting. Reverts NothingRecorded when no
    ///      broadcast artifact for this chain exists yet.
    function record() external {
        VmSafe.BroadcastTxSummary memory policyTx =
            vm.getBroadcast("VerifierPolicy", MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Create);
        VmSafe.BroadcastTxSummary memory registryTx =
            vm.getBroadcast("MoolamRegistry", MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Create);
        VmSafe.BroadcastTxSummary memory receiverTx =
            vm.getBroadcast("MoolamReceiver", MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Create);
        VmSafe.BroadcastTxSummary[] memory policyCalls =
            vm.getBroadcasts("VerifierPolicy", MONAD_MAINNET_CHAIN_ID, VmSafe.BroadcastTxType.Call);

        if (policyTx.txHash == bytes32(0)) revert NothingRecorded();

        string memory hashes = "txHashes";
        string memory hashesJson = vm.serializeBytes32(hashes, "policy", policyTx.txHash);
        hashesJson = vm.serializeBytes32(hashes, "registry", registryTx.txHash);
        hashesJson = vm.serializeBytes32(hashes, "receiver", receiverTx.txHash);
        // The two policy calls are listed newest first by the cheatcode, so they are written as a
        // list rather than named, and their order is bootstrapAddReceiver then finalizeBootstrap.
        bytes32[] memory callHashes = new bytes32[](policyCalls.length);
        for (uint256 i = 0; i < policyCalls.length; ++i) {
            callHashes[i] = policyCalls[policyCalls.length - 1 - i].txHash;
        }
        hashesJson = vm.serializeBytes32(hashes, "policyCalls", callHashes);

        vm.writeJson(hashesJson, DEPLOYMENT_FILE, ".txHashes");
        vm.writeJson(vm.toString(uint256(registryTx.blockNumber)), DEPLOYMENT_FILE, ".block");

        console2.log("Recorded transaction hashes into", DEPLOYMENT_FILE);
        console2.log("registry deployed in block", registryTx.blockNumber);
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
