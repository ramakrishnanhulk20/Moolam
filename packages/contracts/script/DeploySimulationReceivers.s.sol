// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @dev The one function of Chainlink's mock forwarder the preflight reads.
interface ITypeAndVersion {
    function typeAndVersion() external view returns (string memory);
}

/// @notice The plan both simulation receiver scripts check the chain against, and the read-back
///         that stops a run when a receiver is not locked the way the plan says.
abstract contract SimulationReceiversPlan is Script {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    /// @dev Chainlink's MockKeystoneForwarder on Monad mainnet, the forwarder `cre workflow
    ///      simulate --broadcast` delivers through. It answers typeAndVersion with MOCK_VERSION.
    address internal constant MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    string internal constant MOCK_VERSION = "MockKeystoneForwarder 1.0.0";
    /// @dev The CRE wallet: the one account whose transactions the new receivers accept.
    address internal constant CRE_WALLET = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
    /// @dev The two receivers the policy lists today. They come off the list in the same run.
    address internal constant OLD_PUBLIC = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant OLD_SEALED = 0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A;

    /// @dev What the simulator stamps into every report header, read off the real report
    ///      transactions 0x59e6a8d5... (public) and 0xa38fd971... (sealed) on Monad mainnet.
    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    string internal constant PUBLIC_WORKFLOW = "moolam-verifier";
    string internal constant SEALED_WORKFLOW = "moolam-sealed-verifier";
    /// @dev The name bytes those same headers carry. Written out rather than computed, so the
    ///      read-back compares the template's own hashing against what the simulator really sent.
    bytes10 internal constant PUBLIC_NAME = 0x34623863303364663034;
    bytes10 internal constant SEALED_NAME = 0x64323036636163326334;

    error WrongChain(uint256 actual, uint256 expected);
    error HasNoCode(address target);
    error NotTheMockForwarder(string typeAndVersion);
    error NotPolicyOwner(address sender, address owner);
    /// @notice A receiver read back something other than the plan. Nothing after this point runs.
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

    /// @dev R3. Every field that decides who can write through the receiver, read from the chain
    ///      and compared with the plan. Reverts NotLocked naming the first field that differs.
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

/// @notice Deploys the two simulation receivers, pins them to what the CRE simulator stamps,
///         reads both back, queues their listing in the VerifierPolicy, and removes the two old
///         receivers from the policy.
/// @dev Order matters and is the order of the work order: deploy, pin (author before name, because
///      the template refuses a name with no author), read back and stop on any mismatch, queue,
///      then unlist the old two. The listing waits the policy's 24 hours in the open;
///      FinalizeSimulationReceivers.s.sol runs it. Until then the re-check runner cannot write,
///      because the old receivers are already off the list. Two entry points: `run` sends from the
///      key in DEPLOYER_PRIVATE_KEY, and `deployAs` runs the same steps for a sender given by
///      address, which is how the fork rehearsal drives it on an Anvil fork without a key. The
///      executeAfter this script prints is the simulation's; the launch script replaces it with
///      the queue transaction's block timestamp plus CHANGE_DELAY.
contract DeploySimulationReceivers is SimulationReceiversPlan {
    /// @notice What the deploy produced, read back from the contracts.
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

    /// @notice Deploys, pins, queues and unlists from the wallet in DEPLOYER_PRIVATE_KEY.
    /// @dev Run without --broadcast for a dry run that sends nothing. Reverts on every check in
    ///      `_preflightChain`, on NotLocked, ChangeIdMismatch and OldReceiverStillListed.
    /// @return d The deployment as read back from the contracts.
    function run() external returns (Deployment memory d) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        _preflightChain(deployer);

        vm.startBroadcast(deployerKey);
        d = _deployPinQueueUnlist(deployer);
        vm.stopBroadcast();

        _print(d);
    }

    /// @notice The same steps as `run` for a sender given by address.
    /// @dev For the fork rehearsal on Anvil, with --unlocked and --sender set to the policy owner.
    /// @param deployer The wallet that sends the transactions. Must own the policy.
    /// @return d The deployment as read back from the contracts.
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

        // An old receiver already off the list is left alone, so a second run after a partial one
        // does not stop on the policy's NotAReceiver.
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
