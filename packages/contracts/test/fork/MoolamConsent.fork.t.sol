// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: it sends no real transaction and spends no real MON. Every call
// here runs against a local fork of Monad mainnet state, so it proves the contract against the real
// registry and a real passport with a real holder, not that a mainnet write has happened. The unit,
// fuzz and invariant files own the rules themselves.

import {Test, console2} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {MoolamConsent} from "../../src/MoolamConsent.sol";
import {IMoolamConsent} from "../../src/interfaces/IMoolamConsent.sol";

contract MoolamConsentForkTest is Test {
    /// @dev The deployed Moolam passport registry on Monad mainnet.
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    /// @dev A passport registered on mainnet by the live proof run, held by a real wallet.
    bytes32 internal constant PASSPORT = 0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638;
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;

    MoolamConsent internal consent;
    address internal holder;

    address internal stranger = makeAddr("stranger");
    address internal marketplace = makeAddr("marketplace");

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("Skipped: MONAD_MAINNET_RPC_URL is not set, so there is no Monad mainnet to fork.");
            vm.skip(true);
            return;
        }

        // forge-lint: disable-next-line(unused-return)
        vm.createSelectFork(rpc);
        assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID, "the RPC is not Monad mainnet");

        holder = IERC721(REGISTRY).ownerOf(uint256(PASSPORT));
        consent = new MoolamConsent(REGISTRY);
    }

    function test_theRealRegistryIsLiveAndIsWhatTheContractReads() public view {
        assertGt(REGISTRY.code.length, 0);
        assertEq(consent.REGISTRY(), REGISTRY);
        assertTrue(holder != address(0));
        console2.log("passport holder on Monad mainnet:", holder);
    }

    function test_theRealHolderStatesConsentAndItReadsBack() public {
        IMoolamConsent.Consent memory statement = IMoolamConsent.Consent({
            aiTraining: IMoolamConsent.Use.NotAllowed,
            aiGenerativeTraining: IMoolamConsent.Use.NotAllowed,
            aiInference: IMoolamConsent.Use.Constrained,
            dataMining: IMoolamConsent.Use.Unspecified
        });

        vm.prank(holder);
        consent.setConsent(PASSPORT, statement, "https://moolam.xyz/licence");

        (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(PASSPORT);
        assertTrue(stated);
        assertEq(latest.writer, holder);
        assertEq(latest.writer, IERC721(REGISTRY).ownerOf(uint256(PASSPORT)));
        assertEq(uint8(latest.consent.aiTraining), uint8(IMoolamConsent.Use.NotAllowed));
        assertEq(latest.constraintInfo, "https://moolam.xyz/licence");
        assertEq(consent.historyLength(PASSPORT), 1);

        // forge-lint: disable-next-line(unsafe-typecast)
        (bool statedNow, IMoolamConsent.Entry memory inForce) = consent.consentAt(PASSPORT, uint64(block.timestamp));
        assertTrue(statedNow);
        assertEq(inForce.at, latest.at);

        (bool statedBefore, IMoolamConsent.Entry memory nothing) = consent.consentAt(PASSPORT, latest.at - 1);
        assertFalse(statedBefore);
        assertEq(nothing.at, 0);
    }

    function test_aStrangerCannotSpeakForARealPassport() public {
        assertTrue(stranger != holder);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, stranger));
        vm.prank(stranger);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_anAddressApprovedOnTheRealRegistryIsStillRefused() public {
        vm.prank(holder);
        IERC721(REGISTRY).approve(marketplace, uint256(PASSPORT));
        assertEq(IERC721(REGISTRY).getApproved(uint256(PASSPORT)), marketplace);

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, PASSPORT, marketplace));
        vm.prank(marketplace);
        consent.setConsent(PASSPORT, _allowed(), "");
    }

    function test_aPassportTheRealRegistryHasNeverMintedIsRefused() public {
        bytes32 ghost = keccak256("a picture that was never registered on Monad");

        vm.expectRevert(abi.encodeWithSelector(IMoolamConsent.NotPassportHolder.selector, ghost, holder));
        vm.prank(holder);
        consent.setConsent(ghost, _allowed(), "");
    }

    function _allowed() internal pure returns (IMoolamConsent.Consent memory) {
        return IMoolamConsent.Consent({
            aiTraining: IMoolamConsent.Use.Allowed,
            aiGenerativeTraining: IMoolamConsent.Use.Allowed,
            aiInference: IMoolamConsent.Use.Allowed,
            dataMining: IMoolamConsent.Use.Allowed
        });
    }
}
