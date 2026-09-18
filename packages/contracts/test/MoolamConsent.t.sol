// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: time queries against random sequences of writes, which the fuzz
// file proves against a plain reference model; the ordering of many writers and transfers against
// each other, which the invariant file owns; and the real passport registry on Monad mainnet,
// which the fork file reads. The registry here is the project's ERC-721 stand-in, because the only
// behaviour this contract asks of the registry is ownerOf, including the revert on an id nobody
// holds.

import {Test} from "forge-std/Test.sol";

import {MoolamConsent} from "../src/MoolamConsent.sol";
import {IMoolamConsent} from "../src/interfaces/IMoolamConsent.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";

contract MoolamConsentTest is Test {
    MoolamConsent internal consent;
    MockAgentIdentity internal registry;

    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    address internal marketplace = makeAddr("marketplace");

    bytes32 internal constant PASSPORT = keccak256("a picture someone took");
    bytes32 internal constant UNMINTED = keccak256("a picture nobody registered");
    uint64 internal constant START = 1_700_000_000;

    function setUp() public {
        vm.warp(START);
        registry = new MockAgentIdentity();
        registry.mint(holder, uint256(PASSPORT));
        consent = new MoolamConsent(address(registry));
    }

    function _state(
        IMoolamConsent.Use aiTraining,
        IMoolamConsent.Use aiGenerativeTraining,
        IMoolamConsent.Use aiInference,
        IMoolamConsent.Use dataMining
    ) internal pure returns (IMoolamConsent.Consent memory) {
        return IMoolamConsent.Consent({
            aiTraining: aiTraining,
            aiGenerativeTraining: aiGenerativeTraining,
            aiInference: aiInference,
            dataMining: dataMining
        });
    }

    function _notAllowed() internal pure returns (IMoolamConsent.Consent memory) {
        return _state(
            IMoolamConsent.Use.NotAllowed,
            IMoolamConsent.Use.NotAllowed,
            IMoolamConsent.Use.NotAllowed,
            IMoolamConsent.Use.NotAllowed
        );
    }

    function _allowed() internal pure returns (IMoolamConsent.Consent memory) {
        return _state(
            IMoolamConsent.Use.Allowed,
            IMoolamConsent.Use.Allowed,
            IMoolamConsent.Use.Allowed,
            IMoolamConsent.Use.Allowed
        );
    }

    function _unspecified() internal pure returns (IMoolamConsent.Consent memory) {
        return _state(
            IMoolamConsent.Use.Unspecified,
            IMoolamConsent.Use.Unspecified,
            IMoolamConsent.Use.Unspecified,
            IMoolamConsent.Use.Unspecified
        );
    }

    function _constrained() internal pure returns (IMoolamConsent.Consent memory) {
        return _state(
            IMoolamConsent.Use.Constrained,
            IMoolamConsent.Use.NotAllowed,
            IMoolamConsent.Use.Allowed,
            IMoolamConsent.Use.Unspecified
        );
    }

    function _text(uint256 length) internal pure returns (string memory) {
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            out[i] = "a";
        }
        return string(out);
    }

    function test_constructorLocksInTheRegistryAndTheCaps() public view {
        assertEq(consent.REGISTRY(), address(registry));
        assertEq(consent.MIN_INTERVAL(), 600);
        assertEq(consent.MAX_INFO_BYTES(), 256);
        assertEq(consent.MAX_PAGE(), 64);
    }

    function test_constructorRefusesAZeroRegistry() public {
        vm.expectRevert(MoolamConsent.ZeroAddress.selector);
        new MoolamConsent(address(0));
    }

    function test_constructorRefusesARegistryWithNoCode() public {
        vm.expectRevert(MoolamConsent.NotAContract.selector);
        new MoolamConsent(stranger);
    }

    function test_theHolderStatesWhatAiMayDoAndItReadsBack() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertTrue(stated);
        assertEq(latest.at, START);
        assertEq(latest.writer, holder);
        assertEq(uint8(latest.consent.aiTraining), uint8(IMoolamConsent.Use.NotAllowed));
        assertEq(uint8(latest.consent.aiGenerativeTraining), uint8(IMoolamConsent.Use.NotAllowed));
        assertEq(uint8(latest.consent.aiInference), uint8(IMoolamConsent.Use.NotAllowed));
        assertEq(uint8(latest.consent.dataMining), uint8(IMoolamConsent.Use.NotAllowed));
        assertEq(latest.constraintInfo, "");
        assertEq(consent.historyLength(PASSPORT), 1);
    }

    function test_theEventCarriesEverythingThatWasStored() public {
        vm.expectEmit(true, true, true, true, address(consent));
        emit IMoolamConsent.ConsentSet(PASSPORT, holder, 0, _constrained(), "https://moolam.xyz/terms", START);

        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), "https://moolam.xyz/terms");
    }

    function test_theSecondWriteIsEventIndexOne() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");
        vm.warp(START + consent.MIN_INTERVAL());

        vm.expectEmit(true, true, true, true, address(consent));
        emit IMoolamConsent.ConsentSet(PASSPORT, holder, 1, _allowed(), "", START + 600);

        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_aStrangerCannotSpeakForAPassport() public {
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, stranger));
        vm.prank(stranger);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_anAddressApprovedForTheTokenIsRefused() public {
        vm.prank(holder);
        registry.approve(marketplace, uint256(PASSPORT));

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, marketplace));
        vm.prank(marketplace);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_anOperatorApprovedForAllIsRefused() public {
        vm.prank(holder);
        registry.setApprovalForAll(marketplace, true);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, marketplace));
        vm.prank(marketplace);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_aPassportThatWasNeverMintedCannotBeWritten() public {
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, UNMINTED, holder));
        vm.prank(holder);
        consent.setConsent(UNMINTED, _allowed(), "");
    }

    function test_aPassportIdOfZeroCannotBeWritten() public {
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, bytes32(0), holder));
        vm.prank(holder);
        consent.setConsent(bytes32(0), _allowed(), "");
    }

    function test_aBurnedPassportIsRefusedAsNotHeldNotAsAnErc721Error() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        // A burn makes the registry's ownerOf revert for an id that used to have a holder. What
        // matters is that the caller sees this contract's refusal, not another contract's error.
        vm.mockCallRevert(
            address(registry),
            abi.encodeWithSignature("ownerOf(uint256)", uint256(PASSPORT)),
            abi.encodeWithSignature("ERC721NonexistentToken(uint256)", uint256(PASSPORT))
        );

        vm.warp(START + 600);
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, holder));
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_aRegistryThatAnswersWithTheZeroAddressIsRefused() public {
        vm.mockCall(
            address(registry), abi.encodeWithSignature("ownerOf(uint256)", uint256(PASSPORT)), abi.encode(address(0))
        );

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, address(0)));
        vm.prank(address(0));
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_theSameHolderMustWaitTenMinutes() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        vm.warp(START + 599);
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.TooSoon.selector, PASSPORT, START + 600));
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_theSameHolderWritesAgainExactlyOnTheBoundary() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        vm.warp(START + 600);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");

        assertEq(consent.historyLength(PASSPORT), 2);
    }

    function test_aBuyerIsNotMadeToWaitForTheSellersTenMinutes() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        vm.prank(holder);
        registry.transferFrom(holder, buyer, uint256(PASSPORT));

        vm.warp(START + 1);
        vm.prank(buyer);
        consent.setConsent(PASSPORT, _allowed(), "");

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(latest.writer, buyer);
        assertEq(consent.historyLength(PASSPORT), 2);
    }

    function test_aBuyerStillWaitsForTheClockToMove() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        vm.prank(holder);
        registry.transferFrom(holder, buyer, uint256(PASSPORT));

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.TooSoon.selector, PASSPORT, START + 1));
        vm.prank(buyer);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_theOldStatementStandsUntilTheNewHolderChangesIt() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        vm.prank(holder);
        registry.transferFrom(holder, buyer, uint256(PASSPORT));

        (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertTrue(stated);
        assertEq(latest.writer, holder);
        assertEq(uint8(latest.consent.aiTraining), uint8(IMoolamConsent.Use.NotAllowed));
    }

    function test_allFourUnspecifiedTakesAStatementBackWithoutHidingIt() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");

        vm.warp(START + 600);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _unspecified(), "");

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(uint8(latest.consent.aiTraining), uint8(IMoolamConsent.Use.Unspecified));

        IMoolamConsent.Entry[] memory page = consent.historyPage(PASSPORT, 0, 2);
        assertEq(page.length, 2);
        assertEq(uint8(page[0].consent.aiTraining), uint8(IMoolamConsent.Use.Allowed));
    }

    function test_theSameStatementWrittenTwiceIsTwoEntries() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");
        vm.warp(START + 600);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");

        assertEq(consent.historyLength(PASSPORT), 2);
        IMoolamConsent.Entry[] memory page = consent.historyPage(PASSPORT, 0, 2);
        assertEq(page[0].at, START);
        assertEq(page[1].at, START + 600);
    }

    function test_aConstrainedFieldNeedsItsText() public {
        vm.expectRevert(IMoolamConsent.ConstraintInfoRequired.selector);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), "");
    }

    function test_textWithNothingConstrainedIsRefused() public {
        vm.expectRevert(IMoolamConsent.ConstraintInfoNotAllowed.selector);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "https://moolam.xyz/terms");
    }

    function test_textOfExactlyTwoHundredAndFiftySixBytesIsAccepted() public {
        string memory text = _text(256);

        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), text);

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(latest.constraintInfo, text);
    }

    function test_textOneByteTooLongIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.ConstraintInfoTooLong.selector, 257));
        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), _text(257));
    }

    function test_textWithAByteOutsidePrintableAsciiIsRefusedWithItsPosition() public {
        string memory text = string(abi.encodePacked("https://moolam.xyz/", bytes1(0x0a), "terms"));

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.ConstraintInfoNotPrintable.selector, 19));
        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), text);
    }

    function test_theTextIsStoredExactlyAsItWasValidated() public {
        string memory text = "https://moolam.xyz/terms?id=7&lang=ta";

        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), text);

        IMoolamConsent.Entry[] memory page = consent.historyPage(PASSPORT, 0, 1);
        assertEq(page[0].constraintInfo, text);
        assertEq(keccak256(bytes(page[0].constraintInfo)), keccak256(bytes(text)));
    }

    function test_aLaterUnconstrainedStatementCarriesNoText() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _constrained(), "https://moolam.xyz/terms");
        vm.warp(START + 600);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");

        (, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertEq(latest.constraintInfo, "");
        IMoolamConsent.Entry[] memory page = consent.historyPage(PASSPORT, 0, 2);
        assertEq(page[0].constraintInfo, "https://moolam.xyz/terms");
    }

    function test_everyViewAnswersForAPassportNobodyHasSpokenFor() public view {
        (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(UNMINTED);
        assertFalse(stated);
        assertEq(latest.at, 0);
        assertEq(latest.writer, address(0));

        (bool statedThen, IMoolamConsent.Entry memory inForce) = consent.consentAt(UNMINTED, type(uint64).max);
        assertFalse(statedThen);
        assertEq(inForce.at, 0);

        assertEq(consent.historyLength(UNMINTED), 0);
        assertEq(consent.historyPage(UNMINTED, 0, 64).length, 0);
        assertEq(consent.historyPage(UNMINTED, 500, 64).length, 0);
    }

    function test_consentAtAnswersBeforeOnAndAfterEachWrite() public {
        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");
        vm.warp(START + 600);
        vm.prank(holder);
        consent.setConsent(PASSPORT, _allowed(), "");

        (bool before,) = consent.consentAt(PASSPORT, START - 1);
        assertFalse(before);

        (bool onFirst, IMoolamConsent.Entry memory first) = consent.consentAt(PASSPORT, START);
        assertTrue(onFirst);
        assertEq(uint8(first.consent.aiTraining), uint8(IMoolamConsent.Use.NotAllowed));

        (, IMoolamConsent.Entry memory between) = consent.consentAt(PASSPORT, START + 599);
        assertEq(between.at, START);

        (, IMoolamConsent.Entry memory onSecond) = consent.consentAt(PASSPORT, START + 600);
        assertEq(onSecond.at, START + 600);

        (, IMoolamConsent.Entry memory far) = consent.consentAt(PASSPORT, type(uint64).max);
        assertEq(far.at, START + 600);
        assertEq(uint8(far.consent.aiTraining), uint8(IMoolamConsent.Use.Allowed));
    }

    function test_aPageIsClippedToSixtyFourAndToWhatExists() public {
        for (uint256 i = 0; i < 70; ++i) {
            vm.warp(START + i * 600);
            vm.prank(holder);
            consent.setConsent(PASSPORT, _allowed(), "");
        }

        assertEq(consent.historyLength(PASSPORT), 70);
        assertEq(consent.historyPage(PASSPORT, 0, 70).length, 64);
        assertEq(consent.historyPage(PASSPORT, 0, type(uint256).max).length, 64);
        assertEq(consent.historyPage(PASSPORT, 65, 64).length, 5);
        assertEq(consent.historyPage(PASSPORT, 70, 1).length, 0);

        IMoolamConsent.Entry[] memory page = consent.historyPage(PASSPORT, 10, 3);
        assertEq(page.length, 3);
        assertEq(page[0].at, START + 10 * 600);
        assertEq(page[2].at, START + 12 * 600);
    }

    function test_thereIsNoWayToSendMonToThisContract() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        // forge-lint: disable-next-line(unchecked-call)
        (bool ok,) = address(consent).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(consent).balance, 0);
    }

    /// The numbers behind the gas table in proofs/gas.txt. Measured with gasleft around the call,
    /// so each figure carries the call overhead a real transaction pays too. The bounds are loose
    /// on purpose: they are here to catch a change that makes a creator's write cost more, not to
    /// pin a number.
    function test_gasOfTheMainActions() public {
        vm.prank(holder);
        uint256 gas = gasleft();
        consent.setConsent(PASSPORT, _notAllowed(), "");
        uint256 firstWrite = gas - gasleft();

        vm.warp(START + 600);
        vm.prank(holder);
        gas = gasleft();
        consent.setConsent(PASSPORT, _allowed(), "");
        uint256 laterWrite = gas - gasleft();

        gas = gasleft();
        consent.consentAt(PASSPORT, START);
        uint256 readAtTwo = gas - gasleft();

        vm.warp(START + 1200);
        string memory text = _text(256);
        vm.prank(holder);
        gas = gasleft();
        consent.setConsent(PASSPORT, _constrained(), text);
        uint256 writeWithText = gas - gasleft();

        for (uint256 i = 3; i < 16; ++i) {
            vm.warp(START + i * 600);
            vm.prank(holder);
            consent.setConsent(PASSPORT, _allowed(), "");
        }
        gas = gasleft();
        consent.consentAt(PASSPORT, START + 8 * 600);
        uint256 readAtSixteen = gas - gasleft();

        for (uint256 i = 16; i < 256; ++i) {
            vm.warp(START + i * 600);
            vm.prank(holder);
            consent.setConsent(PASSPORT, _allowed(), "");
        }
        gas = gasleft();
        consent.consentAt(PASSPORT, START + 128 * 600);
        uint256 readAtTwoFiftySix = gas - gasleft();

        emit log_named_uint("first write", firstWrite);
        emit log_named_uint("later write", laterWrite);
        emit log_named_uint("write with 256 bytes of text", writeWithText);
        emit log_named_uint("consentAt with 2 entries", readAtTwo);
        emit log_named_uint("consentAt with 16 entries", readAtSixteen);
        emit log_named_uint("consentAt with 256 entries", readAtTwoFiftySix);

        assertLt(firstWrite, 150_000);
        assertLt(laterWrite, 120_000);
        assertLt(writeWithText, 400_000);
        assertLt(readAtTwoFiftySix, 60_000);
    }

    function test_twoPassportsKeepSeparateHistories() public {
        bytes32 second = keccak256("another picture");
        registry.mint(buyer, uint256(second));

        vm.prank(holder);
        consent.setConsent(PASSPORT, _notAllowed(), "");
        vm.prank(buyer);
        consent.setConsent(second, _allowed(), "");

        assertEq(consent.historyLength(PASSPORT), 1);
        assertEq(consent.historyLength(second), 1);

        (, IMoolamConsent.Entry memory one) = consent.consentOf(PASSPORT);
        (, IMoolamConsent.Entry memory two) = consent.consentOf(second);
        assertEq(one.writer, holder);
        assertEq(two.writer, buyer);
    }
}
