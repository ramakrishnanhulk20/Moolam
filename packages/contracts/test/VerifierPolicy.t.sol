// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: anything about the registry itself, the receiver, or how the
// registry reads this policy. It also does not cover Ownable2Step, which is OpenZeppelin's own
// tested code, beyond checking that a non owner is refused.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {VerifierPolicy} from "../src/VerifierPolicy.sol";

// No receive and no fallback, so an empty call to it reverts. This is the wallet-shaped mistake
// the treasury probe is there to catch.
contract UnreachableTreasury {
    uint256 public marker;
}

contract PayableTreasury {
    receive() external payable {}
}

contract VerifierPolicyTest is Test {
    VerifierPolicy internal policy;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal receiver = makeAddr("receiver");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BOND = 0.05 ether;

    event ChangeQueued(bytes32 indexed id, bytes32 indexed op, bytes data, uint64 executeAfter);
    event ChangeExecuted(bytes32 indexed id);
    event ChangeCancelled(bytes32 indexed id);
    event ReceiverAdded(address indexed receiver);
    event ReceiverRemoved(address indexed receiver);
    event ResolverSet(address indexed resolver);
    event TreasurySet(address indexed treasury);
    event DisputeBondSet(uint256 bond);
    event BootstrapFinalized();

    function setUp() public {
        policy = new VerifierPolicy(owner, resolver, treasury, BOND);
    }

    function test_constructorStoresSettings() public view {
        assertEq(policy.owner(), owner);
        assertEq(policy.resolver(), resolver);
        assertEq(policy.treasury(), treasury);
        assertEq(policy.disputeBond(), BOND);
        assertFalse(policy.bootstrapped());
        assertFalse(policy.isReceiver(receiver));
    }

    function test_constructorRejectsZeroResolverOrTreasury() public {
        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        new VerifierPolicy(owner, address(0), treasury, BOND);

        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        new VerifierPolicy(owner, resolver, address(0), BOND);
    }

    function test_bootstrapAddReceiverListsImmediately() public {
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiverAdded(receiver);

        vm.prank(owner);
        policy.bootstrapAddReceiver(receiver);

        assertTrue(policy.isReceiver(receiver));
    }

    function test_bootstrapAddReceiverRejectsZeroAndDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        policy.bootstrapAddReceiver(address(0));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        vm.expectRevert(VerifierPolicy.AlreadyReceiver.selector);
        policy.bootstrapAddReceiver(receiver);
        vm.stopPrank();
    }

    function test_bootstrapIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        policy.bootstrapAddReceiver(receiver);
    }

    function test_finalizeBootstrapClosesTheWindowForGood() public {
        vm.expectEmit(false, false, false, false, address(policy));
        emit BootstrapFinalized();

        vm.startPrank(owner);
        policy.finalizeBootstrap();
        assertTrue(policy.bootstrapped());

        vm.expectRevert(VerifierPolicy.BootstrapClosed.selector);
        policy.finalizeBootstrap();

        vm.expectRevert(VerifierPolicy.BootstrapClosed.selector);
        policy.bootstrapAddReceiver(receiver);
        vm.stopPrank();
    }

    function test_queueAddReceiverWaitsTheFullDelay() public {
        vm.startPrank(owner);
        policy.finalizeBootstrap();

        uint64 expectedAfter = uint64(block.timestamp) + policy.CHANGE_DELAY();
        bytes32 expectedId = keccak256(abi.encode(policy.OP_ADD_RECEIVER(), abi.encode(receiver)));

        vm.expectEmit(true, true, false, true, address(policy));
        emit ChangeQueued(expectedId, policy.OP_ADD_RECEIVER(), abi.encode(receiver), expectedAfter);
        bytes32 id = policy.queueAddReceiver(receiver);
        assertEq(id, expectedId);
        assertFalse(policy.isReceiver(receiver));

        vm.warp(expectedAfter - 1);
        vm.expectRevert(abi.encodeWithSelector(VerifierPolicy.ChangeNotReady.selector, expectedAfter));
        policy.execute(id);

        vm.warp(expectedAfter);
        vm.expectEmit(true, false, false, false, address(policy));
        emit ChangeExecuted(id);
        policy.execute(id);
        vm.stopPrank();

        assertTrue(policy.isReceiver(receiver));
        assertEq(policy.getPendingChange(id).executeAfter, 0);
    }

    function test_queueSetResolverTreasuryAndBond() public {
        address newResolver = makeAddr("newResolver");
        address newTreasury = makeAddr("newTreasury");
        uint256 newBond = 1 ether;

        vm.startPrank(owner);
        bytes32 a = policy.queueSetResolver(newResolver);
        bytes32 b = policy.queueSetTreasury(newTreasury);
        bytes32 c = policy.queueSetDisputeBond(newBond);

        vm.warp(block.timestamp + policy.CHANGE_DELAY());

        vm.expectEmit(true, false, false, false, address(policy));
        emit ResolverSet(newResolver);
        policy.execute(a);

        vm.expectEmit(true, false, false, false, address(policy));
        emit TreasurySet(newTreasury);
        policy.execute(b);

        vm.expectEmit(false, false, false, true, address(policy));
        emit DisputeBondSet(newBond);
        policy.execute(c);
        vm.stopPrank();

        assertEq(policy.resolver(), newResolver);
        assertEq(policy.treasury(), newTreasury);
        assertEq(policy.disputeBond(), newBond);
    }

    function test_queueRejectsZeroAddressAndDuplicates() public {
        vm.startPrank(owner);
        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        policy.queueAddReceiver(address(0));

        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        policy.queueSetResolver(address(0));

        vm.expectRevert(VerifierPolicy.ZeroAddress.selector);
        policy.queueSetTreasury(address(0));

        policy.queueAddReceiver(receiver);
        vm.expectRevert(VerifierPolicy.ChangeAlreadyQueued.selector);
        policy.queueAddReceiver(receiver);
        vm.stopPrank();
    }

    function test_queueSetTreasuryRefusesAContractNothingCanReach() public {
        UnreachableTreasury unreachable = new UnreachableTreasury();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VerifierPolicy.TreasuryCannotReceive.selector, address(unreachable)));
        policy.queueSetTreasury(address(unreachable));
    }

    function test_queueSetTreasuryAcceptsAnEoaAndAContractThatCanTakePayment() public {
        PayableTreasury payableTreasury = new PayableTreasury();
        address eoa = makeAddr("eoaTreasury");

        vm.startPrank(owner);
        policy.queueSetTreasury(eoa);
        bytes32 id = policy.queueSetTreasury(address(payableTreasury));
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        policy.execute(id);
        vm.stopPrank();

        assertEq(policy.treasury(), address(payableTreasury));
    }

    function test_queueAddReceiverRejectsAnAlreadyListedAddress() public {
        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        vm.expectRevert(VerifierPolicy.AlreadyReceiver.selector);
        policy.queueAddReceiver(receiver);
        vm.stopPrank();
    }

    function test_cancelDropsAQueuedChange() public {
        vm.startPrank(owner);
        bytes32 id = policy.queueAddReceiver(receiver);

        vm.expectEmit(true, false, false, false, address(policy));
        emit ChangeCancelled(id);
        policy.cancel(id);

        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        vm.expectRevert(VerifierPolicy.UnknownChange.selector);
        policy.execute(id);

        vm.expectRevert(VerifierPolicy.UnknownChange.selector);
        policy.cancel(id);
        vm.stopPrank();

        assertFalse(policy.isReceiver(receiver));
    }

    function test_removeReceiverIsImmediate() public {
        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        policy.finalizeBootstrap();

        vm.expectEmit(true, false, false, false, address(policy));
        emit ReceiverRemoved(receiver);
        policy.removeReceiver(receiver);
        vm.stopPrank();

        assertFalse(policy.isReceiver(receiver));
    }

    function test_removeReceiverRejectsAnAddressThatIsNotListed() public {
        vm.prank(owner);
        vm.expectRevert(VerifierPolicy.NotAReceiver.selector);
        policy.removeReceiver(stranger);
    }

    function test_everyPrivilegedCallIsOwnerOnly() public {
        vm.startPrank(stranger);
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);

        vm.expectRevert(denied);
        policy.finalizeBootstrap();
        vm.expectRevert(denied);
        policy.removeReceiver(receiver);
        vm.expectRevert(denied);
        policy.queueAddReceiver(receiver);
        vm.expectRevert(denied);
        policy.queueSetResolver(stranger);
        vm.expectRevert(denied);
        policy.queueSetTreasury(stranger);
        vm.expectRevert(denied);
        policy.queueSetDisputeBond(1);
        vm.expectRevert(denied);
        policy.execute(bytes32(uint256(1)));
        vm.expectRevert(denied);
        policy.cancel(bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_executeRejectsAnUnknownChangeId() public {
        vm.prank(owner);
        vm.expectRevert(VerifierPolicy.UnknownChange.selector);
        policy.execute(keccak256("nothing here"));
    }

    function testFuzz_queuedBondIsWhateverWasQueued(uint256 bond) public {
        vm.startPrank(owner);
        bytes32 id = policy.queueSetDisputeBond(bond);
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        policy.execute(id);
        vm.stopPrank();

        assertEq(policy.disputeBond(), bond);
    }
}
