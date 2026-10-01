// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: the KeystoneForwarder's signature checks, the CRE workflow, whether the ids name real
// passports in the right order (the index checks that), or the live chain (fork tests).

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MoolamLookalikes} from "../src/MoolamLookalikes.sol";
import {ReceiverTemplate} from "../src/vendor/chainlink/ReceiverTemplate.sol";

abstract contract MoolamLookalikesSetup is Test {
    MoolamLookalikes internal lookalikes;

    address internal forwarder = makeAddr("forwarder");
    address internal stranger = makeAddr("stranger");

    address internal constant WORKFLOW_OWNER = 0xf072a8c620bFc818875736E3f2d3A2A339c06584;
    string internal constant WORKFLOW_NAME = "moolam-verifier";
    // The first ten hex characters of sha256("moolam-verifier"), as the template stores the name.
    bytes10 internal constant WORKFLOW_NAME_PIN = 0x34623863303364663034;

    bytes32 internal constant KIND = keccak256("moolam.lookalike.v1");
    bytes32 internal passportId = keccak256("later passport");
    bytes32 internal earlierId = keccak256("earlier passport");

    uint64 internal constant NOW = 1_800_000_000;

    event LookalikeChecked(
        bytes32 indexed passportId,
        bytes32 indexed earlierId,
        uint16 phashDistance,
        uint16 blockhashDistance,
        bool earlierSealed,
        uint64 executedAt
    );

    function setUp() public virtual {
        vm.warp(NOW);
        lookalikes = new MoolamLookalikes(forwarder);
        lookalikes.setExpectedAuthor(WORKFLOW_OWNER);
        lookalikes.setExpectedWorkflowName(WORKFLOW_NAME);
    }

    function _metadata() internal pure returns (bytes memory) {
        return _metadata(WORKFLOW_NAME_PIN, WORKFLOW_OWNER);
    }

    // Forwarder metadata: 32 byte workflow id, 10 byte name, 20 byte owner, 2 byte report id.
    function _metadata(bytes10 name, address author) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), name, author, bytes2(0));
    }

    function _payload(bytes32 id, bytes32 earlier, uint64 executedAt) internal view returns (bytes memory) {
        return abi.encode(KIND, block.chainid, executedAt, id, earlier, uint16(3), uint16(12), false);
    }

    function _deliver(bytes memory payload) internal {
        vm.prank(forwarder);
        lookalikes.onReport(_metadata(), payload);
    }

    function _assertNothingStored(bytes32 id) internal view {
        MoolamLookalikes.Lookalike memory r = lookalikes.originOf(id);
        assertEq(r.executedAt, 0);
        assertEq(r.writtenAt, 0);
        assertEq(r.earlierId, bytes32(0));
    }
}

contract MoolamLookalikesTest is MoolamLookalikesSetup {
    function test_aCallerOtherThanTheForwarderIsRefused() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, stranger, forwarder));
        lookalikes.onReport(_metadata(), _payload(passportId, earlierId, NOW));

        _assertNothingStored(passportId);
    }

    function test_aReportFromAnotherWorkflowOwnerIsRefused() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, stranger, WORKFLOW_OWNER));
        lookalikes.onReport(_metadata(WORKFLOW_NAME_PIN, stranger), _payload(passportId, earlierId, NOW));

        _assertNothingStored(passportId);
    }

    function test_aReportFromAnotherWorkflowNameIsRefused() public {
        bytes10 otherName = bytes10("0badc0ffee");

        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowName.selector, otherName, WORKFLOW_NAME_PIN)
        );
        lookalikes.onReport(_metadata(otherName, WORKFLOW_OWNER), _payload(passportId, earlierId, NOW));

        _assertNothingStored(passportId);
    }

    function test_aReportWithTheWrongKindWordIsRefused() public {
        bytes32 otherKind = keccak256("moolam.lookalike.v2");
        bytes memory payload =
            abi.encode(otherKind, block.chainid, NOW, passportId, earlierId, uint16(3), uint16(12), false);

        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.WrongKind.selector, otherKind));
        _deliver(payload);

        _assertNothingStored(passportId);
    }

    // The verdict receiver's payload is (chainId, executedAt, passportId, matched, distance, recomputed).
    function test_aVerdictShapedPayloadIsRefused() public {
        bytes memory verdict = abi.encode(block.chainid, NOW, passportId, true, uint16(2), keccak256("recomputed"));
        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.MalformedReport.selector, verdict.length));
        _deliver(verdict);

        // Padded to the right length, its first word is a chain id, not the kind word.
        bytes memory padded = abi.encodePacked(verdict, bytes32(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.WrongKind.selector, bytes32(block.chainid)));
        _deliver(padded);

        _assertNothingStored(passportId);
    }

    function test_aReportForAnotherChainIsRefused() public {
        uint256 otherChain = block.chainid + 1;
        bytes memory payload = abi.encode(KIND, otherChain, NOW, passportId, earlierId, uint16(3), uint16(12), false);

        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.WrongChain.selector, otherChain, block.chainid));
        _deliver(payload);

        _assertNothingStored(passportId);
    }

    function test_aReportForPassportZeroIsRefused() public {
        vm.expectRevert(MoolamLookalikes.ZeroPassport.selector);
        _deliver(_payload(bytes32(0), earlierId, NOW));

        _assertNothingStored(bytes32(0));
    }

    function test_aReportNamingThePassportAsItsOwnEarlierIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.SamePassport.selector, passportId));
        _deliver(_payload(passportId, passportId, NOW));

        _assertNothingStored(passportId);
    }

    function test_executedAtAtOrBelowTheFloorIsRefused() public {
        _deliver(_payload(passportId, earlierId, NOW));

        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.StaleReport.selector, passportId, NOW, NOW));
        _deliver(_payload(passportId, bytes32(0), NOW));

        vm.expectRevert(abi.encodeWithSelector(MoolamLookalikes.StaleReport.selector, passportId, NOW - 1, NOW));
        _deliver(_payload(passportId, bytes32(0), NOW - 1));

        assertEq(lookalikes.originOf(passportId).earlierId, earlierId);
        assertEq(lookalikes.originOf(passportId).executedAt, NOW);
    }

    function test_executedAtAboveBlockTimePlusOneHourIsRefused() public {
        uint64 tooLate = NOW + 1 hours + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                MoolamLookalikes.ReportFromTheFuture.selector, passportId, tooLate, uint256(NOW) + 1 hours
            )
        );
        _deliver(_payload(passportId, earlierId, tooLate));

        vm.expectRevert(
            abi.encodeWithSelector(
                MoolamLookalikes.ReportFromTheFuture.selector, passportId, type(uint64).max, uint256(NOW) + 1 hours
            )
        );
        _deliver(_payload(passportId, earlierId, type(uint64).max));
        _assertNothingStored(passportId);

        _deliver(_payload(passportId, earlierId, NOW + 1 hours));
        assertEq(lookalikes.originOf(passportId).executedAt, NOW + 1 hours);
    }

    function test_aGoodReportIsStoredAndEmitted() public {
        vm.warp(NOW + 30);
        bytes memory payload = abi.encode(KIND, block.chainid, NOW, passportId, earlierId, uint16(4), uint16(17), true);

        vm.expectEmit(true, true, false, true, address(lookalikes));
        emit LookalikeChecked(passportId, earlierId, 4, 17, true, NOW);
        _deliver(payload);

        MoolamLookalikes.Lookalike memory r = lookalikes.originOf(passportId);
        assertEq(r.earlierId, earlierId);
        assertEq(r.phashDistance, 4);
        assertEq(r.blockhashDistance, 17);
        assertTrue(r.earlierSealed);
        assertEq(r.executedAt, NOW);
        assertEq(r.writtenAt, NOW + 30);
    }

    function test_aNewerReportReplacesTheRecord() public {
        _deliver(_payload(passportId, earlierId, NOW));

        vm.warp(NOW + 600);
        vm.expectEmit(true, true, false, true, address(lookalikes));
        emit LookalikeChecked(passportId, bytes32(0), 0, 0, false, NOW + 600);
        _deliver(abi.encode(KIND, block.chainid, NOW + 600, passportId, bytes32(0), uint16(0), uint16(0), false));

        MoolamLookalikes.Lookalike memory r = lookalikes.originOf(passportId);
        assertEq(r.earlierId, bytes32(0));
        assertEq(r.phashDistance, 0);
        assertEq(r.blockhashDistance, 0);
        assertEq(r.executedAt, NOW + 600);
        assertEq(r.writtenAt, NOW + 600);
    }

    function test_itTakesNoMoneyAndAnswersNoUnknownCall() public {
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        (bool sentValue,) = address(lookalikes).call{value: 1 wei}("");
        assertFalse(sentValue);

        vm.prank(stranger);
        (bool unknownCall,) = address(lookalikes).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(unknownCall);

        assertEq(address(lookalikes).balance, 0);
    }

    function test_onceRenouncedNoSetterCanRepointTheReceiver() public {
        lookalikes.renounceOwnership();
        assertEq(lookalikes.owner(), address(0));

        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(notOwner);
        lookalikes.setForwarderAddress(stranger);
        vm.expectRevert(notOwner);
        lookalikes.setExpectedAuthor(stranger);
        vm.expectRevert(notOwner);
        lookalikes.setExpectedWorkflowName("");
        vm.expectRevert(notOwner);
        lookalikes.setExpectedWorkflowId(bytes32(uint256(1)));

        assertEq(lookalikes.getForwarderAddress(), forwarder);
        assertEq(lookalikes.getExpectedAuthor(), WORKFLOW_OWNER);
        assertEq(lookalikes.getExpectedWorkflowName(), WORKFLOW_NAME_PIN);
    }
}

contract MoolamLookalikesFuzzTest is MoolamLookalikesSetup {
    function testFuzz_aPayloadWithoutTheKindWordIsRefused(bytes memory payload) public {
        vm.assume(payload.length < 32 || bytes32(payload) != KIND);

        vm.prank(forwarder);
        vm.expectRevert();
        lookalikes.onReport(_metadata(), payload);
    }

    function testFuzz_executedAtIsAcceptedOnlyAboveTheFloorAndWithinTheSkew(
        uint64 blockTime,
        uint64 floor,
        uint64 executedAt
    ) public {
        blockTime = uint64(bound(blockTime, 1, type(uint64).max - 2 hours));
        vm.warp(blockTime);
        uint256 latest = uint256(blockTime) + 1 hours;

        floor = uint64(bound(floor, 0, latest));
        if (floor != 0) _deliver(_payload(passportId, earlierId, floor));

        bool accepted = executedAt > floor && executedAt <= latest;
        if (!accepted) {
            vm.expectRevert();
        } else {
            vm.expectEmit(true, true, false, true, address(lookalikes));
            emit LookalikeChecked(passportId, bytes32(0), 3, 12, false, executedAt);
        }
        _deliver(_payload(passportId, bytes32(0), executedAt));

        assertEq(lookalikes.originOf(passportId).executedAt, accepted ? executedAt : floor);
    }

    function testFuzz_aGoodReportStoresExactlyWhatItCarried(
        bytes32 id,
        bytes32 earlier,
        uint16 phashDistance,
        uint16 blockhashDistance,
        bool earlierSealed,
        uint64 executedAt
    ) public {
        vm.assume(id != bytes32(0) && earlier != id);
        executedAt = uint64(bound(executedAt, 1, uint256(NOW) + 1 hours));

        _deliver(
            abi.encode(KIND, block.chainid, executedAt, id, earlier, phashDistance, blockhashDistance, earlierSealed)
        );

        MoolamLookalikes.Lookalike memory r = lookalikes.originOf(id);
        assertEq(r.earlierId, earlier);
        assertEq(r.phashDistance, phashDistance);
        assertEq(r.blockhashDistance, blockhashDistance);
        assertEq(r.earlierSealed, earlierSealed);
        assertEq(r.executedAt, executedAt);
        assertEq(r.writtenAt, NOW);
    }
}

contract LookalikesHandler is Test {
    MoolamLookalikes public immutable LOOKALIKES;
    address public immutable FORWARDER;
    bytes public metadata;

    bytes32 internal constant KIND = keccak256("moolam.lookalike.v1");
    // Three passports, so random calls collide on the same floor often.
    bytes32[3] internal ids = [keccak256("p0"), keccak256("p1"), keccak256("p2")];

    mapping(bytes32 passportId => uint64 floor) public highestAccepted;
    uint256 public floorDrops;
    uint256 public futureFloors;
    uint256 public accepted;

    constructor(MoolamLookalikes lookalikes, address forwarder, bytes memory metadata_) {
        LOOKALIKES = lookalikes;
        FORWARDER = forwarder;
        metadata = metadata_;
    }

    function passport(uint256 i) external view returns (bytes32) {
        return ids[i];
    }

    function report(uint256 which, uint64 executedAt, bytes32 earlier, uint32 advance) external {
        bytes32 id = ids[which % 3];
        vm.warp(block.timestamp + (advance % 2 hours));
        // Around the block time, so calls land on both sides of the floor and of the skew.
        executedAt = uint64(bound(executedAt, block.timestamp - 3 hours, block.timestamp + 2 hours));

        uint64 before = LOOKALIKES.originOf(id).executedAt;
        vm.prank(FORWARDER);
        try LOOKALIKES.onReport(
            metadata, abi.encode(KIND, block.chainid, executedAt, id, earlier, uint16(1), uint16(2), false)
        ) {
            accepted++;
            highestAccepted[id] = executedAt;
            if (executedAt > block.timestamp + 1 hours) futureFloors++;
        } catch {}
        if (LOOKALIKES.originOf(id).executedAt < before) floorDrops++;
    }
}

contract MoolamLookalikesInvariantTest is MoolamLookalikesSetup {
    LookalikesHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new LookalikesHandler(lookalikes, forwarder, _metadata());
        targetContract(address(handler));
    }

    function invariant_theFloorPerPassportNeverGoesDown() public view {
        assertEq(handler.floorDrops(), 0);
        for (uint256 i = 0; i < 3; ++i) {
            bytes32 id = handler.passport(i);
            assertEq(lookalikes.originOf(id).executedAt, handler.highestAccepted(id));
        }
    }

    // Checked once per run, not before the first call, so a run that refused everything fails.
    function afterInvariant() public view {
        assertGt(handler.accepted(), 0);
    }

    function invariant_noFloorIsEverSetBeyondTheSkew() public view {
        assertEq(handler.futureFloors(), 0);
    }
}
