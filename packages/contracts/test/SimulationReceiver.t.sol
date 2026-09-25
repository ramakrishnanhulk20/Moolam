// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: Chainlink's live MockKeystoneForwarder (a local copy with the same
// three behaviours stands in for it; the fork tests use the real one), the CRE simulator that builds
// the report, and the key custody of the sending wallet. A test cannot tell an honest holder of that
// key from a thief, and neither can the contract: that is a named non-goal.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {SimulationReceiver} from "../src/SimulationReceiver.sol";
import {MoolamRegistry} from "../src/MoolamRegistry.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";
import {ReceiverTemplate} from "../src/vendor/chainlink/ReceiverTemplate.sol";
import {IReceiver} from "../src/vendor/chainlink/IReceiver.sol";
import {Kind, PassportInput, Attestation} from "../src/interfaces/IMoolamRegistry.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";
import {LocalMockForwarder} from "./mocks/LocalMockForwarder.sol";
import {WebAuthnFixture} from "./utils/WebAuthnFixture.sol";

/// @dev Shared by the unit and the fuzz file. Builds the registry, the policy and one registered
///      passport, deploys a receiver on a local copy of the mock forwarder, pins it the way the
///      deploy script does, and lists it.
abstract contract SimulationReceiverSetup is Test {
    SimulationReceiver internal simReceiver;
    LocalMockForwarder internal mock;
    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MockAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");
    address internal creWallet = makeAddr("creWallet");
    address internal stranger = makeAddr("stranger");

    /// @dev What the CRE simulator stamps into every report header, read off real report
    ///      transactions on Monad mainnet (packages/recheck-runner/README.md).
    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    /// @dev The first ten hex characters of sha256("moolam-verifier"), as text.
    bytes10 internal constant PUBLIC_NAME = 0x34623863303364663034;
    string internal constant WORKFLOW_NAME = "moolam-verifier";

    uint256 internal constant AGENT_ID = 7;
    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal creatorKey = 0xA11CE;
    uint256 internal agentOwnerKey = 0xB0B;

    bytes32 internal passportId = keccak256("image-under-review");

    uint64 internal constant NOW = 1_800_000_000;
    /// @dev A run stamps executedAt before it fetches and fingerprints, so it trails the block.
    uint64 internal constant EXECUTED_AT = NOW - 90;

    event VerificationAttested(
        bytes32 indexed passportId, address indexed receiver, bool matched, uint16 distance, bytes32 recomputed
    );
    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function setUp() public virtual {
        vm.warp(NOW);
        address creator = vm.addr(creatorKey);

        agents = new MockAgentIdentity();
        agents.mint(vm.addr(agentOwnerKey), AGENT_ID);

        policy = new VerifierPolicy(owner, resolver, treasury, 0.05 ether);
        registry = new MoolamRegistry(owner, address(policy), address(agents));
        mock = new LocalMockForwarder();
        simReceiver = new SimulationReceiver(address(mock), address(registry), creWallet);
        _pin(simReceiver);

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(address(simReceiver));
        policy.finalizeBootstrap();
        vm.stopPrank();

        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        WebAuthn.WebAuthnAuth memory bindAuth = WebAuthnFixture.sign(passkeyKey, registry.hashBind(creator, qx, qy, 0));
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
        registry.register(
            p, WebAuthnFixture.sign(passkeyKey, digest), WebAuthnFixture.signAsAgent(agentOwnerKey, digest)
        );
    }

    /// @dev The same three pins, in the same order, as script/DeploySimulationReceivers.s.sol.
    function _pin(SimulationReceiver r) internal {
        r.setExpectedAuthor(SIM_OWNER);
        r.setExpectedWorkflowName(WORKFLOW_NAME);
        r.setExpectedWorkflowId(SIM_WORKFLOW_ID);
    }

    function _payload(uint256 chainId, uint64 executedAt, bytes32 id) internal pure returns (bytes memory) {
        return abi.encode(chainId, executedAt, id, true, uint16(2), keccak256("recomputed"));
    }

    function _payload(uint64 executedAt) internal view returns (bytes memory) {
        return _payload(block.chainid, executedAt, passportId);
    }

    /// @dev The simulator's 109 byte header: version, execution id, timestamp, DON id, config
    ///      version (45 bytes the receiver never sees), then workflow id, name, owner, report id.
    function _raw(bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes1(0x01),
            keccak256("execution"),
            uint32(0x6aa7993e),
            uint32(100),
            uint32(1),
            SIM_WORKFLOW_ID,
            PUBLIC_NAME,
            SIM_OWNER,
            bytes2(0x0001),
            payload
        );
    }

    function _metadata() internal pure returns (bytes memory) {
        return abi.encodePacked(SIM_WORKFLOW_ID, PUBLIC_NAME, SIM_OWNER, bytes2(0x0001));
    }

    /// @dev Sends a report through the mock the way the CLI does: the signing wallet calls the
    ///      mock's report, which calls onReport. Two-argument prank, so tx.origin is set as well.
    function _sendThroughMock(address origin, bytes memory payload) internal {
        vm.prank(origin, origin);
        mock.report(address(simReceiver), _raw(payload), "", new bytes[](0));
    }
}

contract SimulationReceiverTest is SimulationReceiverSetup {
    function test_constructorWiresTheForwarderRegistryAndSendingWallet() public view {
        assertEq(simReceiver.getForwarderAddress(), address(mock));
        assertEq(address(simReceiver.REGISTRY()), address(registry));
        assertEq(simReceiver.SENDING_WALLET(), creWallet);
        assertEq(simReceiver.MAX_FUTURE_SKEW(), 1 hours);
        assertEq(simReceiver.owner(), address(this));
        assertTrue(simReceiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(simReceiver.supportsInterface(type(IERC165).interfaceId));
    }

    function test_constructorRefusesZeroAddresses() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new SimulationReceiver(address(0), address(registry), creWallet);

        vm.expectRevert(SimulationReceiver.ZeroAddress.selector);
        new SimulationReceiver(address(mock), address(0), creWallet);

        vm.expectRevert(SimulationReceiver.ZeroAddress.selector);
        new SimulationReceiver(address(mock), address(registry), address(0));
    }

    function test_aReportThroughTheMockLandsWhenTheSendingWalletSentIt() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit VerificationAttested(passportId, address(simReceiver), true, 2, keccak256("recomputed"));
        vm.expectEmit(true, true, true, true, address(mock));
        emit ReportProcessed(address(simReceiver), keccak256("execution"), bytes2(0x0001), true);

        _sendThroughMock(creWallet, _payload(EXECUTED_AT));

        Attestation[] memory page = registry.getAttestations(passportId, 0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].receiver, address(simReceiver));
        assertTrue(page[0].matched);
        assertEq(page[0].distance, 2);
        assertEq(simReceiver.lastExecutedAt(passportId), EXECUTED_AT);
    }

    function test_aReportFromAnyOtherOriginIsRefused() public {
        // Straight at the receiver, as the mock would call it, with a stranger signing.
        vm.prank(address(mock), stranger);
        vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.WrongSendingWallet.selector, stranger, creWallet));
        simReceiver.onReport(_metadata(), _payload(EXECUTED_AT));

        // Through the mock: the mock swallows the revert, so the transaction succeeds, the event
        // says false, and nothing is written.
        vm.expectEmit(true, true, true, true, address(mock));
        emit ReportProcessed(address(simReceiver), keccak256("execution"), bytes2(0x0001), false);
        _sendThroughMock(stranger, _payload(EXECUTED_AT));

        // The wallet as the immediate caller of the mock is not enough: a contract it called
        // would have msg.sender set to the wallet while tx.origin is someone else.
        vm.prank(creWallet, stranger);
        mock.report(address(simReceiver), _raw(_payload(EXECUTED_AT)), "", new bytes[](0));

        assertEq(registry.attestationCount(passportId), 0);
        assertEq(simReceiver.lastExecutedAt(passportId), 0);
    }

    function test_theSendingWalletCannotSkipTheForwarder() public {
        vm.prank(creWallet, creWallet);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, creWallet, address(mock)));
        simReceiver.onReport(_metadata(), _payload(EXECUTED_AT));
    }

    function test_executedAtAtTheLargestUint64IsRefused() public {
        uint64 far = type(uint64).max;

        vm.prank(address(mock), creWallet);
        vm.expectRevert(
            abi.encodeWithSelector(
                SimulationReceiver.ReportFromTheFuture.selector, passportId, far, uint256(NOW) + 1 hours
            )
        );
        simReceiver.onReport(_metadata(), _payload(far));

        assertEq(simReceiver.lastExecutedAt(passportId), 0);
        assertEq(registry.attestationCount(passportId), 0);
    }

    function test_executedAtOneSecondPastTheSkewIsRefusedAndAtTheSkewIsAccepted() public {
        uint64 edge = NOW + 1 hours;

        vm.prank(address(mock), creWallet);
        vm.expectRevert(
            abi.encodeWithSelector(SimulationReceiver.ReportFromTheFuture.selector, passportId, edge + 1, edge)
        );
        simReceiver.onReport(_metadata(), _payload(edge + 1));

        _sendThroughMock(creWallet, _payload(edge));

        assertEq(simReceiver.lastExecutedAt(passportId), edge);
        assertEq(registry.attestationCount(passportId), 1);
    }

    function test_theFloorIsStrictlyMonotonic() public {
        _sendThroughMock(creWallet, _payload(EXECUTED_AT));

        vm.prank(address(mock), creWallet);
        vm.expectRevert(
            abi.encodeWithSelector(SimulationReceiver.StaleReport.selector, passportId, EXECUTED_AT, EXECUTED_AT)
        );
        simReceiver.onReport(_metadata(), _payload(EXECUTED_AT));

        vm.prank(address(mock), creWallet);
        vm.expectRevert(
            abi.encodeWithSelector(SimulationReceiver.StaleReport.selector, passportId, EXECUTED_AT - 1, EXECUTED_AT)
        );
        simReceiver.onReport(_metadata(), _payload(EXECUTED_AT - 1));

        _sendThroughMock(creWallet, _payload(EXECUTED_AT + 1));

        assertEq(simReceiver.lastExecutedAt(passportId), EXECUTED_AT + 1);
        assertEq(registry.attestationCount(passportId), 2);
    }

    function test_aReportBuiltForAnotherChainIsRefused() public {
        uint256 otherChain = block.chainid + 1;

        vm.prank(address(mock), creWallet);
        vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.WrongChain.selector, otherChain, block.chainid));
        simReceiver.onReport(_metadata(), _payload(otherChain, EXECUTED_AT, passportId));

        assertEq(simReceiver.lastExecutedAt(passportId), 0);
    }

    function test_anUnlistedReceiverIsRefusedAtTheRegistry() public {
        SimulationReceiver unlisted = new SimulationReceiver(address(mock), address(registry), creWallet);
        _pin(unlisted);

        vm.prank(address(mock), creWallet);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, address(unlisted)));
        unlisted.onReport(_metadata(), _payload(EXECUTED_AT));

        vm.prank(owner);
        policy.removeReceiver(address(simReceiver));
        vm.prank(address(mock), creWallet);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, address(simReceiver)));
        simReceiver.onReport(_metadata(), _payload(EXECUTED_AT));
    }

    function test_theDeployAndPinStepsEmitTheirEvents() public {
        vm.expectEmit(true, true, false, false);
        emit ReceiverTemplate.ForwarderAddressUpdated(address(0), address(mock));
        SimulationReceiver fresh = new SimulationReceiver(address(mock), address(registry), creWallet);

        vm.expectEmit(true, true, false, false, address(fresh));
        emit ReceiverTemplate.ExpectedAuthorUpdated(address(0), SIM_OWNER);
        fresh.setExpectedAuthor(SIM_OWNER);

        vm.expectEmit(true, true, false, false, address(fresh));
        emit ReceiverTemplate.ExpectedWorkflowNameUpdated(bytes10(0), PUBLIC_NAME);
        fresh.setExpectedWorkflowName(WORKFLOW_NAME);

        vm.expectEmit(true, true, false, false, address(fresh));
        emit ReceiverTemplate.ExpectedWorkflowIdUpdated(bytes32(0), SIM_WORKFLOW_ID);
        fresh.setExpectedWorkflowId(SIM_WORKFLOW_ID);

        assertEq(fresh.getExpectedWorkflowName(), PUBLIC_NAME);
    }

    function test_aReportCarryingAnotherWorkflowNameIsRefusedByThePin() public {
        bytes10 otherName = 0x64323036636163326334;
        bytes memory metadata = abi.encodePacked(SIM_WORKFLOW_ID, otherName, SIM_OWNER, bytes2(0x0001));

        vm.prank(address(mock), creWallet);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowName.selector, otherName, PUBLIC_NAME));
        simReceiver.onReport(metadata, _payload(EXECUTED_AT));
    }

    /// @dev R2. Two halves. The runtime code's dispatcher is read for every selector it answers,
    ///      and that set must be exactly the known one, so a function added later fails this test
    ///      until someone looks at it. Then every owner setter that exists is run to its widest
    ///      setting, pins cleared and ownership given away, and the sending wallet is unchanged and
    ///      a stranger is still refused.
    function test_noFunctionChangesTheSendingWallet() public {
        bytes4[] memory found = _dispatcherSelectors(address(simReceiver).code);
        bytes4[17] memory known = [
            bytes4(keccak256("MAX_FUTURE_SKEW()")),
            bytes4(keccak256("REGISTRY()")),
            bytes4(keccak256("SENDING_WALLET()")),
            SimulationReceiver.lastExecutedAt.selector,
            ReceiverTemplate.getForwarderAddress.selector,
            ReceiverTemplate.getExpectedAuthor.selector,
            ReceiverTemplate.getExpectedWorkflowName.selector,
            ReceiverTemplate.getExpectedWorkflowId.selector,
            ReceiverTemplate.onReport.selector,
            ReceiverTemplate.setForwarderAddress.selector,
            ReceiverTemplate.setExpectedAuthor.selector,
            ReceiverTemplate.setExpectedWorkflowName.selector,
            ReceiverTemplate.setExpectedWorkflowId.selector,
            ReceiverTemplate.supportsInterface.selector,
            Ownable.owner.selector,
            Ownable.transferOwnership.selector,
            Ownable.renounceOwnership.selector
        ];
        assertEq(found.length, known.length, "the receiver answers a selector nobody reviewed");
        for (uint256 i = 0; i < known.length; i++) {
            bool present;
            for (uint256 j = 0; j < found.length; j++) {
                if (found[j] == known[i]) present = true;
            }
            assertTrue(present, "a known selector is missing from the dispatcher");
        }

        simReceiver.setExpectedWorkflowName("");
        simReceiver.setExpectedAuthor(address(0));
        simReceiver.setExpectedWorkflowId(bytes32(0));
        simReceiver.setForwarderAddress(address(0));
        simReceiver.transferOwnership(stranger);
        vm.prank(stranger);
        simReceiver.renounceOwnership();

        assertEq(simReceiver.SENDING_WALLET(), creWallet);
        vm.prank(stranger, stranger);
        vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.WrongSendingWallet.selector, stranger, creWallet));
        simReceiver.onReport("", _payload(EXECUTED_AT));
    }

    /// @dev Walks the runtime code opcode by opcode, skipping push data, and collects every
    ///      PUSH4 that is compared with EQ straight after, which is how solc's dispatcher matches
    ///      a selector. Duplicates are counted once, since supportsInterface compares against
    ///      interface ids that equal the onReport and supportsInterface selectors.
    function _dispatcherSelectors(bytes memory code) internal pure returns (bytes4[] memory out) {
        bytes4[] memory buffer = new bytes4[](64);
        uint256 count;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0x63 && i + 5 < code.length && uint8(code[i + 5]) == 0x14) {
                bytes4 selector = bytes4(bytes.concat(code[i + 1], code[i + 2], code[i + 3], code[i + 4]));
                bool seen;
                for (uint256 k = 0; k < count; k++) {
                    if (buffer[k] == selector) seen = true;
                }
                if (!seen) buffer[count++] = selector;
            }
            i += (op >= 0x60 && op <= 0x7f) ? uint256(op) - 0x5e : 1;
        }
        out = new bytes4[](count);
        for (uint256 k = 0; k < count; k++) {
            out[k] = buffer[k];
        }
    }
}
