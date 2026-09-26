// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

interface ITypeAndVersion {
    function typeAndVersion() external view returns (string memory);
}

/// @notice The plan both simulation receiver scripts check the chain against.
abstract contract SimulationReceiversPlan is Script {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    string internal constant MOCK_VERSION = "MockKeystoneForwarder 1.0.0";
    address internal constant CRE_WALLET = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
    address internal constant OLD_PUBLIC = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant OLD_SEALED = 0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A;

    // What the simulator stamps into every report header, read off real mainnet reports.
    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    string internal constant PUBLIC_WORKFLOW = "moolam-verifier";
    string internal constant SEALED_WORKFLOW = "moolam-sealed-verifier";
    // Written out, not computed, so the read-back checks the template's hashing too.
    bytes10 internal constant PUBLIC_NAME = 0x34623863303364663034;
    bytes10 internal constant SEALED_NAME = 0x64323036636163326334;

    error WrongChain(uint256 actual, uint256 expected);
    error HasNoCode(address target);
    error NotTheMockForwarder(string typeAndVersion);
    error NotPolicyOwner(address sender, address owner);
    error NotLocked(address receiver, string field);

    function _preflightChain(address sender) internal view {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (POLICY.code.length == 0) revert HasNoCode(POLICY);
        if (REGISTRY.code.length == 0) revert HasNoCode(REGISTRY);
        if (MOCK_FORWARDER.code.length == 0) revert HasNoCode(MOCK_FORWARDER);
        string memory version = ITypeAndVersion(MOCK_FORWARDER).typeAndVersion();
        if (keccak256(bytes(version)) != keccak256(bytes(MOCK_VERSION))) revert NotTheMockForwarder(version);
        address owner = VerifierPolicy(POLICY).owner();
        if (owner != sender) revert NotPolicyOwner(sender, owner);
    }

    function _requireLocked(SimulationReceiver r, bytes10 name, address expectedOwner) internal view {
        if (address(r).code.length == 0) revert HasNoCode(address(r));
        if (r.getForwarderAddress() != MOCK_FORWARDER) revert NotLocked(address(r), "forwarder");
        if (address(r.REGISTRY()) != REGISTRY) revert NotLocked(address(r), "registry");
        if (r.SENDING_WALLET() != CRE_WALLET) revert NotLocked(address(r), "sending wallet");
        if (r.getExpectedAuthor() != SIM_OWNER) revert NotLocked(address(r), "workflow author");
        if (r.getExpectedWorkflowName() != name) revert NotLocked(address(r), "workflow name");
        if (r.getExpectedWorkflowId() != SIM_WORKFLOW_ID) revert NotLocked(address(r), "workflow id");
        if (r.owner() != expectedOwner) revert NotLocked(address(r), "owner");
        if (r.MAX_FUTURE_SKEW() != 1 hours) revert NotLocked(address(r), "skew");
    }

    function _changeIdFor(address receiver) internal view returns (bytes32) {
        return keccak256(abi.encode(VerifierPolicy(POLICY).OP_ADD_RECEIVER(), abi.encode(receiver)));
    }
}

/// @notice Deploys the two simulation receivers, pins and reads them back, queues their listing
///         and unlists the two old receivers. FinalizeSimulationReceivers.s.sol lists them after
///         the 24 hour delay.
contract DeploySimulationReceivers is SimulationReceiversPlan {
    struct Deployment {
        address deployer;
        SimulationReceiver publicReceiver;
        SimulationReceiver sealedReceiver;
        bytes32 publicChangeId;
        bytes32 sealedChangeId;
        uint64 publicExecuteAfter;
        uint64 sealedExecuteAfter;
    }

    error OldReceiverStillListed(address receiver);
    error ChangeIdMismatch(bytes32 returned, bytes32 expected);

    /// @notice Runs every step from DEPLOYER_PRIVATE_KEY. Without --broadcast it is a dry run.
    function run() external returns (Deployment memory d) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        _preflightChain(deployer);

        vm.startBroadcast(deployerKey);
        d = _deployPinQueueUnlist(deployer);
        vm.stopBroadcast();

        _print(d);
    }

    /// @notice The same steps as `run` for a sender given by address, for the Anvil fork rehearsal.
    function deployAs(address deployer) external returns (Deployment memory d) {
        _preflightChain(deployer);

        vm.startBroadcast(deployer);
        d = _deployPinQueueUnlist(deployer);
        vm.stopBroadcast();

        _print(d);
    }

    function _deployPinQueueUnlist(address deployer) internal returns (Deployment memory d) {
        VerifierPolicy policy = VerifierPolicy(POLICY);

        SimulationReceiver publicReceiver = new SimulationReceiver(MOCK_FORWARDER, REGISTRY, CRE_WALLET);
        SimulationReceiver sealedReceiver = new SimulationReceiver(MOCK_FORWARDER, REGISTRY, CRE_WALLET);

        publicReceiver.setExpectedAuthor(SIM_OWNER);
        publicReceiver.setExpectedWorkflowName(PUBLIC_WORKFLOW);
        publicReceiver.setExpectedWorkflowId(SIM_WORKFLOW_ID);
        sealedReceiver.setExpectedAuthor(SIM_OWNER);
        sealedReceiver.setExpectedWorkflowName(SEALED_WORKFLOW);
        sealedReceiver.setExpectedWorkflowId(SIM_WORKFLOW_ID);

        _requireLocked(publicReceiver, PUBLIC_NAME, deployer);
        _requireLocked(sealedReceiver, SEALED_NAME, deployer);

        bytes32 publicChangeId = policy.queueAddReceiver(address(publicReceiver));
        bytes32 sealedChangeId = policy.queueAddReceiver(address(sealedReceiver));
        if (publicChangeId != _changeIdFor(address(publicReceiver))) {
            revert ChangeIdMismatch(publicChangeId, _changeIdFor(address(publicReceiver)));
        }
        if (sealedChangeId != _changeIdFor(address(sealedReceiver))) {
            revert ChangeIdMismatch(sealedChangeId, _changeIdFor(address(sealedReceiver)));
        }

        // Skip one already unlisted, so a rerun after a partial run does not revert.
        if (policy.isReceiver(OLD_PUBLIC)) policy.removeReceiver(OLD_PUBLIC);
        if (policy.isReceiver(OLD_SEALED)) policy.removeReceiver(OLD_SEALED);
        if (policy.isReceiver(OLD_PUBLIC)) revert OldReceiverStillListed(OLD_PUBLIC);
        if (policy.isReceiver(OLD_SEALED)) revert OldReceiverStillListed(OLD_SEALED);

        d = Deployment({
            deployer: deployer,
            publicReceiver: publicReceiver,
            sealedReceiver: sealedReceiver,
            publicChangeId: publicChangeId,
            sealedChangeId: sealedChangeId,
            publicExecuteAfter: policy.getPendingChange(publicChangeId).executeAfter,
            sealedExecuteAfter: policy.getPendingChange(sealedChangeId).executeAfter
        });
    }

    /// @dev Logs one RECORD line and writes no file: the launch script, which knows which run was
    ///      live, keeps the record. The public copy is proofs/simulation-receivers.txt.
    function _print(Deployment memory d) internal {
        VerifierPolicy policy = VerifierPolicy(POLICY);
        console2.log("chain id              ", block.chainid);
        console2.log("deployer              ", d.deployer);
        console2.log("public receiver       ", address(d.publicReceiver));
        console2.log("sealed receiver       ", address(d.sealedReceiver));
        console2.log("sending wallet        ", d.publicReceiver.SENDING_WALLET());
        console2.log("forwarder             ", d.publicReceiver.getForwarderAddress());
        console2.log("old public listed     ", policy.isReceiver(OLD_PUBLIC));
        console2.log("old sealed listed     ", policy.isReceiver(OLD_SEALED));
        console2.log("new public listed     ", policy.isReceiver(address(d.publicReceiver)));
        console2.log("new sealed listed     ", policy.isReceiver(address(d.sealedReceiver)));

        string memory root = "simulationReceivers";
        string memory json = vm.serializeUint(root, "chainId", block.chainid);
        json = vm.serializeAddress(root, "deployer", d.deployer);
        json = vm.serializeAddress(root, "policy", POLICY);
        json = vm.serializeAddress(root, "registry", REGISTRY);
        json = vm.serializeAddress(root, "forwarder", MOCK_FORWARDER);
        json = vm.serializeAddress(root, "sendingWallet", CRE_WALLET);
        json = vm.serializeAddress(root, "publicReceiver", address(d.publicReceiver));
        json = vm.serializeAddress(root, "sealedReceiver", address(d.sealedReceiver));
        json = vm.serializeBytes32(root, "publicChangeId", d.publicChangeId);
        json = vm.serializeBytes32(root, "sealedChangeId", d.sealedChangeId);
        json = vm.serializeUint(root, "publicExecuteAfter", d.publicExecuteAfter);
        json = vm.serializeUint(root, "sealedExecuteAfter", d.sealedExecuteAfter);
        json = vm.serializeAddress(root, "removedPublic", OLD_PUBLIC);
        json = vm.serializeAddress(root, "removedSealed", OLD_SEALED);
        console2.log("RECORD", json);
    }
}
