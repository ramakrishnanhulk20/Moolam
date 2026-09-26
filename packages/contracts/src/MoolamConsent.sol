// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IMoolamConsent} from "./interfaces/IMoolamConsent.sol";

/// @title MoolamConsent
/// @notice Where a creator states whether their picture may be used to train AI, with every past
///         statement kept by date, so anyone can show what was allowed on a given day.
/// @dev The only authority is the registry's current passport holder, read in the same call. No
///      owner, no pause, no upgrade and no money. No reentrancy guard: the one external call is
///      ownerOf, a static call to a fixed contract.
contract MoolamConsent is IMoolamConsent {
    /// @dev Packed into one storage slot.
    struct StoredEntry {
        uint64 at;
        address writer;
        Use aiTraining;
        Use aiGenerativeTraining;
        Use aiInference;
        Use dataMining;
    }

    /// @notice The vocabulary of this register: the CAWG Training and Data Mining assertion, v1.1.
    /// @dev Unspecified is this contract's own fourth value. A reader who cannot reach the creator
    ///      treats Constrained as NotAllowed, per the standard.
    string public constant STANDARD = "cawg.training-mining/1.1";

    /// @notice The passport registry this contract asks who holds a passport.
    address public immutable REGISTRY;

    /// @notice How long the same address must wait before changing the same passport again.
    /// @dev Bounds what one holder costs a fee sponsor. Not applied to a new holder, so a seller
    ///      cannot lock the buyer out.
    uint64 public constant MIN_INTERVAL = 600;

    /// @notice The longest the constraint text may be. Fits a licence name or a policy link.
    uint256 public constant MAX_INFO_BYTES = 256;

    /// @notice The most history entries one read can return.
    uint256 public constant MAX_PAGE = 64;

    /// @notice The most passports one batch call can state for.
    /// @dev The worst batch of 32 measures 8,144,656 gas, about a quarter of Monad's 30,000,000
    ///      per transaction limit.
    uint256 public constant MAX_BATCH = 32;

    mapping(bytes32 passportId => StoredEntry[] history) private _history;
    mapping(bytes32 passportId => mapping(uint256 index => string text)) private _constraintInfo;

    error ZeroAddress();
    error NotAContract();

    /// @notice Deploys the register and locks in the passport registry it trusts.
    /// @dev A registry with no code would make every passport look unheld, so it is refused here.
    /// @param registry The Moolam passport registry, an ERC-721.
    constructor(address registry) {
        if (registry == address(0)) revert ZeroAddress();
        if (registry.code.length == 0) revert NotAContract();
        REGISTRY = registry;
    }

    /// @inheritdoc IMoolamConsent
    /// @dev Only the holder may write. An ERC-721 approval or operator lets a marketplace move the
    ///      token, never speak for the creator.
    function setConsent(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) external {
        _checkConstraintInfo(consent, constraintInfo);
        _record(passportId, consent, constraintInfo);
    }

    /// @inheritdoc IMoolamConsent
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
    /// @dev Binary search, exact because timestamps in one history strictly increase.
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

    /// @dev The caller has already checked the text.
    function _record(bytes32 passportId, Consent calldata consent, string calldata constraintInfo) private {
        address holder = _holderOf(passportId);
        // Reverting inside the batch loop is what makes a batch all or nothing.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (holder == address(0) || msg.sender != holder) revert NotPassportHolder(passportId, msg.sender);

        StoredEntry[] storage list = _history[passportId];
        uint256 index = list.length;
        if (index != 0) {
            StoredEntry storage last = list[index - 1];
            // A new holder waits only for the clock to move, which keeps timestamps strictly
            // increasing and refuses a passport named twice in one batch.
            uint64 nextAllowedAt = last.writer == msg.sender ? last.at + MIN_INTERVAL : last.at + 1;
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

    /// @dev An unminted or burned passport comes back as address(0), so the caller is refused.
    function _holderOf(bytes32 passportId) private view returns (address holder) {
        // Authority is read fresh for every passport in a batch, never assumed from the one before.
        // forge-lint: disable-next-line(calls-loop)
        try IERC721(REGISTRY).ownerOf(uint256(passportId)) returns (address owner_) {
            return owner_;
        } catch {
            return address(0);
        }
    }

    /// @dev Every byte must be printable ASCII, which rules out control characters, newlines and
    ///      UTF-8 escapes. It does not judge what a link in the text points to.
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
