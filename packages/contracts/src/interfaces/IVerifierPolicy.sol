// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IVerifierPolicy
/// @notice The small governance surface the registry reads before it trusts an attestation
///         or accepts a dispute. Kept separate from the registry so the registry itself can
///         stay immutable while the set of verifier receivers and the dispute parameters move.
interface IVerifierPolicy {
    /// @notice Tells the registry whether an address is allowed to write attestations.
    /// @param who The address that called `attest` on the registry.
    /// @return True when `who` is a listed receiver.
    function isReceiver(address who) external view returns (bool);

    /// @notice The only address allowed to resolve a dispute on the registry.
    /// @return The current resolver address.
    function resolver() external view returns (address);

    /// @notice Where a rejected challenger's bond goes.
    /// @return The current treasury address.
    function treasury() external view returns (address);

    /// @notice The exact amount of native token a challenger must send with `flag`.
    /// @return The bond in wei.
    function disputeBond() external view returns (uint256);
}
