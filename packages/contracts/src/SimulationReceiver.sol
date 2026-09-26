// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title SimulationReceiver
/// @notice The door a workflow run in Chainlink's simulator (`cre workflow simulate --broadcast`)
///         uses to write a re-check verdict into the Moolam registry. It accepts a report only
///         from transactions sent by Moolam's CRE wallet, fixed at deployment.
/// @dev The simulator's mock forwarder checks no signature and anyone can stamp the same workflow
///      metadata, so the one value an outsider cannot produce is the wallet that signed the
///      transaction. Hence the tx.origin check.
///      Does not defend against:
///      - the CRE wallet key or the owner key: either holder can write or re-point at will;
///      - a verdict being one machine's word, with no network consensus behind it;
///      - smart accounts or relayers as sender (tx.origin is always a plain wallet);
///      - the CRE wallet signing anything but reports: a contract it calls inherits its authority;
///      - changes to Chainlink's mock forwarder.
contract SimulationReceiver is ReceiverTemplate {
    /// @notice How far past the current block time a report's executedAt may be.
    /// @dev An hour covers any honest machine clock drift, and caps how long a bad floor can lock a
    ///      passport out to one hour.
    uint256 public constant MAX_FUTURE_SKEW = 1 hours;

    /// @notice The registry this receiver writes into.
    IMoolamRegistry public immutable REGISTRY;

    /// @notice The only wallet whose transactions this receiver accepts reports from. No setter.
    address public immutable SENDING_WALLET;

    mapping(bytes32 passportId => uint64 executedAt) private _lastExecutedAt;

    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice The transaction was not sent by the sending wallet.
    error WrongSendingWallet(address origin, address expected);
    /// @notice The report was built for a different chain.
    error WrongChain(uint256 reported, uint256 expected);
    /// @notice The report is not newer than the last one recorded for this passport.
    error StaleReport(bytes32 passportId, uint64 reported, uint64 lastSeen);
    /// @notice The report's executedAt is more than MAX_FUTURE_SKEW ahead of the block.
    error ReportFromTheFuture(bytes32 passportId, uint64 reported, uint256 latestAccepted);

    /// @notice Deploys the receiver, locked to one registry and one sending wallet for good.
    /// @dev Pin the workflow author before the name: the template refuses a name with no author.
    ///      Reverts InvalidForwarderAddress or ZeroAddress on a zero argument.
    /// @param forwarder Chainlink's MockKeystoneForwarder, allowed to call onReport.
    /// @param registry The registry that receives the attestations.
    /// @param sendingWallet The plain wallet that must sign every report transaction.
    constructor(address forwarder, address registry, address sendingWallet) ReceiverTemplate(forwarder) {
        if (registry == address(0) || sendingWallet == address(0)) revert ZeroAddress();
        REGISTRY = IMoolamRegistry(registry);
        SENDING_WALLET = sendingWallet;
    }

    /// @notice The executedAt of the newest report accepted for a passport, zero if none.
    /// @param passportId The passport to read.
    function lastExecutedAt(bytes32 passportId) external view returns (uint64) {
        return _lastExecutedAt[passportId];
    }

    /// @dev Runs after the template's forwarder and pin checks. The time floor guards this
    ///      receiver only. Reverts WrongSendingWallet, WrongChain, StaleReport,
    ///      ReportFromTheFuture, or whatever the registry refuses.
    function _processReport(bytes calldata report) internal override {
        // tx.origin on purpose: msg.sender is Chainlink's public mock forwarder.
        // solhint-disable avoid-tx-origin
        // forge-lint: disable-next-line(tx-origin)
        if (tx.origin != SENDING_WALLET) revert WrongSendingWallet(tx.origin, SENDING_WALLET);
        // solhint-enable avoid-tx-origin

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

        uint256 latestAccepted = block.timestamp + MAX_FUTURE_SKEW;
        // forge-lint: disable-next-line(block-timestamp)
        if (executedAt > latestAccepted) revert ReportFromTheFuture(passportId, executedAt, latestAccepted);

        _lastExecutedAt[passportId] = executedAt;

        REGISTRY.attest(passportId, matched, distance, recomputed);
    }
}
