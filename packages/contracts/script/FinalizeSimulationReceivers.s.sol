// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {SimulationReceiversPlan} from "./DeploySimulationReceivers.s.sol";

/// @notice Runs the two queued listings once the 24 hour delay has passed, then reads the list
///         back: the two simulation receivers listed, the two old receivers not.
/// @dev Each receiver is read back against the plan again first, since a pin could have changed
///      during the delay.
contract FinalizeSimulationReceivers is SimulationReceiversPlan {
    error NothingQueued(bytes32 changeId);
    error QueuedChangeIsNotThisListing(bytes32 changeId, address receiver);
    error TooEarly(bytes32 changeId, uint64 executeAfter, uint256 secondsLeft);
    error NotListedAfterExecute(address receiver);
    error OldReceiverStillListed(address receiver);

    /// @notice Lists both simulation receivers from DEPLOYER_PRIVATE_KEY, with the addresses and
    ///         change ids from the deploy record. Without --broadcast it is a dry run.
    function run(address publicReceiver, address sealedReceiver, bytes32 publicChangeId, bytes32 sealedChangeId)
        external
    {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        (bool publicDue, bool sealedDue) =
            _ready(deployer, publicReceiver, sealedReceiver, publicChangeId, sealedChangeId);

        vm.startBroadcast(deployerKey);
        if (publicDue) VerifierPolicy(POLICY).execute(publicChangeId);
        if (sealedDue) VerifierPolicy(POLICY).execute(sealedChangeId);
        vm.stopBroadcast();

        _readBack(publicReceiver, sealedReceiver);
    }

    /// @notice The same steps as `run` for a sender given by address, for the Anvil fork rehearsal.
    function finalizeAs(
        address owner,
        address publicReceiver,
        address sealedReceiver,
        bytes32 publicChangeId,
        bytes32 sealedChangeId
    ) external {
        (bool publicDue, bool sealedDue) = _ready(owner, publicReceiver, sealedReceiver, publicChangeId, sealedChangeId);

        vm.startBroadcast(owner);
        if (publicDue) VerifierPolicy(POLICY).execute(publicChangeId);
        if (sealedDue) VerifierPolicy(POLICY).execute(sealedChangeId);
        vm.stopBroadcast();

        _readBack(publicReceiver, sealedReceiver);
    }

    function _ready(
        address sender,
        address publicReceiver,
        address sealedReceiver,
        bytes32 publicChangeId,
        bytes32 sealedChangeId
    ) internal view returns (bool publicDue, bool sealedDue) {
        _preflightChain(sender);
        _requireLocked(SimulationReceiver(publicReceiver), PUBLIC_NAME, sender);
        _requireLocked(SimulationReceiver(sealedReceiver), SEALED_NAME, sender);
        publicDue = _due(publicReceiver, publicChangeId);
        sealedDue = _due(sealedReceiver, sealedChangeId);
    }

    /// @dev False means already listed. A wrong, cancelled or early change reverts before anything is sent.
    function _due(address receiver, bytes32 changeId) internal view returns (bool) {
        VerifierPolicy policy = VerifierPolicy(POLICY);
        if (policy.isReceiver(receiver)) {
            console2.log("already listed, nothing to send for", receiver);
            return false;
        }
        if (changeId != _changeIdFor(receiver)) revert QueuedChangeIsNotThisListing(changeId, receiver);
        VerifierPolicy.PendingChange memory change = policy.getPendingChange(changeId);
        if (change.executeAfter == 0) revert NothingQueued(changeId);
        if (change.op != policy.OP_ADD_RECEIVER() || keccak256(change.data) != keccak256(abi.encode(receiver))) {
            revert QueuedChangeIsNotThisListing(changeId, receiver);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < change.executeAfter) {
            uint256 secondsLeft = change.executeAfter - block.timestamp;
            console2.log("Too early: the 24 hour delay has not passed. Seconds left:", secondsLeft);
            revert TooEarly(changeId, change.executeAfter, secondsLeft);
        }
        return true;
    }

    function _readBack(address publicReceiver, address sealedReceiver) internal view {
        VerifierPolicy policy = VerifierPolicy(POLICY);
        bool publicListed = policy.isReceiver(publicReceiver);
        bool sealedListed = policy.isReceiver(sealedReceiver);
        bool oldPublicListed = policy.isReceiver(OLD_PUBLIC);
        bool oldSealedListed = policy.isReceiver(OLD_SEALED);

        console2.log("policy                  ", POLICY);
        console2.log("public receiver         ", publicReceiver);
        console2.log("public receiver listed  ", publicListed);
        console2.log("sealed receiver         ", sealedReceiver);
        console2.log("sealed receiver listed  ", sealedListed);
        console2.log("old public listed       ", oldPublicListed);
        console2.log("old sealed listed       ", oldSealedListed);
        console2.log("sending wallet          ", SimulationReceiver(publicReceiver).SENDING_WALLET());

        if (!publicListed) revert NotListedAfterExecute(publicReceiver);
        if (!sealedListed) revert NotListedAfterExecute(sealedReceiver);
        if (oldPublicListed) revert OldReceiverStillListed(OLD_PUBLIC);
        if (oldSealedListed) revert OldReceiverStillListed(OLD_SEALED);
    }
}
