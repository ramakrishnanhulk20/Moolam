// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: the exact revert reason of the holder check, which the unit file
// owns, and the ordering of writes against transfers over a long run, which the invariant file
// drives. Here one behaviour at a time is pushed against a plain model written out in the test: a
// linear scan for the time query, and the printable byte rule spelled out again by hand.

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

    /// A write at now plus gap. A gap under ten minutes is handed to the other holder first, which
    /// is exactly what the contract asks for and keeps the sequence realistic.
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

    /// The model: walk every entry in order and keep the last one written at or before the query.
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

    /// The contract's binary search must answer exactly what a linear scan answers, at every
    /// boundary, one second before the first entry, and far past the last one.
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

    /// The latest entry and the entry in force at the latest timestamp are the same entry.
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

    /// Any byte string at all, judged by the rule written out again here: empty is refused, longer
    /// than 256 is refused with its length, the first byte outside 0x20 to 0x7E is refused with its
    /// position, and anything else lands and reads back byte for byte.
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

    /// Every all printable string up to 256 bytes is accepted when a field is Constrained.
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

    /// Nobody but the address the registry names may write, whoever they are.
    function testFuzz_onlyTheHolderEverWrites(address caller) public {
        vm.assume(caller != holderA);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, caller));
        vm.prank(caller);
        consent.setConsent(PASSPORT, _state(1), "");
    }

    /// No passport other than a minted one can ever be written, whatever id is tried.
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
