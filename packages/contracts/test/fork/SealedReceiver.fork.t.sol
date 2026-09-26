// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: real MON spent, the forwarder's signature check (we act as its address), or the deploy file write.

import {Test, console2} from "forge-std/Test.sol";

import {MoolamReceiver} from "../../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";
import {MoolamRegistry} from "../../src/MoolamRegistry.sol";
import {ReceiverTemplate} from "../../src/vendor/chainlink/ReceiverTemplate.sol";
import {Attestation} from "../../src/interfaces/IMoolamRegistry.sol";
import {DeploySealedReceiver} from "../../script/DeploySealedReceiver.s.sol";
import {FinalizeSealedReceiver} from "../../script/FinalizeSealedReceiver.s.sol";

contract SealedReceiverForkTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    // Pinned to a block while the old public receiver was still listed (removed at 108,102,728).
    uint256 internal constant FORK_BLOCK = 108_102_500;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant PUBLIC_RECEIVER = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant PRODUCTION_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant WORKFLOW_AUTHOR = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
    bytes32 internal constant PASSPORT = 0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638;

    // The first ten hex characters of sha256 of each workflow name, as the template stores them.
    bytes10 internal constant SEALED_NAME = bytes10("d206cac2c4");
    bytes10 internal constant PUBLIC_NAME = bytes10("4b8c03df04");

    VerifierPolicy internal policy = VerifierPolicy(POLICY);
    MoolamRegistry internal registry = MoolamRegistry(REGISTRY);
    MoolamReceiver internal publicReceiver = MoolamReceiver(PUBLIC_RECEIVER);

    FinalizeSealedReceiver internal finalizer;
    DeploySealedReceiver.Deployment internal deployed;
    MoolamReceiver internal sealedReceiver;
    address internal policyOwner;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("Skipped: MONAD_MAINNET_RPC_URL is not set, so there is no Monad mainnet to fork.");
            vm.skip(true);
            return;
        }

        // forge-lint: disable-next-line(unused-return)
        vm.createSelectFork(rpc, FORK_BLOCK);
        assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID, "the RPC is not Monad mainnet");

        policyOwner = policy.owner();
        finalizer = new FinalizeSealedReceiver();
        deployed = new DeploySealedReceiver().deployAs(policyOwner);
        sealedReceiver = deployed.sealedReceiver;
    }

    function test_theDeployPinsTheProductionForwarderTheAuthorAndTheSealedName() public view {
        assertGt(address(sealedReceiver).code.length, 0);
        assertEq(sealedReceiver.getForwarderAddress(), PRODUCTION_FORWARDER);
        assertEq(address(sealedReceiver.REGISTRY()), REGISTRY);
        assertEq(sealedReceiver.getExpectedAuthor(), WORKFLOW_AUTHOR);
        assertEq(sealedReceiver.getExpectedWorkflowName(), SEALED_NAME);
        assertEq(sealedReceiver.getExpectedWorkflowId(), bytes32(0));
        assertEq(sealedReceiver.owner(), policyOwner);
        assertEq(deployed.deployer, policyOwner);
        assertEq(deployed.workflowAuthor, WORKFLOW_AUTHOR);
        assertEq(deployed.workflowName, SEALED_NAME);

        assertEq(address(sealedReceiver).codehash, PUBLIC_RECEIVER.codehash);
        assertEq(publicReceiver.getExpectedWorkflowName(), PUBLIC_NAME);
        assertEq(publicReceiver.getExpectedAuthor(), WORKFLOW_AUTHOR);
        assertEq(publicReceiver.getForwarderAddress(), PRODUCTION_FORWARDER);
    }

    function test_thePolicyHoldsAPendingListingForItAndTheRegistryIgnoresItUntilThen() public {
        VerifierPolicy.PendingChange memory change = policy.getPendingChange(deployed.changeId);
        assertEq(change.op, policy.OP_ADD_RECEIVER());
        assertEq(change.data, abi.encode(address(sealedReceiver)));
        assertEq(change.executeAfter, block.timestamp + policy.CHANGE_DELAY());
        assertEq(change.executeAfter, deployed.executeAfter);
        assertEq(deployed.changeId, keccak256(abi.encode(policy.OP_ADD_RECEIVER(), change.data)));
        assertFalse(policy.isReceiver(address(sealedReceiver)));
        assertTrue(policy.isReceiver(PUBLIC_RECEIVER));

        uint256 before = registry.attestationCount(PASSPORT);
        vm.prank(PRODUCTION_FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, address(sealedReceiver)));
        sealedReceiver.onReport(_metadata(SEALED_NAME, WORKFLOW_AUTHOR), _report(PASSPORT));
        assertEq(registry.attestationCount(PASSPORT), before);
    }

    function test_executeBeforeTheDelayRevertsAtThePolicyAndInTheFinalizeScript() public {
        uint64 executeAfter = deployed.executeAfter;

        vm.prank(policyOwner);
        vm.expectRevert(abi.encodeWithSelector(VerifierPolicy.ChangeNotReady.selector, executeAfter));
        policy.execute(deployed.changeId);

        vm.warp(executeAfter - 1);
        vm.prank(policyOwner);
        vm.expectRevert(abi.encodeWithSelector(VerifierPolicy.ChangeNotReady.selector, executeAfter));
        policy.execute(deployed.changeId);

        vm.expectRevert(abi.encodeWithSelector(FinalizeSealedReceiver.TooEarly.selector, executeAfter, 1));
        finalizer.finalizeAs(policyOwner, policy, address(sealedReceiver), PUBLIC_RECEIVER, deployed.changeId);

        assertFalse(policy.isReceiver(address(sealedReceiver)));
        assertEq(policy.getPendingChange(deployed.changeId).executeAfter, executeAfter);
    }

    function test_afterTheDelayTheFinalizeScriptListsItAndThePublicReceiverStaysListed() public {
        vm.warp(deployed.executeAfter);

        bool listed =
            finalizer.finalizeAs(policyOwner, policy, address(sealedReceiver), PUBLIC_RECEIVER, deployed.changeId);

        assertTrue(listed);
        assertTrue(policy.isReceiver(address(sealedReceiver)));
        assertTrue(policy.isReceiver(PUBLIC_RECEIVER));
        assertEq(policy.getPendingChange(deployed.changeId).executeAfter, 0);

        vm.recordLogs();
        assertTrue(
            finalizer.finalizeAs(policyOwner, policy, address(sealedReceiver), PUBLIC_RECEIVER, deployed.changeId)
        );
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_aSealedReportThroughTheForwarderLandsOnTheNewReceiver() public {
        _list();
        uint256 before = registry.attestationCount(PASSPORT);
        assertLt(before, registry.MAX_ATTESTATIONS(), "the passport has no room for another attestation");

        vm.prank(PRODUCTION_FORWARDER);
        sealedReceiver.onReport(_metadata(SEALED_NAME, WORKFLOW_AUTHOR), _report(PASSPORT));

        assertEq(registry.attestationCount(PASSPORT), before + 1);
        Attestation memory landed = registry.getAttestations(PASSPORT, before, 1)[0];
        assertEq(landed.receiver, address(sealedReceiver));
        assertTrue(landed.receiver != PUBLIC_RECEIVER);
        assertTrue(landed.matched);
        assertEq(landed.distance, 3);
        assertEq(landed.recomputed, keccak256("sealed"));
        assertEq(sealedReceiver.lastExecutedAt(PASSPORT), block.timestamp);
    }

    function test_theSameReportCarryingThePublicNameIsRefusedByTheNewReceiver() public {
        _list();
        uint256 before = registry.attestationCount(PASSPORT);

        vm.prank(PRODUCTION_FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowName.selector, PUBLIC_NAME, SEALED_NAME));
        sealedReceiver.onReport(_metadata(PUBLIC_NAME, WORKFLOW_AUTHOR), _report(PASSPORT));

        assertEq(registry.attestationCount(PASSPORT), before);
        assertEq(sealedReceiver.lastExecutedAt(PASSPORT), 0);
    }

    function test_aReportCarryingTheSealedNameIsRefusedByThePublicReceiver() public {
        _list();
        uint256 before = registry.attestationCount(PASSPORT);
        uint64 floorBefore = publicReceiver.lastExecutedAt(PASSPORT);

        vm.prank(PRODUCTION_FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowName.selector, SEALED_NAME, PUBLIC_NAME));
        publicReceiver.onReport(_metadata(SEALED_NAME, WORKFLOW_AUTHOR), _report(PASSPORT));

        assertEq(registry.attestationCount(PASSPORT), before);
        assertEq(publicReceiver.lastExecutedAt(PASSPORT), floorBefore);
    }

    function _list() internal {
        vm.warp(deployed.executeAfter);
        vm.prank(policyOwner);
        policy.execute(deployed.changeId);
        assertTrue(policy.isReceiver(address(sealedReceiver)));
    }

    function _metadata(bytes10 workflowName, address workflowAuthor) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), workflowName, workflowAuthor, bytes2(0));
    }

    function _report(bytes32 passportId) internal view returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encode(block.chainid, uint64(block.timestamp), passportId, true, uint16(3), keccak256("sealed"));
    }
}
