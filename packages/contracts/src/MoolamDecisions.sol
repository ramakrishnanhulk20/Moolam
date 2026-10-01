// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMoolamRegistry, Dispute, DisputeStatus} from "./interfaces/IMoolamRegistry.sol";
import {IVerifierPolicy} from "./interfaces/IVerifierPolicy.sol";

/// @title MoolamDecisions
/// @notice Where Moolam's resolver publishes the reasons for a challenge decision, bound to that
///         decision. The registry cannot carry a reasons address on `resolve` and cannot change, so the
///         reasons travel here, readable on the explorer next to the resolution they explain.
/// @dev Holds no money and only reads the registry and the policy. Every rule is read from the chain
///      at call time: who the resolver is, and whether the dispute is settled and how.
///      Does not defend against: the resolver's key writing wrong reasons; the content behind the
///      address (the index fetches it by the pinned-content rule); a challenger re-flagging a rejected
///      passport before the reasons are published, which replaces the dispute record this contract
///      reads, so the earlier decision's reasons can no longer be published here.
contract MoolamDecisions {
    /// @notice The most bytes a reasons address may have, prefix included.
    uint256 public constant MAX_REASONS_URI_LENGTH = 128;

    /// @notice The fewest letters and digits after the prefix: a version 0 CID is 46 characters,
    ///         and every later CID form is longer.
    uint256 public constant MIN_CID_LENGTH = 46;

    bytes private constant IPFS_PREFIX = "ipfs://";

    /// @notice The registry whose disputes this contract explains.
    IMoolamRegistry public immutable REGISTRY;

    /// @notice The policy that names the resolver.
    IVerifierPolicy public immutable POLICY;

    /// @notice Whether the reasons for one dispute, named by its passport and openedAt, are published.
    mapping(bytes32 passportId => mapping(uint64 openedAt => bool done)) public published;

    /// @notice The resolver published the reasons for a settled dispute.
    /// @param passportId The disputed passport.
    /// @param openedAt When the dispute was opened, which names it among the passport's disputes.
    /// @param upheld True when the challenge stood.
    /// @param reasonsURI Where the reasons document lives, always ipfs:// and a content id.
    /// @param resolver The resolver that published them.
    event DecisionPublished(
        bytes32 indexed passportId, uint64 indexed openedAt, bool upheld, string reasonsURI, address resolver
    );

    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice The registry reads its rules from a different policy than the one given.
    error PolicyMismatch(address registryPolicy, address given);
    /// @notice Only the policy's resolver may publish.
    error NotResolver(address caller);
    /// @notice The passport's dispute is not settled: never opened, or still open.
    error DisputeNotResolved(bytes32 passportId, DisputeStatus status);
    /// @notice The reasons address is not ipfs:// followed by a content id of letters and digits,
    ///         or is longer than MAX_REASONS_URI_LENGTH.
    error InvalidReasonsURI();
    /// @notice The reasons for this dispute are already published.
    error AlreadyPublished(bytes32 passportId, uint64 openedAt);

    /// @notice Deploys the contract, bound for good to one registry and its policy.
    /// @dev Reverts ZeroAddress, or PolicyMismatch when the registry trusts a different policy.
    /// @param registry The Moolam registry.
    /// @param policy The VerifierPolicy the registry reads its resolver from.
    constructor(address registry, address policy) {
        if (registry == address(0) || policy == address(0)) revert ZeroAddress();
        address registryPolicy = IMoolamRegistry(registry).policy();
        if (registryPolicy != policy) revert PolicyMismatch(registryPolicy, policy);
        REGISTRY = IMoolamRegistry(registry);
        POLICY = IVerifierPolicy(policy);
    }

    /// @notice Publishes the reasons for a settled dispute, once per dispute.
    /// @dev The resolver is read from the policy at call time, and the outcome and dispute identity from
    ///      the registry, so neither can be supplied by the caller. Reverts NotResolver,
    ///      DisputeNotResolved, InvalidReasonsURI or AlreadyPublished. Emits DecisionPublished.
    /// @param passportId The disputed passport.
    /// @param reasonsURI ipfs:// followed by the content id of the reasons document, at most 128 bytes.
    function publish(bytes32 passportId, string calldata reasonsURI) external {
        address resolver = POLICY.resolver();
        if (msg.sender != resolver) revert NotResolver(msg.sender);

        Dispute memory dispute = REGISTRY.getDispute(passportId);
        if (dispute.status != DisputeStatus.Upheld && dispute.status != DisputeStatus.Rejected) {
            revert DisputeNotResolved(passportId, dispute.status);
        }

        if (!_isPinnedAddress(bytes(reasonsURI))) revert InvalidReasonsURI();

        uint64 openedAt = dispute.openedAt;
        if (published[passportId][openedAt]) revert AlreadyPublished(passportId, openedAt);
        published[passportId][openedAt] = true;

        emit DecisionPublished(passportId, openedAt, dispute.status == DisputeStatus.Upheld, reasonsURI, msg.sender);
    }

    /// @dev The same shape as the workflow's pinned-content rule, ipfs:// then letters and digits only,
    ///      plus a length floor and ceiling. The loop is bounded by MAX_REASONS_URI_LENGTH.
    function _isPinnedAddress(bytes calldata uri) private pure returns (bool) {
        uint256 prefixLength = IPFS_PREFIX.length;
        if (uri.length > MAX_REASONS_URI_LENGTH || uri.length < prefixLength + MIN_CID_LENGTH) return false;

        for (uint256 i = 0; i < prefixLength; ++i) {
            if (uri[i] != IPFS_PREFIX[i]) return false;
        }

        for (uint256 i = prefixLength; i < uri.length; ++i) {
            bytes1 c = uri[i];
            bool isDigit = c >= "0" && c <= "9";
            bool isUpper = c >= "A" && c <= "Z";
            bool isLower = c >= "a" && c <= "z";
            if (!isDigit && !isUpper && !isLower) return false;
        }
        return true;
    }
}
