// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: what the reasons document says or whether it exists on IPFS, the index binding the
// event to DisputeResolved, or the live registry and policy (fork tests).

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {MoolamDecisions} from "../src/MoolamDecisions.sol";
import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {Kind, PassportInput, DisputeStatus} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";

contract MoolamDecisionsTest is Test {
    MoolamDecisions internal decisions;
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal challenger = makeAddr("challenger");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BOND = 0.05 ether;
    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal creatorKey = 0xA11CE;

    bytes32 internal passportId = keccak256("challenged picture");

    // A real version 0 CID (46 characters) and a real version 1 CID (59 characters).
    string internal constant REASONS = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    string internal constant REASONS_V1 = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    event DecisionPublished(
        bytes32 indexed passportId, uint64 indexed openedAt, bool upheld, string reasonsURI, address resolver
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        MockAgentIdentity agents = new MockAgentIdentity();
        policy = new VerifierPolicy(owner, resolver, treasury, BOND);
        registry = new MoolamRegistry(owner, address(policy), address(agents));
        decisions = new MoolamDecisions(address(registry), address(policy));

        address creator = vm.addr(creatorKey);
        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        WebAuthn.WebAuthnAuth memory bindAuth = WebAuthnFixture.sign(passkeyKey, registry.hashBind(creator, qx, qy, 0));
        vm.prank(creator);
        registry.bindPasskey(qx, qy, bindAuth);

        PassportInput memory p = PassportInput({
            exactHash: passportId,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: 0,
            phash: 1,
            blockhash256: keccak256("block"),
            manifestHash: bytes32(0),
            kind: Kind.Captured,
            fingerprintVersion: 1,
            metadataURI: "ipfs://passport",
            deadline: uint64(block.timestamp + 1 hours)
        });
        registry.register(p, WebAuthnFixture.sign(passkeyKey, registry.hashPassport(p)), "");

        vm.deal(challenger, 10 ether);
    }

    function _flag() internal returns (uint64 openedAt) {
        vm.prank(challenger);
        registry.flag{value: BOND}(passportId, "ipfs://evidence");
        return registry.getDispute(passportId).openedAt;
    }

    function _flagAndResolve(bool upheld) internal returns (uint64 openedAt) {
        openedAt = _flag();
        vm.prank(resolver);
        registry.resolve(passportId, upheld);
    }

    function test_constructorBindsTheRegistryAndItsOwnPolicyOnly() public {
        assertEq(address(decisions.REGISTRY()), address(registry));
        assertEq(address(decisions.POLICY()), address(policy));

        vm.expectRevert(MoolamDecisions.ZeroAddress.selector);
        new MoolamDecisions(address(0), address(policy));

        vm.expectRevert(MoolamDecisions.ZeroAddress.selector);
        new MoolamDecisions(address(registry), address(0));

        VerifierPolicy otherPolicy = new VerifierPolicy(owner, stranger, treasury, BOND);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamDecisions.PolicyMismatch.selector, address(policy), address(otherPolicy))
        );
        new MoolamDecisions(address(registry), address(otherPolicy));
    }

    function test_theResolverPublishesAnUpheldDecision() public {
        uint64 openedAt = _flagAndResolve(true);

        vm.expectEmit(true, true, false, true, address(decisions));
        emit DecisionPublished(passportId, openedAt, true, REASONS, resolver);
        vm.prank(resolver);
        decisions.publish(passportId, REASONS);

        assertTrue(decisions.published(passportId, openedAt));
    }

    function test_theResolverPublishesARejectedDecision() public {
        uint64 openedAt = _flagAndResolve(false);

        vm.expectEmit(true, true, false, true, address(decisions));
        emit DecisionPublished(passportId, openedAt, false, REASONS_V1, resolver);
        vm.prank(resolver);
        decisions.publish(passportId, REASONS_V1);
    }

    function test_publishByAnyoneButTheResolverIsRefused() public {
        uint64 openedAt = _flagAndResolve(true);

        address[3] memory callers = [stranger, challenger, owner];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.NotResolver.selector, callers[i]));
            decisions.publish(passportId, REASONS);
        }

        assertFalse(decisions.published(passportId, openedAt));
    }

    // The resolver is read from the policy on every call, so a change there moves the right to publish.
    function test_theResolverIsReadAtCallTime() public {
        _flagAndResolve(true);
        address newResolver = makeAddr("newResolver");

        vm.prank(owner);
        bytes32 changeId = policy.queueSetResolver(newResolver);
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        vm.prank(owner);
        policy.execute(changeId);

        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.NotResolver.selector, resolver));
        decisions.publish(passportId, REASONS);

        vm.prank(newResolver);
        decisions.publish(passportId, REASONS);
    }

    function test_publishOnAnOpenOrNeverFlaggedDisputeIsRefused() public {
        vm.prank(resolver);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamDecisions.DisputeNotResolved.selector, passportId, DisputeStatus.None)
        );
        decisions.publish(passportId, REASONS);

        bytes32 ghost = keccak256("never registered");
        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.DisputeNotResolved.selector, ghost, DisputeStatus.None));
        decisions.publish(ghost, REASONS);

        uint64 openedAt = _flag();
        vm.prank(resolver);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamDecisions.DisputeNotResolved.selector, passportId, DisputeStatus.Open)
        );
        decisions.publish(passportId, REASONS);

        assertFalse(decisions.published(passportId, openedAt));
    }

    function test_aMalformedOrTooLongReasonsAddressIsRefused() public {
        uint64 openedAt = _flagAndResolve(true);
        string memory cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

        string[11] memory bad = [
            "",
            "ipfs://",
            "ipfs://QmShort",
            string.concat("https://", cid),
            string.concat("IPFS://", cid),
            string.concat("ipfs:/", cid),
            string.concat("ipfs://", cid, "/reasons.json"),
            string.concat("ipfs://", cid, "?x=1"),
            string.concat("ipfs://", cid, " "),
            string.concat("ipfs://", cid, unicode"é"),
            string.concat("ipfs://", _letters(122))
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(resolver);
            vm.expectRevert(MoolamDecisions.InvalidReasonsURI.selector);
            decisions.publish(passportId, bad[i]);
        }
        assertFalse(decisions.published(passportId, openedAt));

        // 128 bytes in all is the most allowed.
        vm.prank(resolver);
        decisions.publish(passportId, string.concat("ipfs://", _letters(121)));
        assertTrue(decisions.published(passportId, openedAt));
    }

    function test_aSecondPublishForTheSameDisputeIsRefused() public {
        uint64 openedAt = _flagAndResolve(false);

        vm.prank(resolver);
        decisions.publish(passportId, REASONS);

        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(MoolamDecisions.AlreadyPublished.selector, passportId, openedAt));
        decisions.publish(passportId, REASONS_V1);
    }

    function test_publishAfterAReFlagNamesTheNewDispute() public {
        uint64 firstOpenedAt = _flagAndResolve(false);
        vm.prank(resolver);
        decisions.publish(passportId, REASONS);

        vm.warp(block.timestamp + 1 days);
        uint64 secondOpenedAt = _flag();
        assertGt(secondOpenedAt, firstOpenedAt);

        vm.prank(resolver);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamDecisions.DisputeNotResolved.selector, passportId, DisputeStatus.Open)
        );
        decisions.publish(passportId, REASONS_V1);

        vm.prank(resolver);
        registry.resolve(passportId, true);

        vm.expectEmit(true, true, false, true, address(decisions));
        emit DecisionPublished(passportId, secondOpenedAt, true, REASONS_V1, resolver);
        vm.prank(resolver);
        decisions.publish(passportId, REASONS_V1);

        assertTrue(decisions.published(passportId, firstOpenedAt));
        assertTrue(decisions.published(passportId, secondOpenedAt));
    }

    function test_itTakesNoMoneyAndAnswersNoUnknownCall() public {
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        (bool sentValue,) = address(decisions).call{value: 1 wei}("");
        assertFalse(sentValue);

        vm.prank(stranger);
        (bool unknownCall,) = address(decisions).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(unknownCall);
    }

    function _letters(uint256 n) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = "a";
        }
        return string(out);
    }
}
