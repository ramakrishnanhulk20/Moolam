// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title MoolamReceiver
/// @notice The one door a Chainlink CRE workflow uses to write a verification result into the
///         Moolam registry. The workflow refetches the image, recomputes its fingerprint, and the
///         Chainlink nodes agree on the answer before any of it reaches this contract.
/// @dev Inherits Chainlink's ReceiverTemplate unchanged, so the forwarder check and the optional
///      workflow id, owner and name checks are theirs, not ours. The registry then checks this
///      contract against the VerifierPolicy list, which means a swap of the forwarder address by
///      this contract's owner still cannot forge an attestation the policy has not allowed.
contract MoolamReceiver is ReceiverTemplate {
    /// @notice The registry this receiver writes into.
    IMoolamRegistry public immutable REGISTRY;

    error ZeroAddress();

    /// @notice Deploys the receiver and locks it to one registry.
    /// @param forwarder The Chainlink KeystoneForwarder that is allowed to call onReport.
    /// @param registry The Moolam registry that will receive the attestations.
    constructor(address forwarder, address registry) ReceiverTemplate(forwarder) {
        if (registry == address(0)) revert ZeroAddress();
        REGISTRY = IMoolamRegistry(registry);
    }

    /// @dev Decodes one verification result and records it. Reverting here is safe: Chainlink
    ///      retries a failed report with a higher gas limit, and the registry rejects an unknown
    ///      passport id rather than storing a result for something that does not exist.
    function _processReport(bytes calldata report) internal override {
        (bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed) =
            abi.decode(report, (bytes32, bool, uint16, bytes32));

        REGISTRY.attest(passportId, matched, distance, recomputed);
    }
}
