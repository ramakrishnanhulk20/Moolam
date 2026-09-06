// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {
    IMoolamRegistry,
    Kind,
    PassportInput,
    Passport,
    Attestation,
    Dispute,
    DisputeStatus
} from "./interfaces/IMoolamRegistry.sol";
import {IVerifierPolicy} from "./interfaces/IVerifierPolicy.sol";

/// @title MoolamRegistry
/// @notice The permanent record of where an image came from. A creator signs the image
///         fingerprint with the passkey on their own device, the AI agent that generated it signs
///         the same fingerprint with the wallet that owns its ERC-8004 identity, and this contract
///         only writes the record when both signatures check out on chain.
/// @dev Immutable on purpose. The only moving part is the VerifierPolicy address handed in at
///      deployment, so nobody, including the owner, can rewrite a passport after the fact.
///      Passkey checks run through OpenZeppelin WebAuthn, which uses the P-256 precompile at
///      0x0100 on Monad and falls back to pure Solidity anywhere the precompile is missing.
contract MoolamRegistry is IMoolamRegistry, ERC721, EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Passkey {
        bytes32 qx;
        bytes32 qy;
    }

    /// @notice The most attestations one passport can ever hold.
    /// @dev The cap bounds storage growth per passport and keeps a full getAttestations read
    ///      well inside one block. 64 records is roughly 6,000 gas of returned data, three orders
    ///      of magnitude under the 150M gas Monad block limit, so a whole page always fits.
    uint256 public constant MAX_ATTESTATIONS = 64;

    bytes32 private constant PASSPORT_TYPEHASH = keccak256(
        "Passport(bytes32 exactHash,bytes32 parentId,address creator,uint256 generatorAgentId,uint64 phash,bytes32 blockhash256,bytes32 manifestHash,uint8 kind,uint8 fingerprintVersion,string metadataURI,uint64 deadline)"
    );

    bytes32 private constant BIND_TYPEHASH = keccak256("Bind(address wallet,bytes32 qx,bytes32 qy,uint256 nonce)");

    address private immutable _POLICY;
    address private immutable _AGENT_IDENTITY;

    /// @notice Native token currently locked behind open disputes.
    uint256 public totalBonds;
    /// @notice Native token credited to addresses that have not pulled it yet.
    uint256 public totalOwed;

    mapping(bytes32 passportId => Passport record) private _passports;
    mapping(bytes32 passportId => Attestation[] list) private _attestations;
    mapping(bytes32 parentId => bytes32[] children) private _children;
    mapping(bytes32 passportId => Dispute record) private _disputes;
    mapping(address wallet => Passkey key) private _passkeys;
    mapping(address wallet => uint256 nonce) private _bindNonces;
    mapping(address who => uint256 amount) private _withdrawable;

    event PasskeyBound(address indexed wallet, bytes32 qx, bytes32 qy, uint256 nonce);
    event PassportRegistered(
        bytes32 indexed passportId,
        address indexed creator,
        uint256 indexed generatorAgentId,
        bytes32 parentId,
        uint64 phash,
        bytes32 blockhash256,
        bytes32 manifestHash,
        uint8 kind,
        uint8 fingerprintVersion,
        string metadataURI
    );
    event VerificationAttested(
        bytes32 indexed passportId, address indexed receiver, bool matched, uint16 distance, bytes32 recomputed
    );
    event PassportFlagged(
        bytes32 indexed passportId, address indexed challenger, uint256 bond, bytes32 evidenceHash, string evidenceURI
    );
    event DisputeResolved(bytes32 indexed passportId, bool upheld, address indexed resolver);
    event Withdrawn(address indexed who, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    error InvalidExactHash();
    error PassportAlreadyExists(bytes32 passportId);
    error ParentNotAllowed();
    error InvalidParent();
    error ParentNotFound(bytes32 parentId);
    error NotParentOwner(address caller);
    error InvalidCreator();
    error InvalidKind();
    error EmptyMetadataURI();
    error SignatureExpired(uint64 deadline);
    error InvalidPublicKey();
    error PasskeyNotBound(address wallet);
    error InvalidPasskeySignature();
    error InvalidAgentId();
    error UnknownAgent(uint256 agentId);
    error InvalidGeneratorSignature();
    error NotReceiver(address caller);
    error PassportNotFound(bytes32 passportId);
    error AttestationCapReached(bytes32 passportId);
    error DisputeAlreadyOpen(bytes32 passportId);
    error InvalidBond(uint256 sent, uint256 required);
    error NotResolver(address caller);
    error NoOpenDispute(bytes32 passportId);
    error NothingToWithdraw();
    error NothingToRescue();
    error TransferFailed();

    /// @notice Deploys the registry and locks in the two addresses it trusts.
    /// @param initialOwner Owner of pause and rescue only. Two step transfer, and the owner can
    ///        never touch a passport record or a user balance.
    /// @param policyAddress The VerifierPolicy that lists receivers and holds dispute settings.
    /// @param agentIdentityAddress The ERC-8004 Identity Registry, an ERC-721 whose owner of an
    ///        agent id is the wallet that must sign for that agent.
    constructor(address initialOwner, address policyAddress, address agentIdentityAddress)
        ERC721("Moolam Content Passport", "MOOLAM")
        EIP712("Moolam", "1")
        Ownable(initialOwner)
    {
        if (policyAddress == address(0) || agentIdentityAddress == address(0)) revert ZeroAddress();
        // ownerOf is read through try/catch, and a call to an address with no code would return
        // empty data that cannot be decoded, so refuse to deploy against a plain wallet.
        if (agentIdentityAddress.code.length == 0) revert NotAContract();
        _POLICY = policyAddress;
        _AGENT_IDENTITY = agentIdentityAddress;
    }

    /// @inheritdoc IMoolamRegistry
    function hashPassport(PassportInput calldata p) public view returns (bytes32 digest) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PASSPORT_TYPEHASH,
                    p.exactHash,
                    p.parentId,
                    p.creator,
                    p.generatorAgentId,
                    p.phash,
                    p.blockhash256,
                    p.manifestHash,
                    uint8(p.kind),
                    p.fingerprintVersion,
                    keccak256(bytes(p.metadataURI)),
                    p.deadline
                )
            )
        );
    }

    /// @inheritdoc IMoolamRegistry
    function hashBind(address wallet, bytes32 qx, bytes32 qy, uint256 nonce) public view returns (bytes32 digest) {
        return _hashTypedDataV4(keccak256(abi.encode(BIND_TYPEHASH, wallet, qx, qy, nonce)));
    }

    /// @inheritdoc IMoolamRegistry
    function bindNonce(address wallet) external view returns (uint256) {
        return _bindNonces[wallet];
    }

    /// @notice Binds a passkey to the calling wallet, or rotates the one already bound.
    /// @dev The wallet proves it holds the key by signing the bind digest with it, so a stolen
    ///      public key cannot be parked on someone else's wallet. Requires user presence and user
    ///      verification, meaning a live touch plus a biometric or PIN on the device.
    ///      Reverts InvalidPublicKey on a zero coordinate and InvalidPasskeySignature when the
    ///      assertion does not check out. Emits PasskeyBound.
    /// @param qx The passkey public key x coordinate.
    /// @param qy The passkey public key y coordinate.
    /// @param auth The WebAuthn assertion over hashBind(msg.sender, qx, qy, bindNonce(msg.sender)).
    function bindPasskey(bytes32 qx, bytes32 qy, WebAuthn.WebAuthnAuth calldata auth) external {
        if (qx == bytes32(0) || qy == bytes32(0)) revert InvalidPublicKey();

        uint256 nonce = _bindNonces[msg.sender];
        bytes32 digest = hashBind(msg.sender, qx, qy, nonce);
        if (!WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy, true)) revert InvalidPasskeySignature();

        _bindNonces[msg.sender] = nonce + 1;
        _passkeys[msg.sender] = Passkey({qx: qx, qy: qy});

        emit PasskeyBound(msg.sender, qx, qy, nonce);
    }

    /// @notice Registers an original image and mints its passport token to the creator.
    /// @dev Anyone may send this transaction. Authority comes from the two signatures, not from
    ///      msg.sender, which is what lets a relayer pay the gas for a creator.
    ///      Reverts InvalidExactHash on a zero hash, PassportAlreadyExists on a repeat,
    ///      ParentNotAllowed when parentId is set, InvalidCreator on a zero creator, InvalidKind
    ///      when kind is Edited, EmptyMetadataURI on an empty URI, SignatureExpired past the
    ///      deadline, PasskeyNotBound when the creator has no key, InvalidPasskeySignature,
    ///      InvalidAgentId, UnknownAgent, InvalidGeneratorSignature. Emits PassportRegistered.
    /// @param p The passport input.
    /// @param creatorAuth The creator's WebAuthn assertion over hashPassport(p).
    /// @param generatorSig The agent owner's ECDSA signature over the same digest, empty for
    ///        a Captured image.
    /// @return tokenId The minted token id, equal to uint256(p.exactHash).
    function register(PassportInput calldata p, WebAuthn.WebAuthnAuth calldata creatorAuth, bytes calldata generatorSig)
        external
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (p.exactHash == bytes32(0)) revert InvalidExactHash();
        if (_passports[p.exactHash].registeredAt != 0) revert PassportAlreadyExists(p.exactHash);
        if (p.parentId != bytes32(0)) revert ParentNotAllowed();
        if (p.creator == address(0)) revert InvalidCreator();
        if (p.kind == Kind.Edited) revert InvalidKind();
        if (bytes(p.metadataURI).length == 0) revert EmptyMetadataURI();
        if (p.deadline < block.timestamp) revert SignatureExpired(p.deadline);

        Passkey memory key = _passkeys[p.creator];
        if (key.qx == bytes32(0) && key.qy == bytes32(0)) revert PasskeyNotBound(p.creator);

        bytes32 digest = hashPassport(p);
        if (!WebAuthn.verify(abi.encodePacked(digest), creatorAuth, key.qx, key.qy, true)) {
            revert InvalidPasskeySignature();
        }

        _checkGenerator(p.kind == Kind.Generated, p.generatorAgentId, digest, generatorSig);

        return _write(p, p.creator);
    }

    /// @notice Records an edit of an existing passport and mints the child token.
    /// @dev No passkey signature here. Holding the parent token, or being approved for it, is the
    ///      authority, which is what lets an editing session sign many edits without a fresh
    ///      biometric prompt each time.
    ///      Reverts InvalidParent on a zero parent, ParentNotFound when the parent is unknown,
    ///      NotParentOwner when the caller does not control the parent, InvalidCreator when the
    ///      creator field is not the parent owner, InvalidKind when kind is not Edited,
    ///      InvalidExactHash, PassportAlreadyExists, EmptyMetadataURI, SignatureExpired,
    ///      InvalidGeneratorSignature, UnknownAgent. Emits PassportRegistered.
    /// @param p The passport input with parentId set and kind Edited.
    /// @param generatorSig The agent owner's ECDSA signature, empty when generatorAgentId is zero.
    /// @return tokenId The minted token id, equal to uint256(p.exactHash).
    function appendEdit(PassportInput calldata p, bytes calldata generatorSig)
        external
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (p.parentId == bytes32(0)) revert InvalidParent();
        if (_passports[p.parentId].registeredAt == 0) revert ParentNotFound(p.parentId);
        if (p.exactHash == bytes32(0)) revert InvalidExactHash();
        if (_passports[p.exactHash].registeredAt != 0) revert PassportAlreadyExists(p.exactHash);
        if (p.kind != Kind.Edited) revert InvalidKind();
        if (bytes(p.metadataURI).length == 0) revert EmptyMetadataURI();
        if (p.deadline < block.timestamp) revert SignatureExpired(p.deadline);

        uint256 parentTokenId = uint256(p.parentId);
        address parentOwner = ownerOf(parentTokenId);
        if (
            msg.sender != parentOwner && !isApprovedForAll(parentOwner, msg.sender)
                && getApproved(parentTokenId) != msg.sender
        ) {
            revert NotParentOwner(msg.sender);
        }
        if (p.creator != parentOwner) revert InvalidCreator();

        _checkGenerator(p.generatorAgentId != 0, p.generatorAgentId, hashPassport(p), generatorSig);

        _children[p.parentId].push(p.exactHash);
        return _write(p, parentOwner);
    }

    /// @notice Writes one verifier's recheck of a passport.
    /// @dev Only an address the policy lists may call this, which in practice is the
    ///      MoolamReceiver that the Chainlink forwarder talks to. Stays open while paused so a
    ///      verification already in flight can still land.
    ///      Reverts NotReceiver, PassportNotFound, AttestationCapReached. Emits
    ///      VerificationAttested.
    /// @param passportId The passport being rechecked.
    /// @param matched Whether the recomputed fingerprint matched the recorded one.
    /// @param distance The perceptual hash distance measured.
    /// @param recomputed The fingerprint the verifier computed.
    function attest(bytes32 passportId, bool matched, uint16 distance, bytes32 recomputed) external {
        if (!IVerifierPolicy(_POLICY).isReceiver(msg.sender)) revert NotReceiver(msg.sender);
        if (_passports[passportId].registeredAt == 0) revert PassportNotFound(passportId);

        Attestation[] storage list = _attestations[passportId];
        if (list.length >= MAX_ATTESTATIONS) revert AttestationCapReached(passportId);

        list.push(
            Attestation({
                receiver: msg.sender,
                matched: matched,
                distance: distance,
                recomputed: recomputed,
                at: uint64(block.timestamp)
            })
        );

        emit VerificationAttested(passportId, msg.sender, matched, distance, recomputed);
    }

    /// @notice Opens a dispute against a passport, backed by a bond.
    /// @dev The bond is held by this contract and never sent anywhere until resolve runs, so a
    ///      flag costs the challenger nothing but the gas if they turn out to be right.
    ///      Reverts PassportNotFound, DisputeAlreadyOpen, InvalidBond. Emits PassportFlagged.
    /// @param passportId The passport being challenged.
    /// @param evidenceURI Where the evidence lives. Only its keccak256 hash is stored.
    function flag(bytes32 passportId, string calldata evidenceURI) external payable whenNotPaused nonReentrant {
        if (_passports[passportId].registeredAt == 0) revert PassportNotFound(passportId);

        Dispute storage dispute = _disputes[passportId];
        if (dispute.status == DisputeStatus.Open) revert DisputeAlreadyOpen(passportId);

        uint256 required = IVerifierPolicy(_POLICY).disputeBond();
        if (msg.value != required) revert InvalidBond(msg.value, required);

        bytes32 evidenceHash = keccak256(bytes(evidenceURI));
        _disputes[passportId] = Dispute({
            challenger: msg.sender,
            bond: msg.value,
            evidenceHash: evidenceHash,
            status: DisputeStatus.Open,
            openedAt: uint64(block.timestamp)
        });
        totalBonds += msg.value;

        emit PassportFlagged(passportId, msg.sender, msg.value, evidenceHash, evidenceURI);
    }

    /// @notice Settles an open dispute.
    /// @dev Credits are recorded, never pushed, so a resolver can never be blocked by a
    ///      challenger or treasury that refuses native token.
    ///      Reverts NotResolver, NoOpenDispute. Emits DisputeResolved.
    /// @param passportId The disputed passport.
    /// @param upheld True marks the passport disputed and credits the bond back to the
    ///        challenger. False credits the bond to the treasury.
    function resolve(bytes32 passportId, bool upheld) external nonReentrant {
        address resolverAddress = IVerifierPolicy(_POLICY).resolver();
        if (msg.sender != resolverAddress) revert NotResolver(msg.sender);

        Dispute storage dispute = _disputes[passportId];
        if (dispute.status != DisputeStatus.Open) revert NoOpenDispute(passportId);

        uint256 bond = dispute.bond;
        address creditTo;
        if (upheld) {
            dispute.status = DisputeStatus.Upheld;
            _passports[passportId].disputed = true;
            creditTo = dispute.challenger;
        } else {
            dispute.status = DisputeStatus.Rejected;
            creditTo = IVerifierPolicy(_POLICY).treasury();
        }

        totalBonds -= bond;
        totalOwed += bond;
        _withdrawable[creditTo] += bond;

        emit DisputeResolved(passportId, upheld, resolverAddress);
    }

    /// @notice Pulls whatever the caller is owed.
    /// @dev Pull pattern, guarded, and the balance is zeroed before the transfer. Stays open
    ///      while paused so a pause can never trap someone's money.
    ///      Reverts NothingToWithdraw on a zero balance and TransferFailed if the send fails.
    ///      Emits Withdrawn.
    function withdraw() external nonReentrant {
        uint256 amount = _withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        _withdrawable[msg.sender] = 0;
        totalOwed -= amount;

        emit Withdrawn(msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Stops new registrations, edits and flags.
    /// @dev Attestations and withdrawals keep working. Emits Paused.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Lets registrations, edits and flags run again.
    /// @dev Emits Unpaused.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Moves ERC-20 tokens that were sent here by mistake.
    /// @dev This contract never holds ERC-20 for a user, so there is no user balance to touch.
    ///      Reverts ZeroAddress. Emits Rescued.
    /// @param token The ERC-20 to move.
    /// @param to Where to send it.
    /// @param amount How much to send.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit Rescued(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Moves native token that is not backing a bond or an unclaimed credit.
    /// @dev The amount is the balance minus every liability, so an open bond and an unclaimed
    ///      credit can never be swept by the owner.
    ///      Reverts ZeroAddress, NothingToRescue, TransferFailed. Emits Rescued.
    /// @param to Where to send the surplus.
    function rescueNative(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        uint256 amount = address(this).balance - totalBonds - totalOwed;
        if (amount == 0) revert NothingToRescue();

        emit Rescued(address(0), to, amount);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @inheritdoc IMoolamRegistry
    function getPassport(bytes32 id) external view returns (Passport memory) {
        return _passports[id];
    }

    /// @inheritdoc IMoolamRegistry
    function passportExists(bytes32 id) external view returns (bool) {
        return _passports[id].registeredAt != 0;
    }

    /// @inheritdoc IMoolamRegistry
    function getPasskey(address wallet) external view returns (bytes32 qx, bytes32 qy) {
        Passkey memory key = _passkeys[wallet];
        return (key.qx, key.qy);
    }

    /// @inheritdoc IMoolamRegistry
    function attestationCount(bytes32 id) external view returns (uint256) {
        return _attestations[id].length;
    }

    /// @notice Reads a page of a passport's attestations.
    /// @dev Read only, so the loop costs an off-chain caller nothing and no on-chain function
    ///      ever walks this array. The list is capped at MAX_ATTESTATIONS anyway.
    /// @param id The passport id.
    /// @param offset Where to start.
    /// @param limit How many to read at most. The page is clipped to what exists.
    /// @return page Attestations, oldest first.
    function getAttestations(bytes32 id, uint256 offset, uint256 limit)
        external
        view
        returns (Attestation[] memory page)
    {
        Attestation[] storage list = _attestations[id];
        (uint256 start, uint256 count) = _pageBounds(list.length, offset, limit);
        page = new Attestation[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = list[start + i];
        }
    }

    /// @inheritdoc IMoolamRegistry
    function childCount(bytes32 id) external view returns (uint256) {
        return _children[id].length;
    }

    /// @notice Reads a page of a passport's direct children.
    /// @dev Read only, same reasoning as getAttestations. The child list has no cap because each
    ///      edit is its own transaction paid for by its own creator.
    /// @param id The parent passport id.
    /// @param offset Where to start.
    /// @param limit How many to read at most. The page is clipped to what exists.
    /// @return page Child passport ids, oldest first.
    function getChildren(bytes32 id, uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        bytes32[] storage list = _children[id];
        (uint256 start, uint256 count) = _pageBounds(list.length, offset, limit);
        page = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            page[i] = list[start + i];
        }
    }

    /// @inheritdoc IMoolamRegistry
    function getDispute(bytes32 id) external view returns (Dispute memory) {
        return _disputes[id];
    }

    /// @inheritdoc IMoolamRegistry
    function withdrawable(address who) external view returns (uint256) {
        return _withdrawable[who];
    }

    /// @inheritdoc IMoolamRegistry
    function policy() external view returns (address) {
        return _POLICY;
    }

    /// @inheritdoc IMoolamRegistry
    function agentIdentity() external view returns (address) {
        return _AGENT_IDENTITY;
    }

    /// @notice Where the image, its C2PA manifest and its thumbnail live.
    /// @dev Reverts ERC721NonexistentToken for an unminted id.
    /// @param tokenId The token id, equal to uint256(passportId).
    /// @return The metadata URI recorded at registration.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _passports[bytes32(tokenId)].metadataURI;
    }

    function _write(PassportInput calldata p, address to) private returns (uint256 tokenId) {
        _passports[p.exactHash] = Passport({
            exactHash: p.exactHash,
            parentId: p.parentId,
            creator: p.creator,
            generatorAgentId: p.generatorAgentId,
            phash: p.phash,
            blockhash256: p.blockhash256,
            manifestHash: p.manifestHash,
            kind: p.kind,
            fingerprintVersion: p.fingerprintVersion,
            registeredAt: uint64(block.timestamp),
            disputed: false,
            metadataURI: p.metadataURI
        });

        emit PassportRegistered(
            p.exactHash,
            p.creator,
            p.generatorAgentId,
            p.parentId,
            p.phash,
            p.blockhash256,
            p.manifestHash,
            uint8(p.kind),
            p.fingerprintVersion,
            p.metadataURI
        );

        tokenId = uint256(p.exactHash);
        // _mint, not _safeMint: no ERC721Received callback, so minting hands control to nobody
        // and there is no reentrancy surface at the end of register or appendEdit.
        _mint(to, tokenId);
    }

    function _checkGenerator(bool agentRequired, uint256 agentId, bytes32 digest, bytes calldata signature) private view {
        if (!agentRequired) {
            if (agentId != 0) revert InvalidAgentId();
            if (signature.length != 0) revert InvalidGeneratorSignature();
            return;
        }

        if (agentId == 0) revert InvalidAgentId();

        address agentOwner;
        try IERC721(_AGENT_IDENTITY).ownerOf(agentId) returns (address owner_) {
            agentOwner = owner_;
        } catch {
            revert UnknownAgent(agentId);
        }
        if (agentOwner == address(0)) revert UnknownAgent(agentId);

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != agentOwner) revert InvalidGeneratorSignature();
    }

    function _pageBounds(uint256 length, uint256 offset, uint256 limit)
        private
        pure
        returns (uint256 start, uint256 count)
    {
        if (offset >= length) return (0, 0);
        uint256 remaining = length - offset;
        return (offset, limit < remaining ? limit : remaining);
    }
}
