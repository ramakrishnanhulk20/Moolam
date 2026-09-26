// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IVerifierPolicy
/// @notice What the registry reads before it trusts an attestation or accepts a dispute. Kept
///         apart so the registry stays immutable while these settings move.
interface IVerifierPolicy {
    /// @notice Whether an address is a listed receiver, allowed to write attestations.
    /// @param who The address that called `attest` on the registry.
    function isReceiver(address who) external view returns (bool);

    /// @notice The only address allowed to resolve a dispute on the registry.
    function resolver() external view returns (address);

    /// @notice Where a rejected challenger's bond goes.
    function treasury() external view returns (address);

    /// @notice The exact bond, in wei, a challenger must send with `flag`.
    function disputeBond() external view returns (uint256);
}
