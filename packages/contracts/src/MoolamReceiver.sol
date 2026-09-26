// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title MoolamReceiver
/// @notice The door a Chainlink CRE workflow uses to write a verification result into the Moolam
///         registry. The Chainlink nodes agree on the answer before it reaches this contract.
/// @dev The lock is Chainlink's ReceiverTemplate, unchanged: the forwarder check plus the pinned
///      workflow author and name. The pin starts open, since the template sets it through owner
///      setters, and until it is set any report the forwarder delivers is accepted. A pin cleared
///      for a `cre workflow simulate` run must be set again before the receiver is trusted.
///      Not a second lock: the VerifierPolicy list only decides which receivers the registry hears.
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
    /// @param forwarder The Chainlink KeystoneForwarder allowed to call onReport.
    /// @param registry The registry that receives the attestations.
    constructor(address forwarder, address registry) ReceiverTemplate(forwarder) {
        if (registry == address(0)) revert ZeroAddress();
        REGISTRY = IMoolamRegistry(registry);
    }

    /// @notice The executedAt of the newest report accepted for a passport, zero if none.
    /// @param passportId The passport to read.
    function lastExecutedAt(bytes32 passportId) external view returns (uint64) {
        return _lastExecutedAt[passportId];
    }

    /// @dev A reverted report can be sent again and a signed report can be replayed on another
    ///      chain, so the payload carries its chain and run time and both are checked first.
    ///      The time floor is per receiver: a second receiver listed later starts at zero.
    ///      Reverts WrongChain, StaleReport, or whatever the registry refuses.
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
