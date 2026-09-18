// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IMoolamConsent
/// @notice What a passport holder says about AI use of their picture, and every statement they
///         made before this one. The web app, the verify service and any crawler that wants to
///         know what was allowed on a given day are all written against this interface.
interface IMoolamConsent {
    /// @notice What the holder allows for one kind of AI use. Unspecified is where every passport
    ///         starts and is also the way back: a holder who no longer wants to say anything writes
    ///         all four fields Unspecified again. Constrained means the conditions are written in
    ///         the constraint text beside the statement.
    enum Use {
        Unspecified,
        Allowed,
        NotAllowed,
        Constrained
    }

    /// @notice The four uses one statement covers. They are independent: a holder can refuse
    ///         training and still allow inference.
    struct Consent {
        Use aiTraining;
        Use aiGenerativeTraining;
        Use aiInference;
        Use dataMining;
    }

    /// @notice One statement, kept exactly as it was written. Nothing here is ever edited, so a
    ///         reader can quote the entry that was in force on the day a picture was used.
    struct Entry {
        uint64 at; // block timestamp of the write
        address writer; // the holder who wrote it
        Consent consent;
        string constraintInfo; // free text, empty unless a field is Constrained
    }

    /// @notice A passport's holder stated how their picture may be used by AI.
    /// @param passportId The passport the statement is about.
    /// @param writer The address that held the passport when the statement was written.
    /// @param index Where this statement sits in the passport's history, counting from zero.
    /// @param consent The four field values exactly as stored.
    /// @param constraintInfo The conditions in free text, empty unless a field is Constrained.
    /// @param at The block timestamp the statement was written at.
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

    /// @notice The vocabulary this register speaks, named on chain so a reader never has to guess
    ///         what a value means. The four fields and the three stated values are those of the
    ///         CAWG Training and Data Mining assertion, version 1.1: aiTraining, aiGenerativeTraining,
    ///         aiInference and dataMining, each Allowed, NotAllowed or Constrained. Unspecified is
    ///         this contract's fourth value and means the creator has not stated that use at all.
    ///         Per that standard, a reader with no way to reach the creator treats Constrained the
    ///         same as NotAllowed.
    /// @return The assertion label and version.
    function STANDARD() external view returns (string memory);

    /// @notice The passport registry this contract asks who holds a passport.
    /// @return The registry address, fixed at deployment.
    function REGISTRY() external view returns (address);

    /// @notice How long the same address must wait before changing the same passport again.
    /// @return Ten minutes, in seconds.
    function MIN_INTERVAL() external view returns (uint64);

    /// @notice The longest the constraint text may be.
    /// @return 256 bytes.
    function MAX_INFO_BYTES() external view returns (uint256);

    /// @notice The most history entries one read can return.
    /// @return 64 entries.
    function MAX_PAGE() external view returns (uint256);

    /// @notice The most passports one batch call can state for.
    /// @return 32 passports.
    function MAX_BATCH() external view returns (uint256);

    /// @notice Records what the passport's holder allows AI to do with their picture.
    /// @param passportId The passport the statement is about.
    /// @param consent The four field values. All four Unspecified is a valid statement and takes
    ///        an earlier one back without hiding it.
    /// @param constraintInfo The conditions in free text: a licence name, a link to a policy file,
    ///        or a line of plain words. Required when any field is Constrained, refused otherwise,
    ///        at most 256 printable ASCII bytes.
    function setConsent(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) external;

    /// @notice Records the same statement for a whole set of passports in one transaction, for a
    ///         creator who wants one policy across their work.
    /// @dev All or nothing. If any one passport in the set is refused, for any reason, nothing is
    ///      written for any of them and the caller gets that passport's own error. Naming the same
    ///      passport twice in one call is refused as TooSoon, because the first write already
    ///      happened this second.
    /// @param passportIds The passports to state for, at least one and at most 32.
    /// @param consent The four field values, the same for every passport in the set.
    /// @param constraintInfo The conditions in free text, the same for every passport in the set.
    ///        It is checked once for the call, and stored against each passport.
    function setConsentBatch(bytes32[] calldata passportIds, Consent calldata consent, string calldata constraintInfo)
        external;

    /// @notice The statement that stands for a passport right now.
    /// @param passportId The passport to read.
    /// @return stated False when the holder has never said anything, in which case latest is empty.
    /// @return latest The newest entry in the passport's history.
    function consentOf(bytes32 passportId) external view returns (bool stated, Entry memory latest);

    /// @notice The statement that was in force at a moment in the past.
    /// @param passportId The passport to read.
    /// @param timestamp The moment to ask about, in seconds.
    /// @return stated False when nothing had been stated yet at that moment.
    /// @return inForce The last entry written at or before that moment.
    function consentAt(bytes32 passportId, uint64 timestamp) external view returns (bool stated, Entry memory inForce);

    /// @notice How many statements a passport has collected.
    /// @param passportId The passport to read.
    /// @return The number of entries, zero for a passport nobody has spoken for.
    function historyLength(bytes32 passportId) external view returns (uint256);

    /// @notice Reads a page of a passport's history, oldest first.
    /// @param passportId The passport to read.
    /// @param start Where to start, counting from zero.
    /// @param count How many to read. Clipped to what exists and to 64.
    /// @return page The entries, empty when start is past the end.
    function historyPage(bytes32 passportId, uint256 start, uint256 count) external view returns (Entry[] memory page);
}
