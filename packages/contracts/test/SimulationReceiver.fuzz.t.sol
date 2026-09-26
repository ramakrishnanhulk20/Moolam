// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: the sending wallet signing a false verdict, the live mock forwarder (fork tests), other block times.

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {SimulationReceiverSetup} from "./SimulationReceiver.t.sol";

contract SimulationReceiverFuzzTest is SimulationReceiverSetup {
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
