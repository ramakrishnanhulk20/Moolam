// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: the policy's own timelock (see VerifierPolicy.t.sol), the
// Chainlink receiver path (see MoolamReceiver.t.sol), money conservation across random action
// orders (see the fuzz and invariant files), and the real P-256 precompile, because Foundry's
// local EVM runs OpenZeppelin's own P256 code path here rather than Monad's precompile at 0x0100.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {Kind, PassportInput, Passport, Attestation, Dispute, DisputeStatus} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test", "TST") {
        _mint(msg.sender, 1_000 ether);
    }
}

contract RefusesNative {
    receive() external payable {
        revert("no");
    }
}

// A treasury that can be called but cannot be paid. Its fallback is not payable, so the policy's
// zero value probe succeeds while a real payout reverts. This is the case withdrawTo exists for.
contract TreasuryThatCannotBePaid {
    MoolamRegistry private immutable REGISTRY;

    constructor(MoolamRegistry registry) {
        REGISTRY = registry;
    }

    function pullTo(address to) external {
        REGISTRY.withdrawTo(to);
    }

    fallback() external {}
}

contract MoolamRegistryTest is Test {
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MockAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal receiver = makeAddr("receiver");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BOND = 0.05 ether;
    uint256 internal constant AGENT_ID = 42;

    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal creatorKey = 0xA11CE;
    uint256 internal agentOwnerKey = 0xB0B;
    address internal creator;
    address internal agentOwner;

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
    event WithdrawnTo(address indexed who, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        creator = vm.addr(creatorKey);
        agentOwner = vm.addr(agentOwnerKey);

        agents = new MockAgentIdentity();
        agents.mint(agentOwner, AGENT_ID);

        policy = new VerifierPolicy(owner, resolver, treasury, BOND);
        registry = new MoolamRegistry(owner, address(policy), address(agents));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        policy.finalizeBootstrap();
        vm.stopPrank();

        _bind(creator, passkeyKey);
    }

    // Every signature is built into a local before a prank or an expectRevert. The fixture calls
    // Foundry cheatcodes, and a cheatcode call sitting inside an argument list would swallow the
    // prank meant for the contract call.
    function _bind(address wallet, uint256 key) internal {
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
        bytes32 digest = registry.hashBind(wallet, qx, qy, registry.bindNonce(wallet));
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, digest);

        vm.prank(wallet);
        registry.bindPasskey(qx, qy, auth);
    }

    function _input(bytes32 exactHash) internal view returns (PassportInput memory p) {
        p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: 0x0123456789abcdef,
            blockhash256: keccak256("block"),
            manifestHash: keccak256("manifest"),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://passport",
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function _editOf(bytes32 parentId, bytes32 exactHash) internal view returns (PassportInput memory p) {
        p = _input(exactHash);
        p.parentId = parentId;
        p.kind = Kind.Edited;
        p.metadataURI = "ipfs://edit";
    }

    function _creatorAuth(PassportInput memory p) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return WebAuthnFixture.sign(passkeyKey, registry.hashPassport(p));
    }

    function _agentSig(PassportInput memory p) internal view returns (bytes memory) {
        return WebAuthnFixture.signAsAgent(agentOwnerKey, registry.hashPassport(p));
    }

    function _registerAs(PassportInput memory p) internal returns (uint256 tokenId) {
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = p.generatorAgentId == 0 ? bytes("") : _agentSig(p);

        vm.prank(relayer);
        return registry.register(p, auth, agentSig);
    }

    function _registerDefault() internal returns (bytes32 id) {
        id = keccak256("image-one");
        _registerAs(_input(id));
    }

    function _flag(address who, bytes32 id) internal {
        vm.deal(who, who.balance + 1 ether);
        vm.prank(who);
        registry.flag{value: BOND}(id, "ipfs://evidence");
    }

    function test_constructorRejectsZeroAddressesAndNonContractIdentity() public {
        vm.expectRevert(MoolamRegistry.ZeroAddress.selector);
        new MoolamRegistry(owner, address(0), address(agents));

        vm.expectRevert(MoolamRegistry.ZeroAddress.selector);
        new MoolamRegistry(owner, address(policy), address(0));

        vm.expectRevert(MoolamRegistry.NotAContract.selector);
        new MoolamRegistry(owner, address(policy), stranger);
    }

    function test_constructorExposesItsWiring() public view {
        assertEq(registry.policy(), address(policy));
        assertEq(registry.agentIdentity(), address(agents));
        assertEq(registry.owner(), owner);
        assertEq(registry.name(), "Moolam Content Passport");
        assertEq(registry.symbol(), "MOOLAM");
    }

    function test_bindPasskeyStoresTheKeyAndBumpsTheNonce() public {
        address wallet = makeAddr("wallet");
        uint256 key = 0xC0FFEE;
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
        bytes32 digest = registry.hashBind(wallet, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, digest);

        vm.expectEmit(true, false, false, true, address(registry));
        emit PasskeyBound(wallet, qx, qy, 0);

        vm.prank(wallet);
        registry.bindPasskey(qx, qy, auth);

        (bytes32 storedX, bytes32 storedY) = registry.getPasskey(wallet);
        assertEq(storedX, qx);
        assertEq(storedY, qy);
        assertEq(registry.bindNonce(wallet), 1);
    }

    function test_bindPasskeyRejectsAZeroPublicKey() public {
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, bytes32(0));

        vm.prank(stranger);
        vm.expectRevert(MoolamRegistry.InvalidPublicKey.selector);
        registry.bindPasskey(bytes32(0), bytes32(uint256(1)), auth);
    }

    function test_bindPasskeyRejectsASignatureOverTheWrongDigest() public {
        address wallet = makeAddr("wallet2");
        uint256 key = 0xD00D;
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, keccak256("not the bind digest"));

        vm.prank(wallet);
        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.bindPasskey(qx, qy, auth);
    }

    function test_bindPasskeyRefusesAnAssertionWithoutUserVerification() public {
        address wallet = makeAddr("wallet3");
        uint256 key = 0xFEED;
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
        bytes32 digest = registry.hashBind(wallet, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, digest, WebAuthn.AUTH_DATA_FLAGS_UP);

        vm.prank(wallet);
        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.bindPasskey(qx, qy, auth);
    }

    function test_bindPasskeyRefusesAnAssertionWithoutUserPresence() public {
        address wallet = makeAddr("wallet4");
        uint256 key = 0xFACE;
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
        bytes32 digest = registry.hashBind(wallet, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, digest, WebAuthn.AUTH_DATA_FLAGS_UV);

        vm.prank(wallet);
        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.bindPasskey(qx, qy, auth);
    }

    function test_bindPasskeyNonceStopsAnOldAssertionBeingReplayed() public {
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        bytes32 usedDigest = registry.hashBind(creator, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory used = WebAuthnFixture.sign(passkeyKey, usedDigest);

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.bindPasskey(qx, qy, used);
    }

    function test_registerWritesThePassportAndMintsToTheCreator() public {
        PassportInput memory p = _input(keccak256("image-one"));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectEmit(true, true, true, true, address(registry));
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

        vm.prank(relayer);
        uint256 tokenId = registry.register(p, auth, agentSig);

        assertEq(tokenId, uint256(p.exactHash));
        assertEq(registry.ownerOf(tokenId), creator);
        assertTrue(registry.passportExists(p.exactHash));
        assertEq(registry.tokenURI(tokenId), "ipfs://passport");

        Passport memory stored = registry.getPassport(p.exactHash);
        assertEq(stored.exactHash, p.exactHash);
        assertEq(stored.parentId, bytes32(0));
        assertEq(stored.creator, creator);
        assertEq(stored.generatorAgentId, AGENT_ID);
        assertEq(stored.phash, p.phash);
        assertEq(stored.blockhash256, p.blockhash256);
        assertEq(stored.manifestHash, p.manifestHash);
        assertEq(uint8(stored.kind), uint8(Kind.Generated));
        assertEq(stored.fingerprintVersion, 1);
        assertEq(stored.registeredAt, uint64(block.timestamp));
        assertFalse(stored.disputed);
        assertEq(stored.metadataURI, "ipfs://passport");
    }

    function test_registerAcceptsACapturedImageWithNoAgent() public {
        PassportInput memory p = _input(keccak256("camera"));
        p.kind = Kind.Captured;
        p.generatorAgentId = 0;

        _registerAs(p);

        assertEq(registry.getPassport(p.exactHash).generatorAgentId, 0);
        assertEq(uint8(registry.getPassport(p.exactHash).kind), uint8(Kind.Captured));
    }

    function test_registerRejectsAZeroExactHash() public {
        PassportInput memory p = _input(bytes32(0));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidExactHash.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsTheSameImageTwice() public {
        bytes32 id = _registerDefault();
        PassportInput memory p = _input(id);
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportAlreadyExists.selector, id));
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAParentId() public {
        PassportInput memory p = _input(keccak256("child"));
        p.parentId = keccak256("parent");
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.ParentNotAllowed.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAZeroCreator() public {
        PassportInput memory p = _input(keccak256("nobody"));
        p.creator = address(0);
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidCreator.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsTheEditedKind() public {
        PassportInput memory p = _input(keccak256("edited"));
        p.kind = Kind.Edited;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidKind.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAnEmptyMetadataURI() public {
        PassportInput memory p = _input(keccak256("nouri"));
        p.metadataURI = "";
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.EmptyMetadataURI.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerAndAppendEditRejectAZeroFingerprintVersion() public {
        PassportInput memory p = _input(keccak256("noversion"));
        p.fingerprintVersion = 0;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidFingerprintVersion.selector);
        registry.register(p, auth, agentSig);

        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-noversion"));
        edit.fingerprintVersion = 0;
        bytes memory editSig = _agentSig(edit);

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidFingerprintVersion.selector);
        registry.appendEdit(edit, editSig);
    }

    function test_registerRejectsAPassedDeadline() public {
        PassportInput memory p = _input(keccak256("stale"));
        p.deadline = uint64(block.timestamp - 1);
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.SignatureExpired.selector, p.deadline));
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsACreatorWithNoBoundPasskey() public {
        PassportInput memory p = _input(keccak256("unbound"));
        p.creator = stranger;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PasskeyNotBound.selector, stranger));
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAPasskeySignatureFromAnotherDevice() public {
        PassportInput memory p = _input(keccak256("wrongkey"));
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(0xBADBAD, registry.hashPassport(p));
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAPasskeySignatureOverAnotherPassport() public {
        PassportInput memory p = _input(keccak256("swapped"));
        PassportInput memory other = _input(keccak256("other-image"));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(other);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAGeneratedImageWithNoAgentId() public {
        PassportInput memory p = _input(keccak256("noagent"));
        p.generatorAgentId = 0;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidAgentId.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsACapturedImageThatNamesAnAgent() public {
        PassportInput memory p = _input(keccak256("cameraagent"));
        p.kind = Kind.Captured;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);

        vm.expectRevert(MoolamRegistry.InvalidAgentId.selector);
        registry.register(p, auth, bytes(""));
    }

    function test_registerRejectsACapturedImageThatCarriesASignature() public {
        PassportInput memory p = _input(keccak256("camerasig"));
        p.kind = Kind.Captured;
        p.generatorAgentId = 0;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAnAgentIdNobodyRegistered() public {
        PassportInput memory p = _input(keccak256("ghost"));
        p.generatorAgentId = 999;
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.UnknownAgent.selector, uint256(999)));
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsASignatureFromSomeoneWhoDoesNotOwnTheAgent() public {
        PassportInput memory p = _input(keccak256("impostor"));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(0xDEAD, registry.hashPassport(p));

        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        registry.register(p, auth, agentSig);
    }

    function test_registerRejectsAMalformedGeneratorSignature() public {
        PassportInput memory p = _input(keccak256("garbage"));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);

        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        registry.register(p, auth, hex"1234");
    }

    function test_registerIsBlockedWhilePaused() public {
        PassportInput memory p = _input(keccak256("paused"));
        WebAuthn.WebAuthnAuth memory auth = _creatorAuth(p);
        bytes memory agentSig = _agentSig(p);

        vm.prank(owner);
        registry.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.register(p, auth, agentSig);
    }

    function test_appendEditRecordsTheChildAndMintsToTheParentOwner() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-one"));
        bytes memory agentSig = _agentSig(edit);

        vm.expectEmit(true, true, true, true, address(registry));
        emit PassportRegistered(
            edit.exactHash,
            edit.creator,
            edit.generatorAgentId,
            parent,
            edit.phash,
            edit.blockhash256,
            edit.manifestHash,
            uint8(Kind.Edited),
            edit.fingerprintVersion,
            edit.metadataURI
        );

        vm.prank(creator);
        uint256 tokenId = registry.appendEdit(edit, agentSig);

        assertEq(registry.ownerOf(tokenId), creator);
        assertEq(registry.childCount(parent), 1);
        assertEq(registry.getChildren(parent, 0, 10)[0], edit.exactHash);
        assertEq(registry.getPassport(edit.exactHash).parentId, parent);
        assertEq(uint8(registry.getPassport(edit.exactHash).kind), uint8(Kind.Edited));
    }

    function test_appendEditWorksWithNoAgentAtAll() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-manual"));
        edit.generatorAgentId = 0;

        vm.prank(creator);
        registry.appendEdit(edit, bytes(""));

        assertEq(registry.getPassport(edit.exactHash).generatorAgentId, 0);
    }

    /// @dev The registry marks only the passport the challenge named, so an edit of a picture that
    ///      was proven fake is accepted and reads clean. This is the documented gap: the deployed
    ///      registry cannot walk the edit chain on a write, so the index carries inheritedDisputed
    ///      and the web shows the child as disputed. The contract stores the parent link, which is
    ///      what makes that reconstruction possible off chain.
    function test_anEditOfADisputedParentIsAcceptedAndReadsClean() public {
        bytes32 parent = _registerDefault();
        _flag(stranger, parent);

        vm.prank(resolver);
        registry.resolve(parent, true);
        assertTrue(registry.getPassport(parent).disputed);

        PassportInput memory edit = _editOf(parent, keccak256("edit-of-a-fake"));
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        registry.appendEdit(edit, agentSig);

        assertFalse(registry.getPassport(edit.exactHash).disputed);
        assertEq(registry.getPassport(edit.exactHash).parentId, parent);
        assertEq(uint8(registry.getDispute(edit.exactHash).status), uint8(DisputeStatus.None));
    }

    function test_appendEditRefusesAnAddressApprovedForTheParentToken() public {
        bytes32 parent = _registerDefault();
        address session = makeAddr("session");
        PassportInput memory edit = _editOf(parent, keccak256("edit-approved"));
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        registry.approve(session, uint256(parent));

        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotParentOwner.selector, session));
        registry.appendEdit(edit, agentSig);

        assertFalse(registry.passportExists(edit.exactHash));
        assertEq(registry.childCount(parent), 0);
    }

    function test_appendEditRefusesAnOperatorApprovedForAll() public {
        bytes32 parent = _registerDefault();
        address operator = makeAddr("operator");
        PassportInput memory edit = _editOf(parent, keccak256("edit-operator"));
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        registry.setApprovalForAll(operator, true);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotParentOwner.selector, operator));
        registry.appendEdit(edit, agentSig);

        assertFalse(registry.passportExists(edit.exactHash));
        assertEq(registry.childCount(parent), 0);
    }

    function test_appendEditRejectsAZeroParent() public {
        PassportInput memory edit = _editOf(bytes32(0), keccak256("orphan"));

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidParent.selector);
        registry.appendEdit(edit, bytes(""));
    }

    function test_appendEditRejectsAParentThatDoesNotExist() public {
        bytes32 ghost = keccak256("ghost-parent");
        PassportInput memory edit = _editOf(ghost, keccak256("orphan2"));

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.ParentNotFound.selector, ghost));
        registry.appendEdit(edit, bytes(""));
    }

    function test_appendEditRejectsAZeroExactHashAndADuplicate() public {
        bytes32 parent = _registerDefault();

        PassportInput memory zero = _editOf(parent, bytes32(0));
        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidExactHash.selector);
        registry.appendEdit(zero, bytes(""));

        PassportInput memory dupe = _editOf(parent, parent);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportAlreadyExists.selector, parent));
        registry.appendEdit(dupe, bytes(""));
    }

    function test_appendEditRejectsTheWrongKind() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("wrongkind"));
        edit.kind = Kind.Generated;

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidKind.selector);
        registry.appendEdit(edit, bytes(""));
    }

    function test_appendEditRejectsAnEmptyMetadataURIAndAPassedDeadline() public {
        bytes32 parent = _registerDefault();

        PassportInput memory noUri = _editOf(parent, keccak256("edit-nouri"));
        noUri.metadataURI = "";
        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.EmptyMetadataURI.selector);
        registry.appendEdit(noUri, bytes(""));

        PassportInput memory stale = _editOf(parent, keccak256("edit-stale"));
        stale.deadline = uint64(block.timestamp - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.SignatureExpired.selector, stale.deadline));
        registry.appendEdit(stale, bytes(""));
    }

    function test_appendEditRejectsSomeoneWhoDoesNotHoldTheParent() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-thief"));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotParentOwner.selector, stranger));
        registry.appendEdit(edit, bytes(""));
    }

    function test_appendEditRejectsACreatorThatIsNotTheParentOwner() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-wrongcreator"));
        edit.creator = stranger;

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidCreator.selector);
        registry.appendEdit(edit, bytes(""));
    }

    function test_appendEditRejectsASignatureWhenNoAgentIsNamed() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-strandedsig"));
        edit.generatorAgentId = 0;
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        registry.appendEdit(edit, agentSig);
    }

    function test_appendEditRejectsAnAgentSignatureFromTheWrongWallet() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-impostor"));
        bytes memory agentSig = WebAuthnFixture.signAsAgent(0xDEAD, registry.hashPassport(edit));

        vm.prank(creator);
        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        registry.appendEdit(edit, agentSig);
    }

    function test_appendEditRejectsAnUnknownAgent() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-ghostagent"));
        edit.generatorAgentId = 777;
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.UnknownAgent.selector, uint256(777)));
        registry.appendEdit(edit, agentSig);
    }

    function test_appendEditIsBlockedWhilePaused() public {
        bytes32 parent = _registerDefault();
        PassportInput memory edit = _editOf(parent, keccak256("edit-paused"));

        vm.prank(owner);
        registry.pause();

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.appendEdit(edit, bytes(""));
    }

    function test_attestRecordsTheResult() public {
        bytes32 id = _registerDefault();

        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationAttested(id, receiver, true, 3, keccak256("recomputed"));

        vm.prank(receiver);
        registry.attest(id, true, 3, keccak256("recomputed"));

        assertEq(registry.attestationCount(id), 1);
        Attestation[] memory page = registry.getAttestations(id, 0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].receiver, receiver);
        assertTrue(page[0].matched);
        assertEq(page[0].distance, 3);
        assertEq(page[0].recomputed, keccak256("recomputed"));
        assertEq(page[0].at, uint64(block.timestamp));
    }

    function test_attestRejectsAnAddressThePolicyDoesNotList() public {
        bytes32 id = _registerDefault();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, stranger));
        registry.attest(id, true, 0, bytes32(0));
    }

    function test_attestRejectsAPassportThatDoesNotExist() public {
        bytes32 ghost = keccak256("nothing");

        vm.prank(receiver);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportNotFound.selector, ghost));
        registry.attest(ghost, true, 0, bytes32(0));
    }

    function test_attestStopsAtTheCap() public {
        bytes32 id = _registerDefault();
        uint256 cap = registry.MAX_ATTESTATIONS();

        vm.startPrank(receiver);
        for (uint256 i = 0; i < cap; ++i) {
            registry.attest(id, true, uint16(i), bytes32(i));
        }
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.AttestationCapReached.selector, id));
        registry.attest(id, true, 0, bytes32(0));
        vm.stopPrank();

        assertEq(registry.attestationCount(id), cap);
        assertEq(registry.getAttestations(id, cap - 2, 50).length, 2);
        assertEq(registry.getAttestations(id, cap, 10).length, 0);
    }

    function test_attestStillWorksWhilePaused() public {
        bytes32 id = _registerDefault();

        vm.prank(owner);
        registry.pause();

        vm.prank(receiver);
        registry.attest(id, false, 40, bytes32(0));
        assertEq(registry.attestationCount(id), 1);
    }

    function test_attestStopsOnceThePolicyDropsTheReceiver() public {
        bytes32 id = _registerDefault();

        vm.prank(owner);
        policy.removeReceiver(receiver);

        vm.prank(receiver);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, receiver));
        registry.attest(id, true, 0, bytes32(0));
    }

    function test_flagHoldsTheBond() public {
        bytes32 id = _registerDefault();
        vm.deal(stranger, 1 ether);

        vm.expectEmit(true, true, false, true, address(registry));
        emit PassportFlagged(id, stranger, BOND, keccak256(bytes("ipfs://evidence")), "ipfs://evidence");

        vm.prank(stranger);
        registry.flag{value: BOND}(id, "ipfs://evidence");

        Dispute memory d = registry.getDispute(id);
        assertEq(d.challenger, stranger);
        assertEq(d.bond, BOND);
        assertEq(d.evidenceHash, keccak256(bytes("ipfs://evidence")));
        assertEq(uint8(d.status), uint8(DisputeStatus.Open));
        assertEq(d.openedAt, uint64(block.timestamp));
        assertEq(registry.totalBonds(), BOND);
        assertEq(address(registry).balance, BOND);
    }

    function test_flagRejectsAnUnknownPassportAWrongBondAndASecondOpenDispute() public {
        bytes32 id = _registerDefault();
        vm.deal(stranger, 1 ether);
        bytes32 ghost = keccak256("no such image");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportNotFound.selector, ghost));
        registry.flag{value: BOND}(ghost, "ipfs://evidence");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.InvalidBond.selector, uint256(1), BOND));
        registry.flag{value: 1}(id, "ipfs://evidence");

        vm.prank(stranger);
        registry.flag{value: BOND}(id, "ipfs://evidence");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.DisputeAlreadyOpen.selector, id));
        registry.flag{value: BOND}(id, "ipfs://evidence");
    }

    function test_flagIsRefusedOnceAChallengeWasUpheld() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.prank(resolver);
        registry.resolve(id, true);

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportAlreadyDisputed.selector, id));
        registry.flag{value: BOND}(id, "ipfs://evidence-two");
    }

    function test_flagIsAllowedAgainAfterARejectedDispute() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.prank(resolver);
        registry.resolve(id, false);

        _flag(stranger, id);

        Dispute memory d = registry.getDispute(id);
        assertEq(uint8(d.status), uint8(DisputeStatus.Open));
        assertEq(d.challenger, stranger);
        assertEq(registry.totalBonds(), BOND);
    }

    function test_flagIsBlockedWhilePaused() public {
        bytes32 id = _registerDefault();
        vm.deal(stranger, 1 ether);

        vm.prank(owner);
        registry.pause();

        vm.prank(stranger);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.flag{value: BOND}(id, "ipfs://evidence");
    }

    function test_resolveUpheldCreditsTheChallengerAndMarksThePassport() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.expectEmit(true, true, false, true, address(registry));
        emit DisputeResolved(id, true, resolver);

        vm.prank(resolver);
        registry.resolve(id, true);

        assertTrue(registry.getPassport(id).disputed);
        assertEq(uint8(registry.getDispute(id).status), uint8(DisputeStatus.Upheld));
        assertEq(registry.withdrawable(stranger), BOND);
        assertEq(registry.totalBonds(), 0);
        assertEq(registry.totalOwed(), BOND);
    }

    function test_resolveRejectedCreditsTheTreasury() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.prank(resolver);
        registry.resolve(id, false);

        assertFalse(registry.getPassport(id).disputed);
        assertEq(uint8(registry.getDispute(id).status), uint8(DisputeStatus.Rejected));
        assertEq(registry.withdrawable(treasury), BOND);
        assertEq(registry.withdrawable(stranger), 0);
        assertEq(registry.totalBonds(), 0);
        assertEq(registry.totalOwed(), BOND);
    }

    function test_resolveRejectsAnyoneButTheResolverAndAClosedDispute() public {
        bytes32 id = _registerDefault();

        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NoOpenDispute.selector, id));
        registry.resolve(id, true);

        _flag(stranger, id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotResolver.selector, stranger));
        registry.resolve(id, true);

        vm.startPrank(resolver);
        registry.resolve(id, true);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NoOpenDispute.selector, id));
        registry.resolve(id, true);
        vm.stopPrank();
    }

    function test_withdrawPaysOutAndZeroesTheCredit() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);
        vm.prank(resolver);
        registry.resolve(id, true);

        uint256 before = stranger.balance;

        vm.expectEmit(true, false, false, true, address(registry));
        emit Withdrawn(stranger, BOND);

        vm.prank(stranger);
        registry.withdraw();

        assertEq(stranger.balance, before + BOND);
        assertEq(registry.withdrawable(stranger), 0);
        assertEq(registry.totalOwed(), 0);
        assertEq(address(registry).balance, 0);
    }

    function test_withdrawRejectsAZeroBalance() public {
        vm.prank(stranger);
        vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
        registry.withdraw();
    }

    function test_withdrawWorksWhilePaused() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);
        vm.prank(resolver);
        registry.resolve(id, true);

        vm.prank(owner);
        registry.pause();

        vm.prank(stranger);
        registry.withdraw();
        assertEq(registry.withdrawable(stranger), 0);
    }

    function test_withdrawSurfacesAFailedTransfer() public {
        RefusesNative refuser = new RefusesNative();
        bytes32 id = _registerDefault();
        _flag(address(refuser), id);

        vm.prank(resolver);
        registry.resolve(id, true);

        vm.prank(address(refuser));
        vm.expectRevert(MoolamRegistry.TransferFailed.selector);
        registry.withdraw();
    }

    function test_withdrawToLetsATreasuryContractSendItsCreditOn() public {
        TreasuryThatCannotBePaid holder = new TreasuryThatCannotBePaid(registry);
        address destination = makeAddr("treasuryOwner");
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.startPrank(owner);
        bytes32 change = policy.queueSetTreasury(address(holder));
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        policy.execute(change);
        vm.stopPrank();

        vm.prank(resolver);
        registry.resolve(id, false);
        assertEq(registry.withdrawable(address(holder)), BOND);

        vm.prank(address(holder));
        vm.expectRevert(MoolamRegistry.TransferFailed.selector);
        registry.withdraw();

        uint256 before = destination.balance;

        vm.expectEmit(true, true, false, true, address(registry));
        emit WithdrawnTo(address(holder), destination, BOND);

        holder.pullTo(destination);

        assertEq(destination.balance, before + BOND);
        assertEq(registry.withdrawable(address(holder)), 0);
        assertEq(registry.totalOwed(), 0);
        assertEq(address(registry).balance, 0);
    }

    function test_withdrawToRejectsAZeroDestinationAndAnEmptyCredit() public {
        address elsewhere = makeAddr("elsewhere");

        vm.prank(stranger);
        vm.expectRevert(MoolamRegistry.ZeroAddress.selector);
        registry.withdrawTo(address(0));

        vm.prank(stranger);
        vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
        registry.withdrawTo(elsewhere);
    }

    function test_withdrawToPaysOnceAndOnlyFromTheCallersOwnCredit() public {
        address destination = makeAddr("destination");
        bytes32 id = _registerDefault();
        _flag(stranger, id);
        vm.prank(resolver);
        registry.resolve(id, true);

        vm.prank(treasury);
        vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
        registry.withdrawTo(destination);

        vm.startPrank(stranger);
        registry.withdrawTo(destination);
        vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
        registry.withdrawTo(destination);
        vm.stopPrank();

        assertEq(destination.balance, BOND);
        assertEq(registry.totalOwed(), 0);
    }

    function test_anEoaTreasuryStillPullsWithPlainWithdraw() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);
        vm.prank(resolver);
        registry.resolve(id, false);

        uint256 before = treasury.balance;

        vm.expectEmit(true, false, false, true, address(registry));
        emit Withdrawn(treasury, BOND);

        vm.prank(treasury);
        registry.withdraw();

        assertEq(treasury.balance, before + BOND);
        assertEq(registry.withdrawable(treasury), 0);
    }

    function test_pauseAndUnpauseAreOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.pause();

        vm.startPrank(owner);
        registry.pause();
        assertTrue(registry.paused());
        registry.unpause();
        assertFalse(registry.paused());
        vm.stopPrank();

        _registerDefault();
    }

    function test_rescueERC20MovesStrandedTokens() public {
        TestToken token = new TestToken();
        token.transfer(address(registry), 10 ether);

        vm.expectEmit(true, true, false, true, address(registry));
        emit Rescued(address(token), stranger, 10 ether);

        vm.prank(owner);
        registry.rescueERC20(address(token), stranger, 10 ether);

        assertEq(token.balanceOf(stranger), 10 ether);
    }

    function test_rescueERC20RejectsAZeroDestinationAndAStranger() public {
        TestToken token = new TestToken();

        vm.prank(owner);
        vm.expectRevert(MoolamRegistry.ZeroAddress.selector);
        registry.rescueERC20(address(token), address(0), 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.rescueERC20(address(token), stranger, 1);
    }

    function test_rescueNativeCannotTouchBondsOrCredits() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.prank(owner);
        vm.expectRevert(MoolamRegistry.NothingToRescue.selector);
        registry.rescueNative(owner);

        vm.prank(resolver);
        registry.resolve(id, true);

        vm.prank(owner);
        vm.expectRevert(MoolamRegistry.NothingToRescue.selector);
        registry.rescueNative(owner);
    }

    function test_rescueNativeMovesOnlyTheSurplus() public {
        bytes32 id = _registerDefault();
        _flag(stranger, id);

        vm.deal(address(registry), address(registry).balance + 2 ether);

        vm.expectEmit(true, true, false, true, address(registry));
        emit Rescued(address(0), treasury, 2 ether);

        vm.prank(owner);
        registry.rescueNative(treasury);

        assertEq(treasury.balance, 2 ether);
        assertEq(address(registry).balance, BOND);
    }

    function test_rescueNativeRejectsAZeroDestinationAndAStranger() public {
        vm.prank(owner);
        vm.expectRevert(MoolamRegistry.ZeroAddress.selector);
        registry.rescueNative(address(0));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.rescueNative(stranger);
    }

    function test_ownerTransferTakesTwoSteps() public {
        address next = makeAddr("next");

        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner);

        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);
    }

    function test_tokenURIRevertsForAnUnmintedId() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, uint256(1)));
        registry.tokenURI(1);
    }

    function test_readsPageAndClipToWhatExists() public {
        bytes32 parent = _registerDefault();
        assertEq(registry.getChildren(parent, 0, 10).length, 0);
        assertEq(registry.getAttestations(parent, 5, 10).length, 0);

        PassportInput memory edit = _editOf(parent, keccak256("edit-page"));
        bytes memory agentSig = _agentSig(edit);

        vm.prank(creator);
        registry.appendEdit(edit, agentSig);

        assertEq(registry.getChildren(parent, 0, 1).length, 1);
        assertEq(registry.getChildren(parent, 1, 10).length, 0);
        assertEq(registry.childCount(parent), 1);
    }

    function test_theSameInputOnAnotherContractCannotBeReplayed() public {
        PassportInput memory p = _input(keccak256("image-one"));
        bytes32 digest = registry.hashPassport(p);

        MoolamRegistry other = new MoolamRegistry(owner, address(policy), address(agents));
        assertTrue(other.hashPassport(p) != digest);
    }
}
