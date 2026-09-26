// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: exact revert reasons of the holder check (unit file) or long write and transfer runs (invariants).

import {Test} from "forge-std/Test.sol";

import {MoolamConsent} from "../src/MoolamConsent.sol";
import {IMoolamConsent} from "../src/interfaces/IMoolamConsent.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";

contract MoolamConsentFuzzTest is Test {
    MoolamConsent internal consent;
    MockAgentIdentity internal registry;

    address internal holderA = makeAddr("holderA");
    address internal holderB = makeAddr("holderB");
    address internal current;

    bytes32 internal constant PASSPORT = keccak256("a picture someone took");
    uint64 internal constant START = 1_700_000_000;

    uint64[] internal times;
    uint8[] internal fields;

    function setUp() public {
        vm.warp(START);
        registry = new MockAgentIdentity();
        registry.mint(holderA, uint256(PASSPORT));
        current = holderA;
        consent = new MoolamConsent(address(registry));
    }

    function _state(uint8 raw) internal pure returns (IMoolamConsent.Consent memory) {
        IMoolamConsent.Use use = IMoolamConsent.Use(raw % 3);
        return IMoolamConsent.Consent({aiTraining: use, aiGenerativeTraining: use, aiInference: use, dataMining: use});
    }

    function _constrained() internal pure returns (IMoolamConsent.Consent memory) {
        return IMoolamConsent.Consent({
            aiTraining: IMoolamConsent.Use.Constrained,
            aiGenerativeTraining: IMoolamConsent.Use.Unspecified,
            aiInference: IMoolamConsent.Use.Unspecified,
            dataMining: IMoolamConsent.Use.Unspecified
        });
    }

    // A gap under MIN_INTERVAL hands the passport to the other holder first, as the contract requires.
    function _write(uint64 gap, uint8 raw) internal {
        uint64 at = uint64(block.timestamp) + gap;
        vm.warp(at);

        if (gap < consent.MIN_INTERVAL()) {
            address next = current == holderA ? holderB : holderA;
            vm.prank(current);
            registry.transferFrom(current, next, uint256(PASSPORT));
            current = next;
        }

        vm.prank(current);
        consent.setConsent(PASSPORT, _state(raw), "");

        times.push(at);
        fields.push(raw % 3);
    }

    function _inForce(uint64 query) internal view returns (bool stated, uint64 at, uint8 field) {
        for (uint256 i = 0; i < times.length; ++i) {
            if (times[i] <= query) {
                stated = true;
                at = times[i];
                field = fields[i];
            }
        }
    }

    function _check(uint64 query) internal view {
        (bool wantStated, uint64 wantAt, uint8 wantField) = _inForce(query);
        (bool gotStated, IMoolamConsent.Entry memory got) = consent.consentAt(PASSPORT, query);

        assertEq(gotStated, wantStated, "stated");
        if (!wantStated) return;
        assertEq(got.at, wantAt, "timestamp");
        assertEq(uint8(got.consent.aiTraining), wantField, "field");
    }

    function testFuzz_consentAtMatchesALinearScan(uint16[8] calldata gaps, uint8[8] calldata raws, uint64 query)
        public
    {
        for (uint256 i = 0; i < 8; ++i) {
            _write(uint64(bound(gaps[i], 1, 4000)), raws[i]);
        }

        _check(START - 1);
        _check(times[0] - 1);
        for (uint256 i = 0; i < times.length; ++i) {
            _check(times[i] - 1);
            _check(times[i]);
            _check(times[i] + 1);
        }
        _check(uint64(bound(query, 0, type(uint64).max)));
        _check(type(uint64).max);

        (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertTrue(stated);
        assertEq(latest.at, times[times.length - 1]);
    }

    function testFuzz_consentOfIsConsentAtTheLastWrite(uint16[4] calldata gaps, uint8[4] calldata raws) public {
        for (uint256 i = 0; i < 4; ++i) {
            _write(uint64(bound(gaps[i], 1, 4000)), raws[i]);
        }

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        (, IMoolamConsent.Entry memory atLatest) = consent.consentAt(PASSPORT, latest.at);
        assertEq(atLatest.at, latest.at);
        assertEq(atLatest.writer, latest.writer);
        assertEq(uint8(atLatest.consent.aiTraining), uint8(latest.consent.aiTraining));
    }

    function testFuzz_theTextRuleIsTheWholeRule(bytes calldata raw) public {
        string memory text = string(raw);

        if (raw.length == 0) {
            vm.expectRevert(IMoolamConsent.ConstraintInfoRequired.selector);
            vm.prank(holderA);
            consent.setConsent(PASSPORT, _constrained(), text);
            return;
        }

        if (raw.length > 256) {
            vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.ConstraintInfoTooLong.selector, raw.length));
            vm.prank(holderA);
            consent.setConsent(PASSPORT, _constrained(), text);
            return;
        }

        (bool clean, uint256 position) = _firstBadByte(raw);
        if (!clean) {
            vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.ConstraintInfoNotPrintable.selector, position));
            vm.prank(holderA);
            consent.setConsent(PASSPORT, _constrained(), text);
            return;
        }

        vm.prank(holderA);
        consent.setConsent(PASSPORT, _constrained(), text);

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(keccak256(bytes(latest.constraintInfo)), keccak256(raw));
    }

    function testFuzz_everyPrintableStringUpToTheCapIsAccepted(uint16 length, bytes32 seed) public {
        uint256 size = bound(length, 1, 256);
        bytes memory text = new bytes(size);
        for (uint256 i = 0; i < size; ++i) {
            text[i] = bytes1(uint8(0x20 + (uint256(uint8(seed[i % 32])) + i) % 95));
        }

        vm.prank(holderA);
        consent.setConsent(PASSPORT, _constrained(), string(text));

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(keccak256(bytes(latest.constraintInfo)), keccak256(text));
    }

    function testFuzz_aBatchWritesOneEntryPerPicture(uint8 count, uint8 raw) public {
        uint256 size = bound(count, 1, 32);
        bytes32[] memory ids = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            ids[i] = keccak256(abi.encode("batch", i));
            registry.mint(holderA, uint256(ids[i]));
        }

        vm.prank(holderA);
        consent.setConsentBatch(ids, _state(raw), "");

        for (uint256 i = 0; i < size; ++i) {
            (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(ids[i]);
            assertTrue(stated);
            assertEq(consent.historyLength(ids[i]), 1);
            assertEq(latest.writer, holderA);
            assertEq(latest.at, uint64(block.timestamp));
            assertEq(uint8(latest.consent.aiTraining), raw % 3);
        }
    }

    function testFuzz_oneRefusalLeavesTheWholeBatchUnwritten(uint8 count, uint8 position) public {
        uint256 size = bound(count, 1, 31);
        uint256 at = bound(position, 0, size);

        bytes32 theirs = keccak256("held by somebody else");
        registry.mint(holderB, uint256(theirs));

        bytes32[] memory ids = new bytes32[](size + 1);
        for (uint256 i = 0; i < size + 1; ++i) {
            if (i == at) {
                ids[i] = theirs;
                continue;
            }
            ids[i] = keccak256(abi.encode("batch", i));
            registry.mint(holderA, uint256(ids[i]));
        }

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, theirs, holderA));
        vm.prank(holderA);
        consent.setConsentBatch(ids, _state(1), "");

        for (uint256 i = 0; i < size + 1; ++i) {
            assertEq(consent.historyLength(ids[i]), 0);
        }
    }

    function testFuzz_onlyTheHolderEverWrites(address caller) public {
        vm.assume(caller != holderA);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, caller));
        vm.prank(caller);
        consent.setConsent(PASSPORT, _state(1), "");
    }

    function testFuzz_anIdNobodyHoldsIsNeverWritable(bytes32 passportId) public {
        vm.assume(passportId != PASSPORT);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, passportId, holderA));
        vm.prank(holderA);
        consent.setConsent(passportId, _state(1), "");
    }

    function _firstBadByte(bytes calldata raw) internal pure returns (bool clean, uint256 position) {
        for (uint256 i = 0; i < raw.length; ++i) {
            uint8 b = uint8(raw[i]);
            if (b < 0x20 || b > 0x7E) return (false, i);
        }
        return (true, 0);
    }
}
