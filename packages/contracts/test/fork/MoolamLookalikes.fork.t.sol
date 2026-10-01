// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: the DON's signatures inside KeystoneForwarder.report (the forwarder is acted as by
// address), the CRE workflow, real MON spent, or the deploy script itself (run separately against a fork).

import {Test, console2} from "forge-std/Test.sol";

import {MoolamLookalikes} from "../../src/MoolamLookalikes.sol";
import {MoolamReceiver} from "../../src/MoolamReceiver.sol";
import {MoolamRegistry} from "../../src/MoolamRegistry.sol";

interface ITypeAndVersion {
    function typeAndVersion() external view returns (string memory);
}

contract MoolamLookalikesForkTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    // After 0x0d69 was pinned to the network workflow on 2026-10-01.
    uint256 internal constant FORK_BLOCK = 109_552_000;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant VERDICT_RECEIVER = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant DEPLOYER = 0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c;
    address internal constant WORKFLOW_OWNER = 0xf072a8c620bFc818875736E3f2d3A2A339c06584;
    string internal constant WORKFLOW_NAME = "moolam-verifier";
    bytes10 internal constant WORKFLOW_NAME_PIN = 0x34623863303364663034;

    bytes32 internal constant KIND = keccak256("moolam.lookalike.v1");
    bytes32 internal constant MONSOON = 0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638;
    bytes32 internal constant KANCHIPURAM = 0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4;

    event LookalikeChecked(
        bytes32 indexed passportId,
        bytes32 indexed earlierId,
        uint16 phashDistance,
        uint16 blockhashDistance,
        bool earlierSealed,
        uint64 executedAt
    );

    MoolamLookalikes internal lookalikes;

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

        // The same steps, in the same order, as script/DeployLookalikes.s.sol.
        vm.startPrank(DEPLOYER);
        lookalikes = new MoolamLookalikes(FORWARDER);
        lookalikes.setExpectedAuthor(WORKFLOW_OWNER);
        lookalikes.setExpectedWorkflowName(WORKFLOW_NAME);
        lookalikes.renounceOwnership();
        vm.stopPrank();
    }

    function test_theForwarderIsChainlinksLiveKeystoneForwarder() public view {
        assertGt(FORWARDER.code.length, 0);
        assertEq(ITypeAndVersion(FORWARDER).typeAndVersion(), "KeystoneForwarder 1.0.0");
        assertEq(lookalikes.getForwarderAddress(), FORWARDER);
        assertEq(lookalikes.getExpectedAuthor(), WORKFLOW_OWNER);
        assertEq(lookalikes.getExpectedWorkflowName(), WORKFLOW_NAME_PIN);
        assertEq(lookalikes.owner(), address(0));
    }

    function test_theForwarderDeliversAGoodReportAboutTwoLivePassports() public {
        MoolamRegistry registry = MoolamRegistry(REGISTRY);
        assertTrue(registry.passportExists(MONSOON));
        assertTrue(registry.passportExists(KANCHIPURAM));

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executedAt = uint64(block.timestamp);
        bytes memory payload =
            abi.encode(KIND, block.chainid, executedAt, KANCHIPURAM, MONSOON, uint16(2), uint16(9), false);

        vm.expectEmit(true, true, false, true, address(lookalikes));
        emit LookalikeChecked(KANCHIPURAM, MONSOON, 2, 9, false, executedAt);
        vm.prank(FORWARDER);
        uint256 start = gasleft();
        lookalikes.onReport(_metadata(), payload);
        console2.log("gas for onReport, first record for a passport:", start - gasleft());

        MoolamLookalikes.Lookalike memory r = lookalikes.originOf(KANCHIPURAM);
        assertEq(r.earlierId, MONSOON);
        assertEq(r.phashDistance, 2);
        assertEq(r.blockhashDistance, 9);
        assertFalse(r.earlierSealed);
        assertEq(r.executedAt, executedAt);
        assertEq(r.writtenAt, block.timestamp);
    }

    // 0x0d69 decodes (chainId, executedAt, passportId, matched, distance, recomputed). A look-alike
    // payload's fourth word is a passport id, never a valid bool, so its decoder refuses it with no
    // reason. A payload shaped to pass that decoder still fails WrongChain on the kind word.
    function test_aLookalikeReportSentToTheVerdictReceiverIsRefused() public {
        MoolamReceiver verdictReceiver = MoolamReceiver(VERDICT_RECEIVER);
        assertEq(verdictReceiver.getForwarderAddress(), FORWARDER);
        assertEq(verdictReceiver.getExpectedAuthor(), WORKFLOW_OWNER);
        assertEq(verdictReceiver.getExpectedWorkflowName(), WORKFLOW_NAME_PIN);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executedAt = uint64(block.timestamp);
        bytes memory payload =
            abi.encode(KIND, block.chainid, executedAt, KANCHIPURAM, MONSOON, uint16(2), uint16(9), false);

        uint256 before = MoolamRegistry(REGISTRY).attestationCount(KANCHIPURAM);
        vm.prank(FORWARDER);
        vm.expectRevert(bytes(""));
        verdictReceiver.onReport(_metadata(), payload);

        bytes memory boolShaped =
            abi.encode(KIND, block.chainid, executedAt, uint256(1), bytes32(0), uint16(2), uint16(9), false);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(MoolamReceiver.WrongChain.selector, uint256(KIND), block.chainid));
        verdictReceiver.onReport(_metadata(), boolShaped);

        assertEq(MoolamRegistry(REGISTRY).attestationCount(KANCHIPURAM), before);
    }

    function _metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), WORKFLOW_NAME_PIN, WORKFLOW_OWNER, bytes2(0));
    }
}
