// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: any report or listing. It only reads the latest block for the receiver swap of 2026-09-26.

import {Test, console2} from "forge-std/Test.sol";

import {SimulationReceiver} from "../../src/SimulationReceiver.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";

contract ReceiverSwapForkTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant CRE_WALLET = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;

    address internal constant OLD_PUBLIC = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant OLD_SEALED = 0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A;

    address internal constant NEW_PUBLIC = 0x4aD66c77f961884E9e866EEEc3EafF1EdB5BAa95;
    address internal constant NEW_SEALED = 0x52b8fE549B432920eeB061c26cAc5c2D527657f6;
    bytes32 internal constant PUBLIC_CHANGE = 0x4a6589bbfe8f5fa2957f2af550bfbd2be0f9dd227eaf72cad106b34562f0480d;
    bytes32 internal constant SEALED_CHANGE = 0x018889ea4917dceb5f7d660f8c3e1f841a29495f48996a865678f3e3fdd65139;
    uint64 internal constant PUBLIC_EXECUTE_AFTER = 1_790_489_029;
    uint64 internal constant SEALED_EXECUTE_AFTER = 1_790_489_031;

    VerifierPolicy internal policy = VerifierPolicy(POLICY);

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("Skipped: MONAD_MAINNET_RPC_URL is not set, so there is no Monad mainnet to fork.");
            vm.skip(true);
            return;
        }
        // Deliberately unpinned: this file checks the chain as it is now.
        vm.createSelectFork(rpc);
        assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID, "the RPC is not Monad mainnet");
    }

    function test_theOldReceiversAreOffThePolicy() public view {
        assertFalse(policy.isReceiver(OLD_PUBLIC));
        assertFalse(policy.isReceiver(OLD_SEALED));
    }

    function test_theNewReceiversAreQueuedOrListed() public view {
        _assertQueuedOrListed(NEW_PUBLIC, PUBLIC_CHANGE, PUBLIC_EXECUTE_AFTER);
        _assertQueuedOrListed(NEW_SEALED, SEALED_CHANGE, SEALED_EXECUTE_AFTER);
    }

    function test_theNewReceiversAreTheDeployedSimulationReceivers() public view {
        _assertReceiver(SimulationReceiver(NEW_PUBLIC));
        _assertReceiver(SimulationReceiver(NEW_SEALED));
        assertEq(NEW_PUBLIC.codehash, NEW_SEALED.codehash);
    }

    // Listing clears the pending entry, so exactly one of the two states holds.
    function _assertQueuedOrListed(address receiver, bytes32 changeId, uint64 executeAfter) internal view {
        assertEq(changeId, keccak256(abi.encode(policy.OP_ADD_RECEIVER(), abi.encode(receiver))));
        VerifierPolicy.PendingChange memory change = policy.getPendingChange(changeId);
        if (policy.isReceiver(receiver)) {
            console2.log("listed:", receiver);
            assertEq(change.executeAfter, 0);
        } else {
            console2.log("queued, not yet listed:", receiver);
            assertEq(change.op, policy.OP_ADD_RECEIVER());
            assertEq(change.data, abi.encode(receiver));
            assertEq(change.executeAfter, executeAfter);
        }
    }

    function _assertReceiver(SimulationReceiver r) internal view {
        assertGt(address(r).code.length, 0);
        assertEq(r.getForwarderAddress(), MOCK_FORWARDER);
        assertEq(r.SENDING_WALLET(), CRE_WALLET);
        assertEq(address(r.REGISTRY()), REGISTRY);
    }
}
