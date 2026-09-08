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
        "Passport(bytes32 exactHash,bytes32 parentId,address creator,uint256 generatorAgentId,"
        "uint64 phash,bytes32 blockhash256,bytes32 manifestHash,uint8 kind,uint8 fingerprintVersion,"
        "string metadataURI,uint64 deadline)"
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

    /// @notice A wallet bound or rotated the passkey that signs its passports.
    /// @param wallet The wallet the key now belongs to.
    /// @param qx The passkey public key x coordinate.
    /// @param qy The passkey public key y coordinate.
    /// @param nonce The bind nonce this signature consumed.
    event PasskeyBound(address indexed wallet, bytes32 qx, bytes32 qy, uint256 nonce);
    /// @notice A new passport was written. Indexers build the whole provenance graph from this.
    /// @param passportId The sha256 of the exact image bytes, and the token id.
    /// @param creator The wallet that owns the token.
    /// @param generatorAgentId The ERC-8004 agent that generated the image, zero if none.
    /// @param parentId The passport this one was edited from, zero for an original.
    /// @param phash The 64 bit perceptual hash.
    /// @param blockhash256 The 256 bit block hash recorded with the image.
    /// @param manifestHash The sha256 of the C2PA manifest store, zero when there is none.
    /// @param kind 0 Generated, 1 Captured, 2 Edited.
    /// @param fingerprintVersion Which fingerprint algorithm produced phash.
    /// @param metadataURI Where the image, manifest and thumbnail live.
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
    /// @notice A listed verifier rechecked a passport and recorded the result.
    /// @param passportId The passport that was rechecked.
    /// @param receiver The listed receiver that wrote the result.
    /// @param matched Whether the recomputed fingerprint matched the recorded one.
    /// @param distance The perceptual hash distance measured.
    /// @param recomputed The fingerprint the verifier computed.
    event VerificationAttested(
        bytes32 indexed passportId, address indexed receiver, bool matched, uint16 distance, bytes32 recomputed
    );
    /// @notice Someone challenged a passport and posted a bond.
    /// @param passportId The passport being challenged.
    /// @param challenger Who opened the dispute.
    /// @param bond The bond held by this contract until the dispute is settled.
    /// @param evidenceHash The keccak256 of the evidence URI, stored so the URI cannot be swapped.
    /// @param evidenceURI Where the evidence lives.
    event PassportFlagged(
        bytes32 indexed passportId, address indexed challenger, uint256 bond, bytes32 evidenceHash, string evidenceURI
    );
    /// @notice A dispute was settled.
    /// @param passportId The passport that was disputed.
    /// @param upheld True when the challenge stood and the passport is now marked disputed.
    /// @param resolver The resolver that settled it.
    event DisputeResolved(bytes32 indexed passportId, bool upheld, address indexed resolver);
    /// @notice Someone pulled the native token they were owed.
    /// @param who The address that pulled.
    /// @param amount How much left the contract.
    event Withdrawn(address indexed who, uint256 amount);
    /// @notice Someone pulled what they were owed and sent it to another address.
    /// @param who The address whose credit was spent.
    /// @param to Where the money went.
    /// @param amount How much left the contract.
    event WithdrawnTo(address indexed who, address indexed to, uint256 amount);
    /// @notice The owner moved stranded value out. Never touches a bond or an unclaimed credit.
    /// @param token The ERC-20 moved, or the zero address for native token.
    /// @param to Where it went.
    /// @param amount How much moved.
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
    error InvalidFingerprintVersion();
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
    error PassportAlreadyDisputed(bytes32 passportId);
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
    ///      when kind is Edited, InvalidFingerprintVersion when the version byte is zero,
    ///      EmptyMetadataURI on an empty URI, SignatureExpired past the
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
        if (p.fingerprintVersion == 0) revert InvalidFingerprintVersion();
        if (bytes(p.metadataURI).length == 0) revert EmptyMetadataURI();
        // forge-lint: disable-next-line(block-timestamp)
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
    /// @dev No passkey signature here. Holding the parent token is the authority, which is what
    ///      lets an editing session sign many edits without a fresh biometric prompt each time.
    ///      An ERC-721 approval is not enough. Approval is permission to move the token, granted
    ///      to marketplaces and escrows, and it must never become permission to write history
    ///      under the owner's name. A session signer edits from the owner's own wallet.
    ///      Reverts InvalidParent on a zero parent, ParentNotFound when the parent is unknown,
    ///      NotParentOwner when the caller is not the parent owner, InvalidCreator when the
    ///      creator field is not the parent owner, InvalidKind when kind is not Edited,
    ///      InvalidFingerprintVersion when the version byte is zero,
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
        if (p.fingerprintVersion == 0) revert InvalidFingerprintVersion();
        if (bytes(p.metadataURI).length == 0) revert EmptyMetadataURI();
        // forge-lint: disable-next-line(block-timestamp)
        if (p.deadline < block.timestamp) revert SignatureExpired(p.deadline);

        address parentOwner = ownerOf(uint256(p.parentId));
        if (msg.sender != parentOwner) revert NotParentOwner(msg.sender);
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
                // forge-lint: disable-next-line(unsafe-typecast)
                at: uint64(block.timestamp)
            })
        );

        emit VerificationAttested(passportId, msg.sender, matched, distance, recomputed);
    }

    /// @notice Opens a dispute against a passport, backed by a bond.
    /// @dev The bond is held by this contract and never sent anywhere until resolve runs, so a
    ///      flag costs the challenger nothing but the gas if they turn out to be right.
    ///      A passport whose challenge was already upheld cannot be flagged again: the record
    ///      already says disputed, so a second bond would be burned for nothing. A passport whose
    ///      challenge was rejected can be flagged again with fresh evidence.
    ///      Reverts PassportNotFound, DisputeAlreadyOpen, PassportAlreadyDisputed, InvalidBond.
    ///      Emits PassportFlagged.
    /// @param passportId The passport being challenged.
    /// @param evidenceURI Where the evidence lives. Only its keccak256 hash is stored.
    function flag(bytes32 passportId, string calldata evidenceURI) external payable nonReentrant whenNotPaused {
        if (_passports[passportId].registeredAt == 0) revert PassportNotFound(passportId);

        Dispute storage dispute = _disputes[passportId];
        if (dispute.status == DisputeStatus.Open) revert DisputeAlreadyOpen(passportId);
        if (dispute.status == DisputeStatus.Upheld) revert PassportAlreadyDisputed(passportId);

        uint256 required = IVerifierPolicy(_POLICY).disputeBond();
        if (msg.value != required) revert InvalidBond(msg.value, required);

        bytes32 evidenceHash = keccak256(bytes(evidenceURI));
        _disputes[passportId] = Dispute({
            challenger: msg.sender,
            bond: msg.value,
            evidenceHash: evidenceHash,
            status: DisputeStatus.Open,
            // forge-lint: disable-next-line(unsafe-typecast)
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
        uint256 amount = _takeCredit();
        emit Withdrawn(msg.sender, amount);
        _payOut(msg.sender, amount);
    }

    /// @notice Pulls whatever the caller is owed and sends it to an address the caller names.
    /// @dev The escape hatch for a credited address that cannot hold native token itself, such as
    ///      a treasury contract with no payable path. Nobody can move anyone else's credit: the
    ///      balance spent is always the caller's own.
    ///      Reverts ZeroAddress on a zero destination, NothingToWithdraw on a zero balance and
    ///      TransferFailed if the send fails. Emits WithdrawnTo.
    /// @param to Where the money should go.
    function withdrawTo(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _takeCredit();
        emit WithdrawnTo(msg.sender, to, amount);
        _payOut(to, amount);
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
    function rescueERC20(address token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Rescued(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Moves native token that is not backing a bond or an unclaimed credit.
    /// @dev The amount is the balance minus every liability, so an open bond and an unclaimed
    ///      credit can never be swept by the owner.
    ///      Reverts ZeroAddress, NothingToRescue, TransferFailed. Emits Rescued.
    /// @param to Where to send the surplus.
    function rescueNative(address to) external nonReentrant onlyOwner {
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

    function _takeCredit() private returns (uint256 amount) {
        amount = _withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        _withdrawable[msg.sender] = 0;
        totalOwed -= amount;
    }

    // slither-disable-next-line arbitrary-send-eth
    function _payOut(address to, uint256 amount) private {
        // The destination is chosen by the caller on purpose, and that is the point of withdrawTo.
        // What bounds it is the amount: _takeCredit has already zeroed the caller's own balance,
        // so the only money that can leave here is money that caller was owed.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
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
            // forge-lint: disable-next-line(unsafe-typecast)
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
        // forge-lint: disable-next-line(unsafe-oz-erc721-mint)
        _mint(to, tokenId);
    }

    function _checkGenerator(bool agentRequired, uint256 agentId, bytes32 digest, bytes calldata signature) private view {
        if (!agentRequired) {
            if (agentId != 0) revert InvalidAgentId();
            if (signature.length != 0) revert InvalidGeneratorSignature();
            return;
        }

        if (agentId == 0) revert InvalidAgentId();

        address agentOwner = _agentOwnerOf(agentId);

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != agentOwner) revert InvalidGeneratorSignature();
    }

    function _agentOwnerOf(uint256 agentId) private view returns (address) {
        // The ERC-8004 registry reverts on an unknown id, so a bad agent id must not bubble up
        // as the registry's own error and confuse a caller about which contract refused.
        try IERC721(_AGENT_IDENTITY).ownerOf(agentId) returns (address owner_) {
            if (owner_ == address(0)) revert UnknownAgent(agentId);
            return owner_;
        } catch {
            revert UnknownAgent(agentId);
        }
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
