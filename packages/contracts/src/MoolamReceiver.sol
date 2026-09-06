// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title MoolamReceiver
/// @notice The one door a Chainlink CRE workflow uses to write a verification result into the
///         Moolam registry. The workflow refetches the image, recomputes its fingerprint, and the
///         Chainlink nodes agree on the answer before any of it reaches this contract.
/// @dev Inherits Chainlink's ReceiverTemplate unchanged, so the forwarder check and the optional
///      workflow id, owner and name checks are theirs, not ours. The registry then checks this
///      contract against the VerifierPolicy list, which means a swap of the forwarder address by
///      this contract's owner still cannot forge an attestation the policy has not allowed.
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
    ///      turns a replay into a revert instead of a duplicate attestation.
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
