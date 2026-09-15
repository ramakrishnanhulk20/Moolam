// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title MoolamReceiver
/// @notice The one door a Chainlink CRE workflow uses to write a verification result into the
///         Moolam registry. The workflow refetches the image, recomputes its fingerprint, and the
///         Chainlink nodes agree on the answer before any of it reaches this contract.
/// @dev Inherits Chainlink's ReceiverTemplate unchanged, so the forwarder check and the workflow
///      identity checks are theirs, not ours. The lock on this contract is those two together: the
///      call must come from the Chainlink forwarder, and the report metadata must carry the
///      workflow author and workflow name this contract is pinned to. Said plainly: the identity
///      is not set in the constructor, because the template stores it through owner-only setters.
///      So this contract starts with the pin open, and until the owner sets both, any report the
///      forwarder delivers is accepted on the forwarder check alone. The deploy script pins it in
///      the same transaction batch and script/ConfigureReceiver.s.sol can repin it later. That
///      same script clears the pin back to open for a `cre workflow simulate` run, because
///      Chainlink's mock forwarder sends no workflow metadata, and a cleared pin has to be set
///      again before the receiver is trusted in production. Swapping the forwarder or the pinned
///      identity is an owner action and every one of them emits an event. The VerifierPolicy list
///      is a separate control: it decides which receivers the registry will listen to at all, and
///      it is not a second lock on this door.
contract MoolamReceiver is ReceiverTemplate {
    /// @notice The registry this receiver writes into.
    IMoolamRegistry public immutable REGISTRY;

    mapping(bytes32 passportId => uint64 executedAt) private _lastExecutedAt;

    error ZeroAddress();
    /// @notice The report was built for a different chain.
    error WrongChain(uint256 reported, uint256 expected);
    /// @notice The report is not newer than the last one already recorded for this passport.
    error StaleReport(bytes32 passportId, uint64 reported, uint64 lastSeen);

    /// @notice Deploys the receiver and locks it to one registry.
    /// @dev The workflow author and workflow name are pinned straight after deployment with the
    ///      template's setExpectedAuthor and setExpectedWorkflowName. They are left open here
    ///      because a simulation run uses Chainlink's mock forwarder, which sends no metadata.
    /// @param forwarder The Chainlink KeystoneForwarder that is allowed to call onReport.
    /// @param registry The Moolam registry that will receive the attestations.
    constructor(address forwarder, address registry) ReceiverTemplate(forwarder) {
        if (registry == address(0)) revert ZeroAddress();
        REGISTRY = IMoolamRegistry(registry);
    }

    /// @notice The workflow timestamp of the newest report this contract accepted for a passport.
    /// @param passportId The passport to read.
    /// @return The executedAt value from that report, zero when no report has landed yet.
    function lastExecutedAt(bytes32 passportId) external view returns (uint64) {
        return _lastExecutedAt[passportId];
    }

    /// @dev Decodes one verification result and records it. Chainlink's own consumer guidance says
    ///      a report whose first transmission reverted can be sent again, and the same signed
    ///      report can be delivered on another chain, so the payload carries the chain it was built
    ///      for and the moment the workflow ran. Both are checked before anything is written, which
    ///      turns a replay into a revert instead of a duplicate attestation. The guard is per
    ///      receiver and nothing more: the floor lives in this contract's own storage and starts at
    ///      zero, so a report already used here would still be accepted by a second receiver
    ///      deployed later and listed by the policy. Listing one takes the policy's 24 hour queue,
    ///      so that is a visible owner action, not a quiet one.
    ///      Reverts WrongChain, StaleReport, and whatever the registry itself refuses.
    function _processReport(bytes calldata report) internal override {
        (
            uint256 chainId,
            uint64 executedAt,
            bytes32 passportId,
            bool matched,
            uint16 distance,
            bytes32 recomputed
        ) = abi.decode(report, (uint256, uint64, bytes32, bool, uint16, bytes32));

        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);

        uint64 lastSeen = _lastExecutedAt[passportId];
        if (executedAt <= lastSeen) revert StaleReport(passportId, executedAt, lastSeen);

        _lastExecutedAt[passportId] = executedAt;

        REGISTRY.attest(passportId, matched, distance, recomputed);
    }
}
