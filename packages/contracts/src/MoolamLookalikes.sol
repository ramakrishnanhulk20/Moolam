// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";

/// @title MoolamLookalikes
/// @notice Where Chainlink's network writes "this passport looks like an earlier one". One record per
///         passport, the newest only, written only through Chainlink's forwarder by the pinned workflow.
/// @dev The lock is Chainlink's ReceiverTemplate, unchanged. The deploy script pins the forwarder, the
///      workflow owner and the workflow name, reads them back, then renounces ownership, so nobody can
///      re-point this receiver afterwards. A forwarder move by Chainlink means a new receiver.
///      This contract never calls the registry, holds no money and makes no external call, so the
///      policy does not list it and nothing here can be stolen.
///      Does not defend against: the DON itself writing a wrong record; a record naming passports that
///      do not exist or a wrong order of registration (the index checks both against the registry);
///      what happens before ownership is renounced.
contract MoolamLookalikes is ReceiverTemplate {
    /// @notice One look-alike check of a passport. earlierId zero means no earlier look-alike was found.
    struct Lookalike {
        bytes32 earlierId;
        uint16 phashDistance;
        uint16 blockhashDistance;
        bool earlierSealed;
        uint64 executedAt;
        uint64 writtenAt;
    }

    /// @notice The first word of every look-alike report. A report without it is refused.
    /// @dev The verdict receiver 0x0d69 reads its first word as a chain id, so a look-alike report sent
    ///      there fails its chain check, and a verdict report sent here fails this one.
    bytes32 public constant LOOKALIKE_KIND = keccak256("moolam.lookalike.v1");

    /// @notice How far past the current block time a report's executedAt may be.
    /// @dev Without a ceiling, one report from a broken clock would set a floor no honest later run
    ///      could pass, and freeze that passport's record for good.
    uint256 public constant MAX_FUTURE_SKEW = 1 hours;

    /// @dev Eight static words: kind, chainId, executedAt, passportId, earlierId, two distances, sealed.
    uint256 private constant REPORT_LENGTH = 8 * 32;

    mapping(bytes32 passportId => Lookalike record) private _records;

    /// @notice Chainlink's network checked a passport for an earlier look-alike.
    /// @param passportId The passport that was checked.
    /// @param earlierId The earlier passport it looks like, zero for none.
    /// @param phashDistance Perceptual hash distance to the earlier passport, in bits of 64.
    /// @param blockhashDistance Block hash distance to the earlier passport, in bits of 256.
    /// @param earlierSealed Whether the earlier passport's picture is sealed.
    /// @param executedAt When the workflow run that produced this report started.
    event LookalikeChecked(
        bytes32 indexed passportId,
        bytes32 indexed earlierId,
        uint16 phashDistance,
        uint16 blockhashDistance,
        bool earlierSealed,
        uint64 executedAt
    );

    /// @notice The report is not exactly eight words long.
    error MalformedReport(uint256 length);
    /// @notice The report's first word is not LOOKALIKE_KIND.
    error WrongKind(bytes32 kind);
    /// @notice The report was built for a different chain.
    error WrongChain(uint256 reported, uint256 expected);
    /// @notice The report names no passport.
    error ZeroPassport();
    /// @notice The report names the passport as its own earlier look-alike.
    error SamePassport(bytes32 passportId);
    /// @notice The report is not newer than the record already stored for this passport.
    error StaleReport(bytes32 passportId, uint64 reported, uint64 lastSeen);
    /// @notice The report's executedAt is more than MAX_FUTURE_SKEW ahead of the block.
    error ReportFromTheFuture(bytes32 passportId, uint64 reported, uint256 latestAccepted);

    /// @notice Deploys the receiver behind one Chainlink forwarder.
    /// @dev Reverts InvalidForwarderAddress on the zero address. The workflow owner and name are set
    ///      after deployment through the template's setters, before ownership is renounced.
    /// @param forwarder The Chainlink KeystoneForwarder allowed to call onReport.
    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    /// @notice The newest look-alike record for a passport, all zero if none was ever written.
    /// @dev Its executedAt is this receiver's floor for the passport: only a later report replaces it.
    /// @param passportId The passport to read.
    function originOf(bytes32 passportId) external view returns (Lookalike memory) {
        return _records[passportId];
    }

    /// @dev Runs after the template's forwarder and pin checks. Reverts MalformedReport, WrongKind,
    ///      WrongChain, ZeroPassport, SamePassport, StaleReport or ReportFromTheFuture. Emits
    ///      LookalikeChecked.
    function _processReport(bytes calldata report) internal override {
        if (report.length != REPORT_LENGTH) revert MalformedReport(report.length);

        // Read before decoding: another payload shape can fail the decoder's range checks with no reason.
        bytes32 kind = bytes32(report[:32]);
        if (kind != LOOKALIKE_KIND) revert WrongKind(kind);

        (
            ,
            uint256 chainId,
            uint64 executedAt,
            bytes32 passportId,
            bytes32 earlierId,
            uint16 phashDistance,
            uint16 blockhashDistance,
            bool earlierSealed
        ) = abi.decode(report, (bytes32, uint256, uint64, bytes32, bytes32, uint16, uint16, bool));

        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);
        if (passportId == bytes32(0)) revert ZeroPassport();
        if (earlierId == passportId) revert SamePassport(passportId);

        uint64 lastSeen = _records[passportId].executedAt;
        if (executedAt <= lastSeen) revert StaleReport(passportId, executedAt, lastSeen);

        uint256 latestAccepted = block.timestamp + MAX_FUTURE_SKEW;
        // forge-lint: disable-next-line(block-timestamp)
        if (executedAt > latestAccepted) revert ReportFromTheFuture(passportId, executedAt, latestAccepted);

        _records[passportId] = Lookalike({
            earlierId: earlierId,
            phashDistance: phashDistance,
            blockhashDistance: blockhashDistance,
            earlierSealed: earlierSealed,
            executedAt: executedAt,
            // forge-lint: disable-next-line(unsafe-typecast)
            writtenAt: uint64(block.timestamp)
        });

        emit LookalikeChecked(passportId, earlierId, phashDistance, blockhashDistance, earlierSealed, executedAt);
    }
}
