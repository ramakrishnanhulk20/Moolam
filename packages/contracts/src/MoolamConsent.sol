// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IMoolamConsent} from "./interfaces/IMoolamConsent.sol";

/// @title MoolamConsent
/// @notice Where a creator states whether their picture may be used to train AI, and the record of
///         every statement they have made. The chain keeps each statement with its date, so a year
///         later anyone can show what was allowed on the day a picture was taken.
/// @dev The passport registry handed in at deployment is the only authority: whoever the registry
///      says holds a passport is the only address that can write for it, read inside the same call
///      so a transfer takes effect immediately. There is no owner, no pause, no upgrade path and no
///      way to send money here, so an attacker has nothing to steal and nobody to impersonate.
///      There is no reentrancy guard because there is nothing to re-enter with: the one external
///      call is ownerOf, a view, which the compiler makes as a static call, so nothing it reaches
///      can change state, and it goes to a fixed contract before this one reads or writes anything.
contract MoolamConsent is IMoolamConsent {
    /// @dev Exactly one storage slot: 64 bits of timestamp, 160 of writer and four one byte
    ///      fields. A statement with no constraint text therefore costs one slot to write.
    struct StoredEntry {
        uint64 at;
        address writer;
        Use aiTraining;
        Use aiGenerativeTraining;
        Use aiInference;
        Use dataMining;
    }

    /// @notice The vocabulary this register speaks, named on chain so nobody has to guess.
    /// @dev The four fields and the three stated values are the ones the CAWG Training and Data
    ///      Mining assertion defines in version 1.1, so a statement here and a statement embedded in
    ///      a file mean the same thing and neither side has to translate. Unspecified is this
    ///      contract's own fourth value: the creator has not stated that use. Per the standard, a
    ///      reader with no way to reach the creator treats Constrained as NotAllowed.
    string public constant STANDARD = "cawg.training-mining/1.1";

    /// @notice The passport registry this contract asks who holds a passport.
    address public immutable REGISTRY;

    /// @notice How long the same address must wait before changing the same passport again.
    /// @dev Ten minutes. It bounds what one holder can cost the app that sponsors their fee, and it
    ///      is deliberately not applied to a new holder, so a seller writing just before a sale
    ///      cannot lock the buyer out.
    uint64 public constant MIN_INTERVAL = 600;

    /// @notice The longest the constraint text may be.
    /// @dev The text is attacker written and every reader's parser sees it, so it is bounded here
    ///      once for all of them. 256 bytes fits a licence name, a link to a policy file or a line
    ///      of plain conditions with room to spare.
    uint256 public constant MAX_INFO_BYTES = 256;

    /// @notice The most history entries one read can return.
    /// @dev A page is bounded so the cost of one read never depends on how long a history has
    ///      grown: a caller asks for the next page instead. 64 entries, each carrying a full 256
    ///      bytes of text, stay far under the Monad block gas limit.
    uint256 public constant MAX_PAGE = 64;

    /// @notice The most passports one batch call can state for.
    /// @dev 32. The cap exists because the loop walks calldata the caller chose, so it needs a
    ///      ceiling that is provably inside one transaction. The worst batch, 32 first statements
    ///      each carrying a full 256 bytes of text, measures 8,144,656 gas in
    ///      test_gasOfTheMainActions, a bit over a quarter of Monad's 30,000,000 gas per
    ///      transaction limit. A creator with more than 32 pictures sends a second call.
    uint256 public constant MAX_BATCH = 32;

    mapping(bytes32 passportId => StoredEntry[] history) private _history;
    mapping(bytes32 passportId => mapping(uint256 index => string text)) private _constraintInfo;

    error ZeroAddress();
    error NotAContract();

    /// @notice Deploys the register and locks in the passport registry it trusts.
    /// @dev ownerOf is read through try/catch, and a call to an address with no code returns empty
    ///      data that cannot be decoded, which would make every passport look unheld. Refuse that
    ///      at deployment rather than ship a contract nobody can ever write to.
    /// @param registry The Moolam passport registry, an ERC-721 whose token id is uint256 of the
    ///        passport id.
    constructor(address registry) {
        if (registry == address(0)) revert ZeroAddress();
        if (registry.code.length == 0) revert NotAContract();
        REGISTRY = registry;
    }

    /// @inheritdoc IMoolamConsent
    /// @dev Authority is the registry's answer to ownerOf during this call and nothing else. An
    ///      ERC-721 approval or an operator is permission to move the token, granted to
    ///      marketplaces and escrows, and it must never become permission to speak for the creator.
    ///      A passport that does not exist makes ownerOf revert, which is caught and refused as
    ///      NotPassportHolder so callers never have to read another contract's error.
    ///      Reverts NotPassportHolder when the caller does not hold the passport, TooSoon when the
    ///      same writer changed it less than MIN_INTERVAL ago or when the block timestamp has not
    ///      moved past the last entry, ConstraintInfoRequired, ConstraintInfoNotAllowed,
    ///      ConstraintInfoTooLong and ConstraintInfoNotPrintable on the text. Emits ConsentSet.
    function setConsent(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) external {
        _checkConstraintInfo(consent, constraintInfo);
        _record(passportId, consent, constraintInfo);
    }

    /// @inheritdoc IMoolamConsent
    /// @dev Every passport goes through the same private write as a single statement, so there is
    ///      one set of rules and no second copy of any of them. The whole call reverts on the first
    ///      passport that is refused, which is what makes it all or nothing: a creator either has
    ///      the policy they asked for across the whole set, or nothing changed at all. The text is
    ///      checked once for the call rather than once per passport, because it is the same text.
    ///      Reverts EmptyBatch on no passports, BatchTooLarge above MAX_BATCH, and otherwise
    ///      whatever a single statement for that passport would revert with. Emits one ConsentSet
    ///      per passport, in the order given.
    function setConsentBatch(bytes32[] calldata passportIds, Consent calldata consent, string calldata constraintInfo)
        external
    {
        uint256 length = passportIds.length;
        if (length == 0) revert EmptyBatch();
        if (length > MAX_BATCH) revert BatchTooLarge(length);

        _checkConstraintInfo(consent, constraintInfo);

        for (uint256 i = 0; i < length; ++i) {
            _record(passportIds[i], consent, constraintInfo);
        }
    }

    /// @inheritdoc IMoolamConsent
    function consentOf(bytes32 passportId) external view returns (bool stated, Entry memory latest) {
        StoredEntry[] storage list = _history[passportId];
        uint256 length = list.length;
        // forge-lint: disable-next-line(boolean-cst)
        if (length == 0) return (false, latest);
        // forge-lint: disable-next-line(boolean-cst)
        return (true, _read(passportId, list, length - 1));
    }

    /// @inheritdoc IMoolamConsent
    /// @dev A binary search, which is exact because setConsent refuses an entry whose timestamp is
    ///      not strictly later than the one before it. The loop runs log2 of the history length
    ///      times, so a passport with a thousand statements costs ten steps.
    function consentAt(bytes32 passportId, uint64 timestamp) external view returns (bool stated, Entry memory inForce) {
        StoredEntry[] storage list = _history[passportId];
        uint256 length = list.length;
        // forge-lint: disable-next-line(boolean-cst)
        if (length == 0 || list[0].at > timestamp) return (false, inForce);

        uint256 low = 0;
        uint256 high = length - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (list[mid].at <= timestamp) low = mid;
            else high = mid - 1;
        }
        // forge-lint: disable-next-line(boolean-cst)
        return (true, _read(passportId, list, low));
    }

    /// @inheritdoc IMoolamConsent
    function historyLength(bytes32 passportId) external view returns (uint256) {
        return _history[passportId].length;
    }

    /// @inheritdoc IMoolamConsent
    /// @dev Read only and capped at MAX_PAGE, so no caller can be made to pay for a long history
    ///      and no on chain function ever walks this array.
    function historyPage(bytes32 passportId, uint256 start, uint256 count) external view returns (Entry[] memory page) {
        StoredEntry[] storage list = _history[passportId];
        uint256 length = list.length;
        if (start >= length) return new Entry[](0);

        uint256 remaining = length - start;
        if (count > remaining) count = remaining;
        if (count > MAX_PAGE) count = MAX_PAGE;

        page = new Entry[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = _read(passportId, list, start + i);
        }
    }

    /// @dev The one place a statement is written, whether it arrived alone or in a batch. The text
    ///      has already been checked against the four fields by the caller of this function, once
    ///      per call rather than once per passport, because one call carries one text.
    function _record(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) private {
        address holder = _holderOf(passportId);
        // Refusing the moment one passport is not the caller's is what makes a batch all or
        // nothing, so this revert is inside the batch loop on purpose, and MAX_BATCH bounds it.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (holder == address(0) || msg.sender != holder) revert NotPassportHolder(passportId, msg.sender);

        StoredEntry[] storage list = _history[passportId];
        uint256 index = list.length;
        if (index != 0) {
            StoredEntry storage last = list[index - 1];
            // Two rules in one comparison. The same writer waits out MIN_INTERVAL. Anyone else
            // waits only for the clock to move, which is what keeps the timestamps of one
            // passport strictly increasing even when a transfer and a write share a block. It is
            // also what refuses the same passport named twice in one batch: the first write is
            // already in this second.
            uint64 nextAllowedAt = last.writer == msg.sender ? last.at + MIN_INTERVAL : last.at + 1;
            // Same reason as above: one refusal ends the whole batch.
            // forge-lint: disable-next-line(block-timestamp, require-revert-in-loop)
            if (block.timestamp < nextAllowedAt) revert TooSoon(passportId, nextAllowedAt);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 at = uint64(block.timestamp);
        list.push(
            StoredEntry({
                at: at,
                writer: msg.sender,
                aiTraining: consent.aiTraining,
                aiGenerativeTraining: consent.aiGenerativeTraining,
                aiInference: consent.aiInference,
                dataMining: consent.dataMining
            })
        );
        if (bytes(constraintInfo).length != 0) _constraintInfo[passportId][index] = constraintInfo;

        emit ConsentSet(passportId, msg.sender, index, consent, constraintInfo, at);
    }

    /// @dev The registry reverts on a passport nobody has minted, and a burned token behaves the
    ///      same way, so both come back as address(0) and the caller is refused.
    function _holderOf(bytes32 passportId) private view returns (address holder) {
        // In a batch this runs once per passport, which is the point: authority is read fresh for
        // each one from the registry, never assumed from the one before. The call is a view on a
        // fixed contract and MAX_BATCH caps how many times it can happen in one transaction.
        // forge-lint: disable-next-line(calls-loop)
        try IERC721(REGISTRY).ownerOf(uint256(passportId)) returns (address owner_) {
            return owner_;
        } catch {
            return address(0);
        }
    }

    /// @dev One predicate over the bytes rather than a list of shapes to refuse: every byte must be
    ///      printable ASCII, 0x20 to 0x7E. That covers the control characters, the newline that
    ///      splits a log line and the raw bytes that start a UTF-8 escape. It does not judge what
    ///      the text says or where it points, so a reader that follows a link in it still owes its
    ///      own check. The length is checked first, so the loop can never run more than
    ///      MAX_INFO_BYTES times.
    function _checkConstraintInfo(Consent calldata consent, string calldata constraintInfo) private pure {
        bool constrained = consent.aiTraining == Use.Constrained || consent.aiGenerativeTraining == Use.Constrained
            || consent.aiInference == Use.Constrained || consent.dataMining == Use.Constrained;

        bytes calldata text = bytes(constraintInfo);
        if (!constrained) {
            if (text.length != 0) revert ConstraintInfoNotAllowed();
            return;
        }

        if (text.length == 0) revert ConstraintInfoRequired();
        if (text.length > MAX_INFO_BYTES) revert ConstraintInfoTooLong(text.length);
        for (uint256 i = 0; i < text.length; ++i) {
            uint8 b = uint8(text[i]);
            // Refusing on the spot is the point: the caller is told which byte is wrong.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (b < 0x20 || b > 0x7E) revert ConstraintInfoNotPrintable(i);
        }
    }

    function _read(bytes32 passportId, StoredEntry[] storage list, uint256 index)
        private
        view
        returns (Entry memory entry)
    {
        StoredEntry storage stored = list[index];
        entry = Entry({
            at: stored.at,
            writer: stored.writer,
            consent: Consent({
                aiTraining: stored.aiTraining,
                aiGenerativeTraining: stored.aiGenerativeTraining,
                aiInference: stored.aiInference,
                dataMining: stored.dataMining
            }),
            constraintInfo: _constraintInfo[passportId][index]
        });
    }
}
