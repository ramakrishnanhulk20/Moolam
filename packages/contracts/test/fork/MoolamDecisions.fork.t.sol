// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: the resolver's real key (acted as by address), real MON spent, the reasons document
// on IPFS, or the index reading the event.

import {Test, console2} from "forge-std/Test.sol";

import {MoolamDecisions} from "../../src/MoolamDecisions.sol";
import {MoolamRegistry} from "../../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";
import {DisputeStatus} from "../../src/interfaces/IMoolamRegistry.sol";

contract MoolamDecisionsForkTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    uint256 internal constant FORK_BLOCK = 109_552_000;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    bytes32 internal constant MONSOON = 0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638;
    string internal constant REASONS = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    event DecisionPublished(
        bytes32 indexed passportId, uint64 indexed openedAt, bool upheld, string reasonsURI, address resolver
    );

    MoolamRegistry internal registry = MoolamRegistry(REGISTRY);
    VerifierPolicy internal policy = VerifierPolicy(POLICY);
    MoolamDecisions internal decisions;
    address internal challenger = makeAddr("challenger");

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

        decisions = new MoolamDecisions(REGISTRY, POLICY);
    }

    function test_aDisputeFlaggedResolvedAndPublishedOnTheLiveRegistry() public {
        assertEq(uint8(registry.getDispute(MONSOON).status), uint8(DisputeStatus.None));
        address resolver = policy.resolver();
        uint256 bond = policy.disputeBond();

        vm.deal(challenger, bond);
        vm.prank(challenger);
        registry.flag{value: bond}(MONSOON, "ipfs://evidence");
        uint64 openedAt = registry.getDispute(MONSOON).openedAt;

        vm.prank(resolver);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamDecisions.DisputeNotResolved.selector, MONSOON, DisputeStatus.Open)
        );
        decisions.publish(MONSOON, REASONS);

        vm.prank(resolver);
        registry.resolve(MONSOON, false);

        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.NotResolver.selector, challenger));
        decisions.publish(MONSOON, REASONS);

        vm.expectEmit(true, true, false, true, address(decisions));
        emit DecisionPublished(MONSOON, openedAt, false, REASONS, resolver);
        vm.prank(resolver);
        uint256 start = gasleft();
        decisions.publish(MONSOON, REASONS);
        console2.log("gas for publish:", start - gasleft());

        assertTrue(decisions.published(MONSOON, openedAt));

        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.AlreadyPublished.selector, MONSOON, openedAt));
        decisions.publish(MONSOON, REASONS);
    }
}
