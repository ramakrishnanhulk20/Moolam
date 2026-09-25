// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: the sending wallet itself signing a false verdict (the contract
// cannot tell, and says so in its non-goals), Chainlink's live mock forwarder (the fork tests), and
// executedAt values around a block time other than the one the fuzzer warps to.

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {SimulationReceiverSetup} from "./SimulationReceiver.t.sol";

contract SimulationReceiverFuzzTest is SimulationReceiverSetup {
    /// @dev R1. Whoever signs, and whoever calls the mock, only the sending wallet as tx.origin
    ///      writes. Checked straight at the receiver for the exact error and through the mock for
    ///      the outcome: nothing written, floor untouched.
    function testFuzz_anyOriginOtherThanTheSendingWalletIsRefused(address origin, address caller, uint64 executedAt)
        public
    {
        vm.assume(origin != creWallet);
        executedAt = uint64(bound(executedAt, 1, NOW + 1 hours));

        vm.prank(address(mock), origin);
        vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.WrongSendingWallet.selector, origin, creWallet));
        simReceiver.onReport(_metadata(), _payload(executedAt));

        vm.prank(caller, origin);
        mock.report(address(simReceiver), _raw(_payload(executedAt)), "", new bytes[](0));

        assertEq(registry.attestationCount(passportId), 0);
        assertEq(simReceiver.lastExecutedAt(passportId), 0);
    }

    /// @dev R4 over the whole uint64 range at a fuzzed block time: accepted exactly when
    ///      0 < executedAt <= now + MAX_FUTURE_SKEW, and the floor moves only on acceptance.
    function testFuzz_executedAtIsAcceptedExactlyUpToTheSkew(uint64 executedAt, uint64 blockTime) public {
        blockTime = uint64(bound(blockTime, NOW, type(uint64).max - 2 hours));
        vm.warp(blockTime);
        uint256 latest = uint256(blockTime) + 1 hours;

        vm.prank(address(mock), creWallet);
        if (executedAt == 0) {
            vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.StaleReport.selector, passportId, 0, 0));
        } else if (executedAt > latest) {
            vm.expectRevert(
                abi.encodeWithSelector(SimulationReceiver.ReportFromTheFuture.selector, passportId, executedAt, latest)
            );
        }
        simReceiver.onReport(_metadata(), _payload(executedAt));

        bool accepted = executedAt != 0 && executedAt <= latest;
        assertEq(simReceiver.lastExecutedAt(passportId), accepted ? executedAt : 0);
        assertEq(registry.attestationCount(passportId), accepted ? 1 : 0);
    }

    /// @dev R4 near the edge, where a mistake would be an off-by-one: within two hours either
    ///      side of now plus the skew.
    function testFuzz_executedAtNearTheBound(int256 offset) public {
        offset = bound(offset, -2 hours, 2 hours);
        uint256 edge = uint256(NOW) + 1 hours;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executedAt = uint64(uint256(int256(edge) + offset));

        vm.prank(address(mock), creWallet);
        if (offset > 0) {
            vm.expectRevert(
                abi.encodeWithSelector(SimulationReceiver.ReportFromTheFuture.selector, passportId, executedAt, edge)
            );
        }
        simReceiver.onReport(_metadata(), _payload(executedAt));

        assertEq(simReceiver.lastExecutedAt(passportId), offset > 0 ? 0 : executedAt);
    }
}
