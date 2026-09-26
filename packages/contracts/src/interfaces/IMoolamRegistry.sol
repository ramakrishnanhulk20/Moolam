// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @notice How the image came to exist: made by an AI agent, captured by a camera, or edited from
///         another passport.
enum Kind {
    Generated,
    Captured,
    Edited
}

/// @notice The signed claim a creator submits. Every field is inside the EIP-712 digest.
///         fingerprintVersion must be at least 1, so the record names the algorithm behind phash.
struct PassportInput {
    bytes32 exactHash;
    bytes32 parentId;
    address creator;
    uint256 generatorAgentId;
    uint64 phash;
    bytes32 blockhash256;
    bytes32 manifestHash;
    Kind kind;
    uint8 fingerprintVersion;
    string metadataURI;
    uint64 deadline;
}

/// @notice The permanent record. registeredAt and disputed are set by the contract, not signed.
struct Passport {
    bytes32 exactHash;
    bytes32 parentId;
    address creator;
    uint256 generatorAgentId;
    uint64 phash;
    bytes32 blockhash256;
    bytes32 manifestHash;
    Kind kind;
    uint8 fingerprintVersion;
    uint64 registeredAt;
    bool disputed;
    string metadataURI;
}

/// @notice One verifier's recheck of a passport, written by a listed receiver.
struct Attestation {
    address receiver;
    bool matched;
    uint16 distance;
    bytes32 recomputed;
    uint64 at;
}

/// @notice Lifecycle of a challenge against a passport.
enum DisputeStatus {
    None,
    Open,
    Upheld,
    Rejected
}

/// @notice A challenge and the bond behind it.
struct Dispute {
    address challenger;
    uint256 bond;
    bytes32 evidenceHash;
    DisputeStatus status;
    uint64 openedAt;
}

/// @title IMoolamRegistry
/// @notice The outside surface of the Moolam passport registry, used by the frontend, the indexer
///         and the Chainlink workflow.
interface IMoolamRegistry {
    /// @notice The EIP-712 digest the creator's passkey and the generator agent both sign.
    /// @dev Domain "Moolam", version "1", bound to this chain and this contract.
    /// @param p The passport input, exactly as it will be submitted.
    /// @return digest The 32 bytes to sign, also the WebAuthn challenge.
    function hashPassport(PassportInput calldata p) external view returns (bytes32 digest);

    /// @notice The EIP-712 digest a passkey signs to bind itself to a wallet.
    /// @param wallet The wallet the key will be bound to.
    /// @param qx The passkey public key x coordinate.
    /// @param qy The passkey public key y coordinate.
    /// @param nonce The wallet's current bind nonce.
    /// @return digest The 32 bytes to sign.
    function hashBind(address wallet, bytes32 qx, bytes32 qy, uint256 nonce) external view returns (bytes32 digest);

    /// @notice The next bind nonce for a wallet. Each bind consumes one, so no bind can be replayed.
    /// @param wallet The wallet to read.
    function bindNonce(address wallet) external view returns (uint256);

    /// @notice Binds a passkey to the calling wallet, or rotates the one already bound.
    /// @param qx The passkey public key x coordinate.
    /// @param qy The passkey public key y coordinate.
    /// @param auth The WebAuthn assertion over hashBind(msg.sender, qx, qy, bindNonce(msg.sender)).
    function bindPasskey(bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth calldata auth) external;

    /// @notice Registers an original image and mints its passport token.
    /// @param p The input. parentId zero, kind not Edited, fingerprintVersion not zero.
    /// @param creatorAuth The creator's WebAuthn assertion over hashPassport(p).
    /// @param generatorSig The agent owner's ECDSA signature over the same digest, empty for Captured.
    /// @return tokenId uint256(p.exactHash).
    function register(PassportInput calldata p, WebAuthn.WebAuthnAuth calldata creatorAuth, bytes calldata generatorSig)
        external
        returns (uint256 tokenId);

    /// @notice Records an edit of an existing passport and mints the child token. Only the parent's
    ///         owner may call it: an ERC-721 approval moves the token, it does not write history.
    /// @param p The input. parentId must exist, kind Edited, fingerprintVersion not zero.
    /// @param generatorSig The agent owner's ECDSA signature, or empty when no agent touched the edit.
    /// @return tokenId uint256(p.exactHash).
    function appendEdit(PassportInput calldata p, bytes calldata generatorSig) external returns (uint256 tokenId);

    /// @notice Writes one verifier's recheck of a passport.
    /// @param passportId The passport being rechecked.
    /// @param matched Whether the recomputed fingerprint matched the recorded one.
    /// @param distance The perceptual hash distance measured.
    /// @param recomputed The fingerprint the verifier computed.
    function attest(bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed) external;

    /// @notice Opens a bonded dispute against a passport. One already upheld cannot be flagged again.
    /// @param passportId The passport being challenged.
    /// @param evidenceURI Where the evidence lives. Only its keccak256 hash is stored.
    function flag(bytes32 passportId, string calldata evidenceURI) external payable;

    /// @notice Settles an open dispute.
    /// @param passportId The disputed passport.
    /// @param upheld True returns the bond to the challenger and marks the passport disputed.
    ///        False sends the bond to the treasury.
    function resolve(bytes32 passportId, bool upheld) external;

    /// @notice Pulls whatever the caller is owed. Works even while paused.
    function withdraw() external;

    /// @notice Pulls whatever the caller is owed to another address, for a contract that cannot
    ///         receive native token itself.
    /// @param to Where the money goes.
    function withdrawTo(address to) external;

    /// @notice Stops new registrations, edits and flags.
    function pause() external;

    /// @notice Lets registrations, edits and flags run again.
    function unpause() external;

    /// @notice Moves ERC-20 tokens sent here by mistake.
    /// @param token The ERC-20 to move.
    /// @param to Where to send it.
    /// @param amount How much to send.
    function rescueERC20(address token, address to, uint256 amount) external;

    /// @notice Moves native token that is not backing a bond or an unclaimed credit.
    /// @param to Where to send it.
    function rescueNative(address to) external;

    /// @notice Reads a whole passport record, zeroed if it does not exist.
    /// @param id The passport id, the sha256 of the exact image bytes.
    function getPassport(bytes32 id) external view returns (Passport memory);

    /// @notice Whether a passport has been registered.
    /// @param id The passport id.
    function passportExists(bytes32 id) external view returns (bool);

    /// @notice Reads the passkey bound to a wallet, zero when nothing is bound.
    /// @param wallet The wallet to read.
    /// @return qx The public key x coordinate.
    /// @return qy The public key y coordinate.
    function getPasskey(address wallet) external view returns (bytes32 qx, bytes32 qy);

    /// @notice How many attestations a passport has collected, never more than 64.
    /// @param id The passport id.
    function attestationCount(bytes32 id) external view returns (uint256);

    /// @notice Reads a page of a passport's attestations, oldest first.
    /// @param id The passport id.
    /// @param offset Where to start.
    /// @param limit How many to read at most, clipped to what exists.
    function getAttestations(bytes32 id, uint256 offset, uint256 limit) external view returns (Attestation[] memory);

    /// @notice How many edits descend directly from a passport.
    /// @param id The parent passport id.
    function childCount(bytes32 id) external view returns (uint256);

    /// @notice Reads a page of a passport's direct children, oldest first.
    /// @param id The parent passport id.
    /// @param offset Where to start.
    /// @param limit How many to read at most, clipped to what exists.
    function getChildren(bytes32 id, uint256 offset, uint256 limit) external view returns (bytes32[] memory);

    /// @notice Reads the dispute record for a passport. Status None means never challenged.
    /// @param id The passport id.
    function getDispute(bytes32 id) external view returns (Dispute memory);

    /// @notice How much native token, in wei, an address can pull with withdraw.
    /// @param who The address to read.
    function withdrawable(address who) external view returns (uint256);

    /// @notice The policy contract that lists receivers and holds the dispute settings.
    function policy() external view returns (address);

    /// @notice The ERC-8004 identity registry this contract reads agent ownership from.
    function agentIdentity() external view returns (address);
}
