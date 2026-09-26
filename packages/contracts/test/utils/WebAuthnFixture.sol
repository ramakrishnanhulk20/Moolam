// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @notice Builds the WebAuthn assertions a real browser would produce, modelled on OpenZeppelin's
///         own WebAuthn.t.sol. Foundry answers the P-256 precompile at 0x0100 itself.
library WebAuthnFixture {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Fixed because the client data JSON below is fixed.
    uint256 internal constant CHALLENGE_INDEX = 23;
    uint256 internal constant TYPE_INDEX = 1;

    function publicKey(uint256 privateKey) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = VM.publicKeyP256(privateKey);
        return (bytes32(x), bytes32(y));
    }

    function boundKey(uint256 seed) internal pure returns (uint256) {
        return (seed % (P256.N - 1)) + 1;
    }

    /// @notice A valid assertion with user presence and user verification set, as the registry requires.
    function sign(uint256 privateKey, bytes32 digest) internal pure returns (WebAuthn.WebAuthnAuth memory auth) {
        return sign(privateKey, digest, WebAuthn.AUTH_DATA_FLAGS_UP | WebAuthn.AUTH_DATA_FLAGS_UV);
    }

    function sign(uint256 privateKey, bytes32 digest, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        return signWithChallenge(privateKey, digest, flags, abi.encodePacked(digest));
    }

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
            // P256.verify rejects a high s, so normalise it the way a browser stack does.
            s: bytes32(Math.min(uint256(s), P256.N - uint256(s))),
            challengeIndex: CHALLENGE_INDEX,
            typeIndex: TYPE_INDEX,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    function signAsAgent(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
