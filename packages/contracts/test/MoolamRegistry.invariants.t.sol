// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: the exact revert reason of any single call, which the unit tests
// own, and the Chainlink forwarder. The handler drives random actors through register, appendEdit,
// attest, flag, resolve, withdraw, pause and unpause, and the six invariants below must hold after
// every one of them.

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {Kind, PassportInput, Passport, Dispute, DisputeStatus} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";

/// @notice Drives the registry the way the outside world would: several creators with their own
///         passkeys, one listed receiver, one resolver, and an owner who can pause at any moment.
contract RegistryHandler is Test {
    MoolamRegistry public registry;
    VerifierPolicy public policy;

    address public immutable OWNER;
    address public immutable RESOLVER;
    address public immutable RECEIVER;
    address public immutable TREASURY;

    uint256 public constant BOND = 0.05 ether;
    uint256 internal constant ACTOR_COUNT = 3;
    // The invariant checks walk this list, so cap it. The run still reaches every state, it just
    // does not spend the whole budget on one more near identical passport.
    uint256 internal constant MAX_PASSPORTS = 48;
    uint256 internal constant AGENT_ID = 1;

    uint256 internal agentOwnerKey;

    address[] public actors;
    uint256[] public actorKeys;

    bytes32[] public passports;
    bytes32[] public openDisputes;
    mapping(bytes32 passportId => bool seen) public minted;
    mapping(bytes32 passportId => bool open) public isOpen;

    uint256 public registeredWhilePaused;
    uint256 public duplicateMints;

    constructor(
        MoolamRegistry registry_,
        VerifierPolicy policy_,
        address owner_,
        address resolver_,
        address receiver_,
        address treasury_,
        uint256 agentOwnerKey_
    ) {
        registry = registry_;
        policy = policy_;
        OWNER = owner_;
        RESOLVER = resolver_;
        RECEIVER = receiver_;
        TREASURY = treasury_;
        agentOwnerKey = agentOwnerKey_;

        for (uint256 i = 0; i < ACTOR_COUNT; ++i) {
            uint256 key = 0x1000 + i;
            address actor = vm.addr(key);
            actors.push(actor);
            actorKeys.push(key);

            (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(key);
            bytes32 bindDigest = registry.hashBind(actor, qx, qy, 0);
            WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, bindDigest);
            vm.prank(actor);
            registry.bindPasskey(qx, qy, auth);

            vm.deal(actor, 100 ether);
        }
    }

    function passportCount() external view returns (uint256) {
        return passports.length;
    }

    function openDisputeCount() external view returns (uint256) {
        return openDisputes.length;
    }

    function _actor(uint256 seed) internal view returns (address actor, uint256 key) {
        uint256 i = seed % ACTOR_COUNT;
        return (actors[i], actorKeys[i]);
    }

    function _base(address creator, bytes32 exactHash) internal view returns (PassportInput memory p) {
        p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: uint64(uint256(exactHash)),
            blockhash256: blockhash(block.number - 1),
            manifestHash: exactHash,
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://passport",
            deadline: uint64(block.timestamp + 1 days)
        });
    }

    function register(uint256 actorSeed, bytes32 salt) external {
        (address actor, uint256 key) = _actor(actorSeed);
        if (passports.length >= MAX_PASSPORTS) return;
        bytes32 exactHash = keccak256(abi.encode(salt, actor, passports.length));
        if (exactHash == bytes32(0) || registry.passportExists(exactHash)) return;

        PassportInput memory p = _base(actor, exactHash);
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(key, digest);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, digest);

        bool wasPaused = registry.paused();

        try registry.register(p, auth, agentSig) {
            if (minted[exactHash]) duplicateMints++;
            passports.push(exactHash);
            minted[exactHash] = true;
            if (wasPaused) registeredWhilePaused++;
        } catch {}
    }

    function appendEdit(uint256 parentSeed, bytes32 salt) external {
        if (passports.length == 0) return;
        bytes32 parentId = passports[parentSeed % passports.length];
        address parentOwner = registry.ownerOf(uint256(parentId));

        if (passports.length >= MAX_PASSPORTS) return;
        bytes32 exactHash = keccak256(abi.encode("edit", salt, parentId, passports.length));
        if (exactHash == bytes32(0) || registry.passportExists(exactHash)) return;

        PassportInput memory p = _base(parentOwner, exactHash);
        p.parentId = parentId;
        p.kind = Kind.Edited;
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, registry.hashPassport(p));

        bool wasPaused = registry.paused();

        vm.prank(parentOwner);
        try registry.appendEdit(p, agentSig) {
            if (minted[exactHash]) duplicateMints++;
            passports.push(exactHash);
            minted[exactHash] = true;
            if (wasPaused) registeredWhilePaused++;
        } catch {}
    }

    function attest(uint256 passportSeed, bool matched, uint16 distance, bool useReceiver) external {
        if (passports.length == 0) return;
        bytes32 id = passports[passportSeed % passports.length];
        address caller = useReceiver ? RECEIVER : actors[passportSeed % ACTOR_COUNT];

        vm.prank(caller);
        try registry.attest(id, matched, distance, keccak256(abi.encode(id, distance))) {} catch {}
    }

    function flag(uint256 passportSeed, uint256 actorSeed) external {
        if (passports.length == 0) return;
        bytes32 id = passports[passportSeed % passports.length];
        (address actor,) = _actor(actorSeed);

        vm.deal(actor, actor.balance + BOND);
        vm.prank(actor);
        try registry.flag{value: BOND}(id, "ipfs://evidence") {
            openDisputes.push(id);
            isOpen[id] = true;
        } catch {}
    }

    function resolve(uint256 disputeSeed, bool upheld) external {
        if (openDisputes.length == 0) return;
        uint256 i = disputeSeed % openDisputes.length;
        bytes32 id = openDisputes[i];

        vm.prank(RESOLVER);
        try registry.resolve(id, upheld) {
            isOpen[id] = false;
            openDisputes[i] = openDisputes[openDisputes.length - 1];
            openDisputes.pop();
        } catch {}
    }

    function withdraw(uint256 actorSeed, bool asTreasury) external {
        address who = asTreasury ? TREASURY : actors[actorSeed % ACTOR_COUNT];

        vm.prank(who);
        try registry.withdraw() {} catch {}
    }

    function setPaused(bool on) external {
        vm.prank(OWNER);
        if (on) {
            try registry.pause() {} catch {}
        } else {
            try registry.unpause() {} catch {}
        }
    }
}

contract MoolamRegistryInvariantsTest is StdInvariant, Test {
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MockAgentIdentity internal agents;
    RegistryHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal receiver = makeAddr("receiver");

    uint256 internal agentOwnerKey = 0xB0B;

    function setUp() public {
        agents = new MockAgentIdentity();
        agents.mint(vm.addr(agentOwnerKey), 1);

        policy = new VerifierPolicy(owner, resolver, treasury, 0.05 ether);
        registry = new MoolamRegistry(owner, address(policy), address(agents));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        policy.finalizeBootstrap();
        vm.stopPrank();

        handler = new RegistryHandler(registry, policy, owner, resolver, receiver, treasury, agentOwnerKey);

        targetContract(address(handler));
        excludeSender(address(registry));
        excludeSender(address(policy));
    }

    /// The contract can always pay what it owes: bonds still held plus credits not yet pulled.
    function invariant_balanceCoversEveryLiability() public view {
        assertGe(address(registry).balance, registry.totalBonds() + registry.totalOwed());
    }

    /// The bond total is exactly the sum of the bonds behind disputes that are still open.
    function invariant_totalBondsMatchesOpenDisputes() public view {
        uint256 sum;
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            Dispute memory d = registry.getDispute(handler.passports(i));
            if (d.status == DisputeStatus.Open) sum += d.bond;
        }
        assertEq(registry.totalBonds(), sum);
    }

    /// Every edit points at a parent that really exists.
    function invariant_everyChildHasALiveParent() public view {
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            Passport memory p = registry.getPassport(handler.passports(i));
            if (p.parentId != bytes32(0)) {
                assertTrue(registry.passportExists(p.parentId));
                assertEq(uint8(p.kind), uint8(Kind.Edited));
            }
        }
    }

    /// No image id is ever minted twice, and every recorded passport has exactly one owner.
    function invariant_noPassportIdIsMintedTwice() public view {
        assertEq(handler.duplicateMints(), 0);
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            assertTrue(registry.passportExists(id));
            assertTrue(registry.ownerOf(uint256(id)) != address(0));
        }
    }

    /// Attestations only ever come from an address the policy lists.
    function invariant_attestationsOnlyComeFromListedReceivers() public view {
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            uint256 n = registry.attestationCount(id);
            assertLe(n, registry.MAX_ATTESTATIONS());
            for (uint256 j = 0; j < n; ++j) {
                assertTrue(policy.isReceiver(registry.getAttestations(id, j, 1)[0].receiver));
            }
        }
    }

    /// A pause really stops new passports appearing.
    function invariant_noPassportAppearsWhilePaused() public view {
        assertEq(handler.registeredWhilePaused(), 0);
    }
}
