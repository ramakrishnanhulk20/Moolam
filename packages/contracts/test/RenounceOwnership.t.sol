// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: anything but what OpenZeppelin's renounceOwnership does to the deployed system.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";

contract RenounceOwnershipTest is Test {
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MoolamReceiver internal moolamReceiver;
    MockAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal forwarder = makeAddr("forwarder");

    function setUp() public {
        agents = new MockAgentIdentity();

        policy = new VerifierPolicy(owner, resolver, treasury, 0.05 ether);
        registry = new MoolamRegistry(owner, address(policy), address(agents));

        vm.prank(owner);
        moolamReceiver = new MoolamReceiver(forwarder, address(registry));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(address(moolamReceiver));
        policy.finalizeBootstrap();
        vm.stopPrank();
    }

    // Why the operator must never renounce: it cannot be undone and ends removeReceiver and pause for good.
    function test_renouncingOwnershipLocksOutRemoveReceiverAndPauseForever() public {
        assertEq(registry.owner(), owner);
        assertEq(policy.owner(), owner);
        assertEq(moolamReceiver.owner(), owner);

        vm.startPrank(owner);
        registry.renounceOwnership();
        policy.renounceOwnership();
        moolamReceiver.renounceOwnership();
        vm.stopPrank();

        assertEq(registry.owner(), address(0));
        assertEq(policy.owner(), address(0));
        assertEq(moolamReceiver.owner(), address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        policy.removeReceiver(address(moolamReceiver));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        registry.pause();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        moolamReceiver.setExpectedAuthor(owner);

        assertTrue(policy.isReceiver(address(moolamReceiver)));
        assertFalse(registry.paused());
    }
}
