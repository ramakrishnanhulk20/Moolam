// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: exact revert reasons (unit file) or the shape of the constraint text (fuzz file).

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {MoolamConsent} from "../src/MoolamConsent.sol";
import {IMoolamConsent} from "../src/interfaces/IMoolamConsent.sol";
import {MockAgentIdentity} from "./mocks/MockAgentIdentity.sol";

contract ConsentHandler is Test {
    MoolamConsent public consent;
    MockAgentIdentity public registry;

    uint256 internal constant ACTOR_COUNT = 3;
    uint256 internal constant PASSPORT_COUNT = 3;

    address[] public actors;
    bytes32[] public passports;

    mapping(bytes32 passportId => mapping(uint256 index => bytes32 fingerprint)) public entryHash;
    mapping(bytes32 passportId => uint256 length) public lengthSeen;
    mapping(bytes32 passportId => address writer) public lastWriter;

    uint256 public writesByANonHolder;
    uint256 public writesLanded;
    uint256 public monAccepted;

    constructor(MoolamConsent consent_, MockAgentIdentity registry_) {
        consent = consent_;
        registry = registry_;

        for (uint256 i = 0; i < ACTOR_COUNT; ++i) {
            actors.push(vm.addr(0x2000 + i));
            vm.deal(actors[i], 10 ether);
        }
        for (uint256 i = 0; i < PASSPORT_COUNT; ++i) {
            bytes32 id = keccak256(abi.encode("passport", i));
            passports.push(id);
            registry.mint(actors[i % ACTOR_COUNT], uint256(id));
        }
    }

    function actorCount() external pure returns (uint256) {
        return ACTOR_COUNT;
    }

    function passportCount() external pure returns (uint256) {
        return PASSPORT_COUNT;
    }

    function _state(uint8 raw, bool constrained) internal pure returns (IMoolamConsent.Consent memory) {
        IMoolamConsent.Use use = constrained ? IMoolamConsent.Use.Constrained : IMoolamConsent.Use(raw % 3);
        return IMoolamConsent.Consent({
            aiTraining: use,
            aiGenerativeTraining: IMoolamConsent.Use(raw % 3),
            aiInference: IMoolamConsent.Use((raw / 3) % 3),
            dataMining: IMoolamConsent.Use((raw / 9) % 3)
        });
    }

    function write(uint256 actorSeed, uint256 passportSeed, uint8 raw, bool constrained) external {
        bytes32 id = passports[passportSeed % PASSPORT_COUNT];
        address caller = actors[actorSeed % ACTOR_COUNT];
        address holder = registry.ownerOf(uint256(id));
        string memory text = constrained ? "https://moolam.xyz/terms" : "";

        vm.prank(caller);
        try consent.setConsent(id, _state(raw, constrained), text) {
            if (caller != holder) writesByANonHolder++;
            writesLanded++;
            lastWriter[id] = caller;
            _remember(id);
        } catch {}
    }

    function writeBatch(uint256 actorSeed, uint256 startSeed, uint256 sizeSeed, uint8 raw, bool constrained) external {
        uint256 size = (sizeSeed % PASSPORT_COUNT) + 1;
        uint256 start = startSeed % PASSPORT_COUNT;
        address caller = actors[actorSeed % ACTOR_COUNT];
        string memory text = constrained ? "https://moolam.xyz/terms" : "";

        bytes32[] memory ids = new bytes32[](size);
        address[] memory holders = new address[](size);
        for (uint256 i = 0; i < size; ++i) {
            ids[i] = passports[(start + i) % PASSPORT_COUNT];
            holders[i] = registry.ownerOf(uint256(ids[i]));
        }

        vm.prank(caller);
        try consent.setConsentBatch(ids, _state(raw, constrained), text) {
            for (uint256 i = 0; i < size; ++i) {
                if (caller != holders[i]) writesByANonHolder++;
                writesLanded++;
                lastWriter[ids[i]] = caller;
                _remember(ids[i]);
            }
        } catch {}
    }

    function transfer(uint256 passportSeed, uint256 actorSeed) external {
        bytes32 id = passports[passportSeed % PASSPORT_COUNT];
        address holder = registry.ownerOf(uint256(id));
        address to = actors[actorSeed % ACTOR_COUNT];
        if (to == holder) return;

        vm.prank(holder);
        registry.transferFrom(holder, to, uint256(id));
    }

    function passTime(uint16 step) external {
        vm.warp(block.timestamp + (uint256(step) % 1200) + 1);
    }

    function payTheContract(uint96 amount) external {
        uint256 value = uint256(amount) % 1 ether;
        address payer = actors[0];
        vm.deal(payer, value + 1);

        vm.prank(payer);
        // forge-lint: disable-next-line(unchecked-call)
        (bool ok,) = address(consent).call{value: value}("");
        if (ok && value != 0) monAccepted++;
    }

    // An entry is never rewritten, so a changed fingerprint at a seen index is the bug.
    function _remember(bytes32 id) internal {
        uint256 length = consent.historyLength(id);
        for (uint256 i = lengthSeen[id]; i < length; ++i) {
            entryHash[id][i] = keccak256(abi.encode(consent.historyPage(id, i, 1)[0]));
        }
        lengthSeen[id] = length;
    }
}

contract MoolamConsentInvariantsTest is StdInvariant, Test {
    MoolamConsent internal consent;
    MockAgentIdentity internal registry;
    ConsentHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        registry = new MockAgentIdentity();
        consent = new MoolamConsent(address(registry));
        handler = new ConsentHandler(consent, registry);

        targetContract(address(handler));
        excludeSender(address(consent));
        excludeSender(address(registry));
    }

    function invariant_historyOnlyGrows() public view {
        uint256 total;
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            uint256 length = consent.historyLength(id);
            assertGe(length, handler.lengthSeen(id));
            total += length;
        }
        assertEq(total, handler.writesLanded());
    }

    function invariant_anEntryOnceWrittenNeverChanges() public view {
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            uint256 seen = handler.lengthSeen(id);
            for (uint256 j = 0; j < seen; ++j) {
                assertEq(keccak256(abi.encode(consent.historyPage(id, j, 1)[0])), handler.entryHash(id, j));
            }
        }
    }

    function invariant_timestampsStrictlyIncrease() public view {
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            uint256 length = consent.historyLength(id);
            uint64 previous = 0;
            for (uint256 start = 0; start < length; start += consent.MAX_PAGE()) {
                IMoolamConsent.Entry[] memory page = consent.historyPage(id, start, consent.MAX_PAGE());
                for (uint256 j = 0; j < page.length; ++j) {
                    assertGt(page[j].at, previous);
                    previous = page[j].at;
                }
            }
        }
    }

    function invariant_theWriterHeldThePassport() public view {
        assertEq(handler.writesByANonHolder(), 0);

        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(id);
            if (!stated) continue;
            assertEq(latest.writer, handler.lastWriter(id));
        }
    }

    function invariant_theContractHoldsNothing() public view {
        assertEq(address(consent).balance, 0);
        assertEq(handler.monAccepted(), 0);
    }

    function invariant_theLatestEntryIsTheOneInForce() public view {
        uint256 count = handler.passportCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = handler.passports(i);
            (bool stated, IMoolamConsent.Entry memory latest) = consent.consentOf(id);
            // forge-lint: disable-next-line(unsafe-typecast)
            (bool statedNow, IMoolamConsent.Entry memory now_) = consent.consentAt(id, uint64(block.timestamp));
            assertEq(statedNow, stated);
            if (!stated) continue;
            assertEq(now_.at, latest.at);
            assertEq(now_.writer, latest.writer);
        }
    }
}
