// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: the KeystoneForwarder, report signatures or the CRE workflow; a workflow simulation proves those.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {ReceiverTemplate} from "../src/vendor/chainlink/ReceiverTemplate.sol";
import {IReceiver} from "../src/vendor/chainlink/IReceiver.sol";
import {Kind, PassportInput, Attestation} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

contract MoolamReceiverTest is Test {
    MoolamReceiver internal moolamReceiver;
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MockAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal forwarder = makeAddr("forwarder");
    address internal stranger = makeAddr("stranger");
    address internal creWallet = makeAddr("creWallet");

    string internal constant WORKFLOW_NAME = "moolam-verifier";

    uint256 internal constant AGENT_ID = 7;
    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal creatorKey = 0xA11CE;
    uint256 internal agentOwnerKey = 0xB0B;
    address internal creator;

    bytes32 internal passportId = keccak256("image-under-review");

    uint64 internal constant EXECUTED_AT = 1_800_000_000;

    event VerificationAttested(
        bytes32 indexed passportId, address indexed receiver, bool matched, uint16 distance, bytes32 recomputed
    );

    function setUp() public {
        creator = vm.addr(creatorKey);

        agents = new MockAgentIdentity();
        agents.mint(vm.addr(agentOwnerKey), AGENT_ID);

        policy = new VerifierPolicy(owner, resolver, treasury, 0.05 ether);
        registry = new MoolamRegistry(owner, address(policy), address(agents));
        moolamReceiver = new MoolamReceiver(forwarder, address(registry));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(address(moolamReceiver));
        policy.finalizeBootstrap();
        vm.stopPrank();

        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        bytes32 bindDigest = registry.hashBind(creator, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory bindAuth = WebAuthnFixture.sign(passkeyKey, bindDigest);
        vm.prank(creator);
        registry.bindPasskey(qx, qy, bindAuth);

        PassportInput memory p = PassportInput({
            exactHash: passportId,
            parentId: bytes32(0),
            creator: creator,
            generatorAgentId: AGENT_ID,
            phash: 1,
            blockhash256: keccak256("block"),
            manifestHash: keccak256("manifest"),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://passport",
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, digest);
        registry.register(p, auth, agentSig);
    }

    function _report(bytes32 id, bool matched, uint16 distance, bytes32 recomputed)
        internal
        view
        returns (bytes memory)
    {
        return _report(block.chainid, EXECUTED_AT, id, matched, distance, recomputed);
    }

    function _report(uint256 chainId, uint64 executedAt, bytes32 id, bool matched, uint16 distance, bytes32 recomputed)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(chainId, executedAt, id, matched, distance, recomputed);
    }

    function _metadata() internal pure returns (bytes memory) {
        // Forwarder metadata: 32 byte workflow id, 10 byte name, 20 byte owner, 2 byte report id.
        return _metadata(bytes10("moolamver"), address(uint160(0xABCD)));
    }

    function _metadata(bytes10 workflowName, address workflowAuthor) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), workflowName, workflowAuthor, bytes2(0));
    }

    function _pinIdentity() internal returns (bytes10 encodedName) {
        moolamReceiver.setExpectedAuthor(creWallet);
        moolamReceiver.setExpectedWorkflowName(WORKFLOW_NAME);
        encodedName = moolamReceiver.getExpectedWorkflowName();
    }

    function test_constructorWiresTheForwarderAndRegistry() public view {
        assertEq(moolamReceiver.getForwarderAddress(), forwarder);
        assertEq(address(moolamReceiver.REGISTRY()), address(registry));
        assertEq(moolamReceiver.owner(), address(this));
        assertTrue(moolamReceiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(moolamReceiver.supportsInterface(type(IERC165).interfaceId));
    }

    function test_constructorRejectsAZeroForwarderOrRegistry() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new MoolamReceiver(address(0), address(registry));

        vm.expectRevert(MoolamReceiver.ZeroAddress.selector);
        new MoolamReceiver(forwarder, address(0));
    }

    function test_aReportFromTheForwarderLandsAsAnAttestation() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationAttested(passportId, address(moolamReceiver), true, 4, keccak256("recomputed"));

        vm.prank(forwarder);
        moolamReceiver.onReport(_metadata(), _report(passportId, true, 4, keccak256("recomputed")));

        Attestation[] memory page = registry.getAttestations(passportId, 0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].receiver, address(moolamReceiver));
        assertTrue(page[0].matched);
        assertEq(page[0].distance, 4);
        assertEq(page[0].recomputed, keccak256("recomputed"));
        assertEq(moolamReceiver.lastExecutedAt(passportId), EXECUTED_AT);
    }

    function test_theSameReportSentTwiceIsRefused() public {
        bytes memory report = _report(passportId, true, 4, keccak256("recomputed"));

        vm.prank(forwarder);
        moolamReceiver.onReport(_metadata(), report);

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamReceiver.StaleReport.selector, passportId, EXECUTED_AT, EXECUTED_AT)
        );
        moolamReceiver.onReport(_metadata(), report);

        assertEq(registry.attestationCount(passportId), 1);
    }

    // The replay floor is per receiver, so a used report still lands on a newly listed one.
    function test_aUsedReportIsRefusedHereAndStillLandsOnAFreshReceiver() public {
        bytes memory report = _report(passportId, true, 4, keccak256("recomputed"));

        vm.prank(forwarder);
        moolamReceiver.onReport(_metadata(), report);

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamReceiver.StaleReport.selector, passportId, EXECUTED_AT, EXECUTED_AT)
        );
        moolamReceiver.onReport(_metadata(), report);

        MoolamReceiver secondReceiver = new MoolamReceiver(forwarder, address(registry));

        vm.prank(owner);
        bytes32 changeId = policy.queueAddReceiver(address(secondReceiver));
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        vm.prank(owner);
        policy.execute(changeId);

        vm.prank(forwarder);
        secondReceiver.onReport(_metadata(), report);

        assertEq(registry.attestationCount(passportId), 2);
        assertEq(secondReceiver.lastExecutedAt(passportId), EXECUTED_AT);
        assertEq(registry.getAttestations(passportId, 1, 1)[0].receiver, address(secondReceiver));
    }

    function test_aReportBuiltForAnotherChainIsRefused() public {
        uint256 otherChain = block.chainid + 1;

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(MoolamReceiver.WrongChain.selector, otherChain, block.chainid));
        moolamReceiver.onReport(
            _metadata(), _report(otherChain, EXECUTED_AT, passportId, true, 4, keccak256("recomputed"))
        );

        assertEq(registry.attestationCount(passportId), 0);
        assertEq(moolamReceiver.lastExecutedAt(passportId), 0);
    }

    function test_anOlderReportAfterANewerOneIsRefused() public {
        vm.prank(forwarder);
        moolamReceiver.onReport(
            _metadata(), _report(block.chainid, EXECUTED_AT + 60, passportId, true, 4, keccak256("newer"))
        );

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(MoolamReceiver.StaleReport.selector, passportId, EXECUTED_AT, EXECUTED_AT + 60)
        );
        moolamReceiver.onReport(
            _metadata(), _report(block.chainid, EXECUTED_AT, passportId, false, 40, keccak256("older"))
        );

        assertEq(registry.attestationCount(passportId), 1);
        assertEq(moolamReceiver.lastExecutedAt(passportId), EXECUTED_AT + 60);
    }

    function test_aReportFromAnyOtherAddressIsRefused() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, stranger, forwarder));
        moolamReceiver.onReport(_metadata(), _report(passportId, true, 0, bytes32(0)));

        assertEq(registry.attestationCount(passportId), 0);
    }

    function test_aReportForTheWrongWorkflowIdIsRefused() public {
        bytes32 expectedId = bytes32(uint256(99));

        vm.prank(address(this));
        moolamReceiver.setExpectedWorkflowId(expectedId);

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowId.selector, bytes32(uint256(1)), expectedId)
        );
        moolamReceiver.onReport(_metadata(), _report(passportId, true, 0, bytes32(0)));
    }

    function test_theWorkflowIdSetterIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        moolamReceiver.setExpectedWorkflowId(bytes32(uint256(2)));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        moolamReceiver.setForwarderAddress(stranger);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        moolamReceiver.setExpectedAuthor(stranger);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        moolamReceiver.setExpectedWorkflowName("stranger-workflow");
    }

    function test_aReportFromThePinnedWorkflowLands() public {
        bytes10 encodedName = _pinIdentity();

        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationAttested(passportId, address(moolamReceiver), true, 4, keccak256("recomputed"));

        vm.prank(forwarder);
        moolamReceiver.onReport(
            _metadata(encodedName, creWallet), _report(passportId, true, 4, keccak256("recomputed"))
        );

        assertEq(registry.attestationCount(passportId), 1);
        assertEq(moolamReceiver.getExpectedAuthor(), creWallet);
    }

    function test_aReportCarryingAnotherWorkflowNameIsRefused() public {
        bytes10 encodedName = _pinIdentity();
        bytes10 otherName = bytes10("0badc0ffee");

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowName.selector, otherName, encodedName));
        moolamReceiver.onReport(_metadata(otherName, creWallet), _report(passportId, true, 4, bytes32(0)));

        assertEq(registry.attestationCount(passportId), 0);
    }

    function test_aReportCarryingAnotherAuthorIsRefused() public {
        bytes10 encodedName = _pinIdentity();

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, stranger, creWallet));
        moolamReceiver.onReport(_metadata(encodedName, stranger), _report(passportId, true, 4, bytes32(0)));

        assertEq(registry.attestationCount(passportId), 0);
    }

    function test_clearingThePinReopensTheReceiverForASimulation() public {
        _pinIdentity();

        // Name first, so no report ever meets a name with no author behind it.
        moolamReceiver.setExpectedWorkflowName("");
        moolamReceiver.setExpectedAuthor(address(0));

        assertEq(moolamReceiver.getExpectedAuthor(), address(0));
        assertEq(moolamReceiver.getExpectedWorkflowName(), bytes10(0));

        vm.prank(forwarder);
        moolamReceiver.onReport(_metadata(), _report(passportId, true, 4, keccak256("recomputed")));

        assertEq(registry.attestationCount(passportId), 1);
    }

    function test_aReportForAnUnknownPassportIsRefusedByTheRegistry() public {
        bytes32 ghost = keccak256("never registered");

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.PassportNotFound.selector, ghost));
        moolamReceiver.onReport(_metadata(), _report(ghost, true, 0, bytes32(0)));
    }

    function test_theRegistryRefusesTheReceiverOnceThePolicyDropsIt() public {
        vm.prank(owner);
        policy.removeReceiver(address(moolamReceiver));

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, address(moolamReceiver)));
        moolamReceiver.onReport(_metadata(), _report(passportId, true, 0, bytes32(0)));
    }
}
