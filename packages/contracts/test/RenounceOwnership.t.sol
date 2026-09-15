// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: everything else about the three contracts. Its only job is to
// pin what OpenZeppelin's renounceOwnership does to the deployed system, so the operator manual
// and the threat model can point at an executed test instead of an argument.

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

    /// @dev The deployed contracts inherit Ownable2Step, so all three carry OpenZeppelin's
    ///      renounceOwnership and it is a single unguarded call that sets the owner to the zero
    ///      address with no second step and no way back. This test is the reason the operator must
    ///      never call it on any of the three: after it, the policy can never drop a compromised
    ///      receiver and the registry can never be paused, and no transaction can restore either.
    ///      The next version of these contracts overrides renounceOwnership to revert, which is
    ///      the fix. These three are already deployed and immutable, so the control here is the
    ///      operator manual plus this test.
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

        // The receiver loses its pin setters the same way, so a workflow identity swap is gone too.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        moolamReceiver.setExpectedAuthor(owner);

        assertTrue(policy.isReceiver(address(moolamReceiver)));
        assertFalse(registry.paused());
    }
}
