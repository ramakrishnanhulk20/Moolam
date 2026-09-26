// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IMoolamConsent
/// @notice What a passport holder says about AI use of their picture, and every statement they
///         made before. The web app, the verify service and crawlers read this interface.
interface IMoolamConsent {
    /// @notice What the holder allows for one kind of AI use. Unspecified is the start and also the
    ///         way back. Constrained means the conditions are in the constraint text.
    enum Use {
        Unspecified,
        Allowed,
        NotAllowed,
        Constrained
    }

    /// @notice The four uses one statement covers, each independent of the others.
    struct Consent {
        Use aiTraining;
        Use aiGenerativeTraining;
        Use aiInference;
        Use dataMining;
    }

    /// @notice One statement, never edited after it is written.
    struct Entry {
        uint64 at; // block timestamp of the write
        address writer; // the holder who wrote it
        Consent consent;
        string constraintInfo; // free text, empty unless a field is Constrained
    }

    /// @notice A passport's holder stated how their picture may be used by AI.
    /// @param passportId The passport.
    /// @param writer The holder at the time of writing.
    /// @param index The position in the passport's history, from zero.
    /// @param consent The four field values as stored.
    /// @param constraintInfo The conditions, empty unless a field is Constrained.
    /// @param at The block timestamp of the write.
    event ConsentSet(
        bytes32 indexed passportId,
        address indexed writer,
        uint256 indexed index,
        Consent consent,
        string constraintInfo,
        uint64 at
    );

    error NotPassportHolder(bytes32 passportId, address caller);
    error TooSoon(bytes32 passportId, uint64 nextAllowedAt);
    error ConstraintInfoRequired();
    error ConstraintInfoNotAllowed();
    error ConstraintInfoTooLong(uint256 length);
    error ConstraintInfoNotPrintable(uint256 position);
    error EmptyBatch();
    error BatchTooLarge(uint256 length);

    /// @notice The vocabulary of this register: the CAWG Training and Data Mining assertion, v1.1.
    function STANDARD() external view returns (string memory);

    /// @notice The passport registry this contract asks who holds a passport.
    function REGISTRY() external view returns (address);

    /// @notice How long the same address must wait before changing the same passport again.
    function MIN_INTERVAL() external view returns (uint64);

    /// @notice The longest the constraint text may be, in bytes.
    function MAX_INFO_BYTES() external view returns (uint256);

    /// @notice The most history entries one read can return.
    function MAX_PAGE() external view returns (uint256);

    /// @notice The most passports one batch call can state for.
    function MAX_BATCH() external view returns (uint256);

    /// @notice Records what the passport's holder allows AI to do with their picture.
    /// @dev Reverts NotPassportHolder, TooSoon, or a ConstraintInfo error. Emits ConsentSet.
    /// @param passportId The passport.
    /// @param consent The four field values. All four Unspecified takes an earlier statement back.
    /// @param constraintInfo Required when a field is Constrained, refused otherwise, at most 256
    ///        printable ASCII bytes.
    function setConsent(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) external;

    /// @notice Records the same statement for up to 32 passports in one transaction.
    /// @dev All or nothing: one refused passport reverts the call with its own error. Also reverts
    ///      EmptyBatch or BatchTooLarge. Emits one ConsentSet per passport, in order.
    /// @param passportIds The passports, at least one and at most 32.
    /// @param consent The four field values for every passport.
    /// @param constraintInfo The conditions for every passport.
    function setConsentBatch(bytes32[] calldata passportIds, Consent calldata consent, string calldata constraintInfo)
        external;

    /// @notice The statement that stands for a passport right now.
    /// @param passportId The passport.
    /// @return stated False when the holder has never said anything.
    /// @return latest The newest entry.
    function consentOf(bytes32 passportId) external view returns (bool stated, Entry memory latest);

    /// @notice The statement that was in force at a moment in the past.
    /// @param passportId The passport.
    /// @param timestamp The moment, in seconds.
    /// @return stated False when nothing had been stated yet.
    /// @return inForce The last entry written at or before that moment.
    function consentAt(bytes32 passportId, uint64 timestamp) external view returns (bool stated, Entry memory inForce);

    /// @notice How many statements a passport has collected.
    /// @param passportId The passport.
    function historyLength(bytes32 passportId) external view returns (uint256);

    /// @notice Reads a page of a passport's history, oldest first, clipped to 64 entries.
    /// @param passportId The passport.
    /// @param start Where to start, from zero.
    /// @param count How many to read.
    /// @return page The entries, empty when start is past the end.
    function historyPage(bytes32 passportId, uint256 start, uint256 count) external view returns (Entry[] memory page);
}
