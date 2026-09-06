// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @notice Builds the WebAuthn assertions a real browser would produce, so the tests exercise the
///         same code path a passkey does. Modelled on OpenZeppelin's own WebAuthn.t.sol.
/// @dev Foundry's local EVM has no P-256 precompile, so OpenZeppelin's pure Solidity fallback runs
///      here. Monad has the precompile at 0x0100, which is far cheaper but verifies the same math.
library WebAuthnFixture {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Where "challenge" starts inside the client data JSON this library builds. The JSON is
    ///      fixed, so this index is fixed too: 23 characters of type field come first.
    uint256 internal constant CHALLENGE_INDEX = 23;
    uint256 internal constant TYPE_INDEX = 1;

    /// @notice Turns a P-256 private key into the public key coordinates the registry stores.
    function publicKey(uint256 privateKey) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = VM.publicKeyP256(privateKey);
        return (bytes32(x), bytes32(y));
    }

    /// @notice Keeps a fuzzed seed inside the valid P-256 private key range.
    function boundKey(uint256 seed) internal pure returns (uint256) {
        return (seed % (P256.N - 1)) + 1;
    }

    /// @notice Builds a valid assertion over a digest, with user presence and user verification
    ///         both set, which is what the registry requires.
    function sign(uint256 privateKey, bytes32 digest) internal pure returns (WebAuthn.WebAuthnAuth memory auth) {
        return sign(privateKey, digest, WebAuthn.AUTH_DATA_FLAGS_UP | WebAuthn.AUTH_DATA_FLAGS_UV);
    }

    /// @notice Builds an assertion with a chosen set of authenticator flags, for the tests that
    ///         need a device that skipped the biometric or the touch.
    function sign(uint256 privateKey, bytes32 digest, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        return signWithChallenge(privateKey, digest, flags, abi.encodePacked(digest));
    }

    /// @notice Builds an assertion whose client data commits to a different challenge than the one
    ///         the contract will check, which is how a replay attempt looks on chain.
    function signWithChallenge(uint256 privateKey, bytes32, bytes1 flags, bytes memory challengeInJson)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authenticatorData = abi.encodePacked(bytes32(0), flags, bytes4(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(challengeInJson), '"}'
        );

        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = VM.signP256(privateKey, messageHash);

        auth = WebAuthn.WebAuthnAuth({
            r: r,
            // P256.verify rejects the high half of the curve order, so normalise s the way a
            // browser stack does before handing the signature to a contract.
            s: bytes32(Math.min(uint256(s), P256.N - uint256(s))),
            challengeIndex: CHALLENGE_INDEX,
            typeIndex: TYPE_INDEX,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    /// @notice The generator agent's ECDSA signature over the same EIP-712 digest the creator
    ///         signed with their passkey.
    function signAsAgent(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
