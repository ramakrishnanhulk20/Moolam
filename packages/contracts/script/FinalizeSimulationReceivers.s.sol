// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {SimulationReceiversPlan} from "./DeploySimulationReceivers.s.sol";

/// @notice Runs the two queued listings once the policy's 24 hour delay has passed, then reads the
///         list back: the two simulation receivers listed, the two old receivers not.
/// @dev Before anything is sent, each receiver is read back against the plan again, because the
///      owner key could have changed a pin during the delay, and each change id must be the
///      queued add of exactly that receiver with its delay over. A receiver already listed is
///      skipped. `run` sends from the key in DEPLOYER_PRIVATE_KEY and `finalizeAs` runs the same
///      steps for a sender given by address, for the fork rehearsal.
contract FinalizeSimulationReceivers is SimulationReceiversPlan {
    error NothingQueued(bytes32 changeId);
    error QueuedChangeIsNotThisListing(bytes32 changeId, address receiver);
    /// @notice The 24 hour delay is still running. Try again after executeAfter.
    error TooEarly(bytes32 changeId, uint64 executeAfter, uint256 secondsLeft);
    error NotListedAfterExecute(address receiver);
    error OldReceiverStillListed(address receiver);

    /// @notice Lists both simulation receivers from the wallet in DEPLOYER_PRIVATE_KEY.
    /// @dev Reverts on every check in `_preflightChain`, NotLocked, NothingQueued,
    ///      QueuedChangeIsNotThisListing, TooEarly, and on the read-back afterwards. Run without
    ///      --broadcast for a dry run.
    /// @param publicReceiver The public simulation receiver from the deploy record.
    /// @param sealedReceiver The sealed simulation receiver from the deploy record.
    /// @param publicChangeId The change id queueAddReceiver returned for the public receiver.
    /// @param sealedChangeId The change id queueAddReceiver returned for the sealed receiver.
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

    /// @notice The same steps as `run` for a sender given by address.
    /// @dev For the fork rehearsal on Anvil, with --unlocked and --sender set to the policy owner.
    /// @param owner The policy owner that sends the executes.
    /// @param publicReceiver The public simulation receiver.
    /// @param sealedReceiver The sealed simulation receiver.
    /// @param publicChangeId The public receiver's change id.
    /// @param sealedChangeId The sealed receiver's change id.
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

    /// @dev False when the receiver is already listed. Otherwise true or a revert, so a wrong,
    ///      cancelled or early change stops the run before any transaction is built.
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
