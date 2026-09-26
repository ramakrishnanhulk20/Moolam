// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: many actions against each other (invariants) or the Chainlink report path.

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {Kind, PassportInput, Passport, DisputeStatus} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";

contract MoolamRegistryFuzzTest is Test {
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MockAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal receiver = makeAddr("receiver");

    uint256 internal constant AGENT_ID = 1;
    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal creatorKey = 0xA11CE;
    uint256 internal agentOwnerKey = 0xB0B;
    address internal creator;

    function setUp() public {
        creator = vm.addr(creatorKey);

        agents = new MockAgentIdentity();
        agents.mint(vm.addr(agentOwnerKey), AGENT_ID);

        policy = new VerifierPolicy(owner, resolver, treasury, 0.05 ether);
        registry = new MoolamRegistry(owner, address(policy), address(agents));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(receiver);
        policy.finalizeBootstrap();
        vm.stopPrank();

        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        bytes32 bindDigest = registry.hashBind(creator, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory bindAuth = WebAuthnFixture.sign(passkeyKey, bindDigest);
        vm.prank(creator);
        registry.bindPasskey(qx, qy, bindAuth);
    }

    function _register(PassportInput memory p) internal returns (uint256) {
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory agentSig = p.generatorAgentId == 0 ? bytes("") : WebAuthnFixture.signAsAgent(agentOwnerKey, digest);
        return registry.register(p, auth, agentSig);
    }

    function testFuzz_registerStoresExactlyWhatWasSigned(
        bytes32 exactHash,
        uint64 phash,
        bytes32 blockhash256,
        bytes32 manifestHash,
        uint8 fingerprintVersion,
        string calldata metadataURI,
        uint64 deadlineOffset
    ) public {
        vm.assume(exactHash != bytes32(0));
        vm.assume(bytes(metadataURI).length != 0);
        vm.assume(fingerprintVersion != 0);

        PassportInput memory p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: phash,
            blockhash256: blockhash256,
            manifestHash: manifestHash,
            kind: Kind.Generated,
            fingerprintVersion: fingerprintVersion,
            metadataURI: metadataURI,
            deadline: uint64(bound(deadlineOffset, 0, type(uint32).max)) + uint64(block.timestamp)
        });

        uint256 tokenId = _register(p);

        Passport memory stored = registry.getPassport(exactHash);
        assertEq(tokenId, uint256(exactHash));
        assertEq(registry.ownerOf(tokenId), creator);
        assertEq(stored.phash, phash);
        assertEq(stored.blockhash256, blockhash256);
        assertEq(stored.manifestHash, manifestHash);
        assertEq(stored.fingerprintVersion, fingerprintVersion);
        assertEq(stored.metadataURI, metadataURI);
        assertEq(stored.registeredAt, uint64(block.timestamp));
    }

    function testFuzz_registerRefusesATamperedField(bytes32 exactHash, uint64 phash, uint64 tamperedPhash) public {
        vm.assume(exactHash != bytes32(0));
        vm.assume(phash != tamperedPhash);

        PassportInput memory p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: phash,
            blockhash256: bytes32(0),
            manifestHash: bytes32(0),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://x",
            deadline: uint64(block.timestamp + 1 hours)
        });

        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, digest);

        p.phash = tamperedPhash;

        vm.expectRevert(MoolamRegistry.InvalidPasskeySignature.selector);
        registry.register(p, auth, agentSig);
    }

    function testFuzz_appendEditAlwaysHangsOffALiveParent(bytes32 parentHash, bytes32 childHash) public {
        vm.assume(parentHash != bytes32(0) && childHash != bytes32(0) && parentHash != childHash);

        PassportInput memory parent = PassportInput({
            exactHash: parentHash,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: 0,
            blockhash256: bytes32(0),
            manifestHash: bytes32(0),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://parent",
            deadline: uint64(block.timestamp + 1 hours)
        });
        _register(parent);

        PassportInput memory child = parent;
        child.exactHash = childHash;
        child.parentId = parentHash;
        child.kind = Kind.Edited;
        child.metadataURI = "ipfs://child";
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, registry.hashPassport(child));

        vm.prank(creator);
        registry.appendEdit(child, agentSig);

        assertTrue(registry.passportExists(registry.getPassport(childHash).parentId));
        assertEq(registry.ownerOf(uint256(childHash)), creator);
        assertEq(registry.childCount(parentHash), 1);
    }

    function testFuzz_disputeMoneyIsConserved(uint256 bond, bool upheld, address challenger) public {
        bond = bound(bond, 0, 100 ether);
        vm.assume(challenger != address(0) && challenger != address(registry));
        assumeNotPrecompile(challenger);
        assumePayable(challenger);

        vm.startPrank(owner);
        bytes32 changeId = policy.queueSetDisputeBond(bond);
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        policy.execute(changeId);
        vm.stopPrank();

        PassportInput memory p = PassportInput({
            exactHash: keccak256("disputed"),
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: 0,
            blockhash256: bytes32(0),
            manifestHash: bytes32(0),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://x",
            deadline: uint64(block.timestamp + 1 hours)
        });
        _register(p);

        vm.deal(challenger, bond);
        vm.prank(challenger);
        registry.flag{value: bond}(p.exactHash, "ipfs://evidence");

        assertEq(registry.totalBonds(), bond);
        assertEq(address(registry).balance, bond);

        vm.prank(resolver);
        registry.resolve(p.exactHash, upheld);

        address paid = upheld ? challenger : treasury;
        assertEq(registry.totalBonds(), 0);
        assertEq(registry.totalOwed(), bond);
        assertEq(registry.withdrawable(paid), bond);
        assertEq(address(registry).balance, bond);

        if (bond == 0) {
            vm.prank(paid);
            vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
            registry.withdraw();
            return;
        }

        uint256 before = paid.balance;
        vm.prank(paid);
        registry.withdraw();

        assertEq(paid.balance, before + bond);
        assertEq(registry.totalOwed(), 0);
        assertEq(address(registry).balance, 0);
        assertEq(registry.withdrawable(paid), 0);
    }

    function testFuzz_withdrawNeverPaysTwice(uint8 attempts) public {
        uint256 bond = 0.05 ether;
        address challenger = makeAddr("challenger");

        PassportInput memory p = PassportInput({
            exactHash: keccak256("double-spend"),
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: 0,
            blockhash256: bytes32(0),
            manifestHash: bytes32(0),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://x",
            deadline: uint64(block.timestamp + 1 hours)
        });
        _register(p);

        vm.deal(challenger, bond);
        vm.prank(challenger);
        registry.flag{value: bond}(p.exactHash, "ipfs://evidence");
        vm.prank(resolver);
        registry.resolve(p.exactHash, true);

        vm.prank(challenger);
        registry.withdraw();

        for (uint256 i = 0; i < bound(attempts, 1, 10); ++i) {
            vm.prank(challenger);
            vm.expectRevert(MoolamRegistry.NothingToWithdraw.selector);
            registry.withdraw();
        }

        assertEq(challenger.balance, bond);
        assertEq(address(registry).balance, 0);
    }
}
