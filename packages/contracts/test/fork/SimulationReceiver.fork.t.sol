// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: real MON spent, the CRE simulator, the owner's key (acted as by address), or the launch scripts.

import {Test, console2} from "forge-std/Test.sol";

import {SimulationReceiver} from "../../src/SimulationReceiver.sol";
import {MoolamReceiver} from "../../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";
import {MoolamRegistry} from "../../src/MoolamRegistry.sol";
import {Attestation} from "../../src/interfaces/IMoolamRegistry.sol";

interface IMockForwarder {
    function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata sigs)
        external;
}

contract SimulationReceiverForkTest is Test {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    // Pinned before the live deploy, so setUp replays it against the chain it was sent to.
    uint256 internal constant FORK_BLOCK = 108_102_500;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant PRODUCTION_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant CRE_WALLET = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
    address internal constant OLD_PUBLIC = 0x0d69055c43EAcb3B1ca687ca2263A049Bc7Eff04;
    address internal constant OLD_SEALED = 0x7b9eF7cD5e40Af9c29d8b7d0D22E54B80947E45A;

    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    bytes10 internal constant PUBLIC_NAME = 0x34623863303364663034;
    bytes10 internal constant SEALED_NAME = 0x64323036636163326334;

    bytes32 internal constant MONSOON = 0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638;
    bytes32 internal constant KANCHIPURAM = 0xe83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e4;
    uint64 internal constant MONSOON_EXECUTED_AT = 0x6aa7993e;
    uint64 internal constant KANCHIPURAM_EXECUTED_AT = 0x6ab62401;

    // Calldata of mainnet tx 0x59e6a8d5... (block 104,680,606), the public Monsoon report.
    bytes internal constant MONSOON_CALL = hex"112895650000000000000000000000000d69055c43eacb3b1ca687ca2263a049bc7eff04000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000012d01f1ef8e5967696146960a7c7be866b7cf3c441f417198a4f5ccf10e18b30d58ca000000640000000100000001111111111111111111111111111111111111111111111111111111111111111134623863303364663034aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001000000000000000000000000000000000000000000000000000000000000008f000000000000000000000000000000000000000000000000000000006aa7993ecdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ccf137087789a25000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000041b81220cf4c838783c3f3a7115dfeff6423f9d49d5c6da1bc1032c32f462cc0434e9209c4b44c21a807d5492bbe6521afc1de41afb55a9ba86c1e2ba226f1b038010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000410e2fc70f57c71917e0006d8237f5ce219983a48c69a0b76c56790f280961445478ee24a8bb540f20a1152710807a549207dcf87a76e2d7bb7a93380c43c1abbe00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041f21e57676bb6833d422066cd37a60b091c642ece293c91de3f855ce5a4eaa91b54888ec3ff6c8f9d072b67ba20195c16ae60a68824616202a4f1b3f728df048400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041e00e5747be725ac2dd7b58b952617a60d1afb33d45f66c6478f5fd390881ef4d0f9c1c4f9495b9072c260114964f6a6e5e9f9e3992d10173169093a75edeb1ea0000000000000000000000000000000000000000000000000000000000000000";
    // Calldata of mainnet tx 0xa38fd971... (block 107,834,613), the sealed Kanchipuram report.
    bytes internal constant KANCHIPURAM_CALL = hex"112895650000000000000000000000007b9ef7cd5e40af9c29d8b7d0d22e54b80947e45a000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000012d013b8a964dd1794172608797307b0f254ef99759dfa53ce06d2d61ab0e09be3b0b000000640000000100000001111111111111111111111111111111111111111111111111111111111111111164323036636163326334aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001000000000000000000000000000000000000000000000000000000000000008f000000000000000000000000000000000000000000000000000000006ab62401e83680b22c24e491f91077162804b862a6b821ac74f49b9b2d21a04864c485e40000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000085c0d272787e6e77000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004181d98c3ecf2a04b58d2a27a7e947936e34b7314575d34e88361dfc7a3588d6844543dafdb01d5913fbd2fe31f8d66b6a1b3113dcfb8bd014b83ac211e9ed45810000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004111aa8abdeaa348ff3aa1fe6b16eb6087ad7ee73619ba1f46d99344467a4f086e191ddfc89296fa7d0a34d3a520dd0f2dc84a10b463752a5f6f865f2383cc349601000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041075dc85d51de46943a25bae391c04d22e0f8a242fed39fc02177ab6d885943531b508ceec354c1dd95bf492ef235ea7c1e3c6583a88534dc7919d51ea3d3ad27000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000419e3aa280f41713415536f01dae17332d2f2056a4f2ab73c36ea5f7fa419514cc740a21843afb4d0618fb521578d349d10762cb23ad9b951e30c03a7699dfc7fd0100000000000000000000000000000000000000000000000000000000000000";

    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    VerifierPolicy internal policy = VerifierPolicy(POLICY);
    MoolamRegistry internal registry = MoolamRegistry(REGISTRY);
    SimulationReceiver internal publicReceiver;
    SimulationReceiver internal sealedReceiver;
    bytes32 internal publicChange;
    bytes32 internal sealedChange;
    address internal policyOwner;
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("Skipped: MONAD_MAINNET_RPC_URL is not set, so there is no Monad mainnet to fork.");
            vm.skip(true);
            return;
        }
        // forge-lint: disable-next-line(unused-return)
        vm.createSelectFork(rpc, FORK_BLOCK);
        assertEq(block.chainid, MONAD_MAINNET_CHAIN_ID, "the RPC is not Monad mainnet");
        policyOwner = policy.owner();

        // The same steps, in the same order, as script/DeploySimulationReceivers.s.sol.
        vm.startPrank(policyOwner, policyOwner);
        publicReceiver = new SimulationReceiver(MOCK_FORWARDER, REGISTRY, CRE_WALLET);
        sealedReceiver = new SimulationReceiver(MOCK_FORWARDER, REGISTRY, CRE_WALLET);
        _pin(publicReceiver, "moolam-verifier");
        _pin(sealedReceiver, "moolam-sealed-verifier");
        publicChange = policy.queueAddReceiver(address(publicReceiver));
        sealedChange = policy.queueAddReceiver(address(sealedReceiver));
        policy.removeReceiver(OLD_PUBLIC);
        policy.removeReceiver(OLD_SEALED);
        vm.stopPrank();
    }

    function test_theRealReportHeadersCarryExactlyThePinnedStamps() public view {
        (, bytes memory monsoonRaw,,) = _decode(MONSOON_CALL);
        (, bytes memory kanchipuramRaw,,) = _decode(KANCHIPURAM_CALL);

        _assertHeader(monsoonRaw, publicReceiver, PUBLIC_NAME);
        _assertHeader(kanchipuramRaw, sealedReceiver, SEALED_NAME);

        assertEq(publicReceiver.getForwarderAddress(), MOCK_FORWARDER);
        assertEq(sealedReceiver.getForwarderAddress(), MOCK_FORWARDER);
        assertEq(publicReceiver.SENDING_WALLET(), CRE_WALLET);
        assertEq(sealedReceiver.SENDING_WALLET(), CRE_WALLET);
        assertEq(address(publicReceiver.REGISTRY()), REGISTRY);
        assertEq(address(sealedReceiver.REGISTRY()), REGISTRY);
        assertEq(address(publicReceiver).codehash, address(sealedReceiver).codehash);
    }

    function test_theNewReceiversAreRefusedUntilThePolicyListsThem() public {
        assertFalse(policy.isReceiver(address(publicReceiver)));
        assertEq(policy.getPendingChange(publicChange).executeAfter, block.timestamp + policy.CHANGE_DELAY());

        vm.prank(MOCK_FORWARDER, CRE_WALLET);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, address(publicReceiver)));
        publicReceiver.onReport(_metadata(MONSOON_CALL), _payload(MONSOON_CALL));
    }

    function test_theMonsoonReportReAimedAtTheNewPublicReceiverLandsFromTheCreWallet() public {
        _list();
        uint256 before = registry.attestationCount(MONSOON);

        vm.expectEmit(true, false, false, true, MOCK_FORWARDER);
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(address(publicReceiver), bytes32(0), bytes2(0), true);
        uint256 gasUsed = _replayMetered(MONSOON_CALL, publicReceiver, CRE_WALLET);
        console2.log("gas for one public report through the mock to the new receiver:", gasUsed);

        assertEq(registry.attestationCount(MONSOON), before + 1);
        Attestation memory landed = registry.getAttestations(MONSOON, before, 1)[0];
        assertEq(landed.receiver, address(publicReceiver));
        assertTrue(landed.matched);
        assertEq(publicReceiver.lastExecutedAt(MONSOON), MONSOON_EXECUTED_AT);
    }

    function test_theKanchipuramReportReAimedAtTheNewSealedReceiverLandsFromTheCreWallet() public {
        _list();
        uint256 before = registry.attestationCount(KANCHIPURAM);

        vm.expectEmit(true, false, false, true, MOCK_FORWARDER);
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(address(sealedReceiver), bytes32(0), bytes2(0), true);
        uint256 gasUsed = _replayMetered(KANCHIPURAM_CALL, sealedReceiver, CRE_WALLET);
        console2.log("gas for one sealed report through the mock to the new receiver:", gasUsed);

        assertEq(registry.attestationCount(KANCHIPURAM), before + 1);
        assertEq(registry.getAttestations(KANCHIPURAM, before, 1)[0].receiver, address(sealedReceiver));
        assertEq(sealedReceiver.lastExecutedAt(KANCHIPURAM), KANCHIPURAM_EXECUTED_AT);
    }

    // The mock swallows the receiver's revert, so only the event and the state show the refusal.
    function test_theSameReplaysFromAnyOtherWalletWriteNothing() public {
        _list();
        uint256 monsoonBefore = registry.attestationCount(MONSOON);
        uint256 kanchipuramBefore = registry.attestationCount(KANCHIPURAM);

        vm.expectEmit(true, false, false, true, MOCK_FORWARDER);
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(address(publicReceiver), bytes32(0), bytes2(0), false);
        _replay(MONSOON_CALL, publicReceiver, stranger);

        vm.expectEmit(true, false, false, true, MOCK_FORWARDER);
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(address(sealedReceiver), bytes32(0), bytes2(0), false);
        _replay(KANCHIPURAM_CALL, sealedReceiver, stranger);

        _replay(MONSOON_CALL, publicReceiver, policyOwner);

        vm.prank(MOCK_FORWARDER, stranger);
        vm.expectRevert(abi.encodeWithSelector(SimulationReceiver.WrongSendingWallet.selector, stranger, CRE_WALLET));
        publicReceiver.onReport(_metadata(MONSOON_CALL), _payload(MONSOON_CALL));

        assertEq(registry.attestationCount(MONSOON), monsoonBefore);
        assertEq(registry.attestationCount(KANCHIPURAM), kanchipuramBefore);
        assertEq(publicReceiver.lastExecutedAt(MONSOON), 0);
        assertEq(sealedReceiver.lastExecutedAt(KANCHIPURAM), 0);
    }

    function test_aPublicReportReAimedAtTheSealedReceiverIsRefusedByItsName() public {
        _list();
        uint256 before = registry.attestationCount(MONSOON);

        vm.expectEmit(true, false, false, true, MOCK_FORWARDER);
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(address(sealedReceiver), bytes32(0), bytes2(0), false);
        _replay(MONSOON_CALL, sealedReceiver, CRE_WALLET);

        assertEq(registry.attestationCount(MONSOON), before);
    }

    function test_theOldReceiversAreRefusedByTheRegistryAfterRemoval() public {
        assertFalse(policy.isReceiver(OLD_PUBLIC));
        assertFalse(policy.isReceiver(OLD_SEALED));
        assertEq(MoolamReceiver(OLD_PUBLIC).getForwarderAddress(), PRODUCTION_FORWARDER);

        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory report = abi.encode(block.chainid, uint64(block.timestamp), MONSOON, true, uint16(0), bytes32(0));

        vm.prank(PRODUCTION_FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, OLD_PUBLIC));
        MoolamReceiver(OLD_PUBLIC).onReport(_prodMetadata(PUBLIC_NAME), report);

        vm.prank(PRODUCTION_FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.NotReceiver.selector, OLD_SEALED));
        MoolamReceiver(OLD_SEALED).onReport(_prodMetadata(SEALED_NAME), report);
    }

    function _pin(SimulationReceiver r, string memory name) internal {
        r.setExpectedAuthor(SIM_OWNER);
        r.setExpectedWorkflowName(name);
        r.setExpectedWorkflowId(SIM_WORKFLOW_ID);
    }

    function _list() internal {
        vm.warp(block.timestamp + policy.CHANGE_DELAY());
        vm.startPrank(policyOwner);
        policy.execute(publicChange);
        policy.execute(sealedChange);
        vm.stopPrank();
        assertTrue(policy.isReceiver(address(publicReceiver)));
        assertTrue(policy.isReceiver(address(sealedReceiver)));
    }

    function _replay(bytes memory call, SimulationReceiver target, address origin) internal {
        (, bytes memory raw, bytes memory context, bytes[] memory sigs) = _decode(call);
        vm.prank(origin, origin);
        IMockForwarder(MOCK_FORWARDER).report(address(target), raw, context, sigs);
    }

    // Excludes the transaction's base and calldata cost.
    function _replayMetered(bytes memory call, SimulationReceiver target, address origin)
        internal
        returns (uint256 gasUsed)
    {
        (, bytes memory raw, bytes memory context, bytes[] memory sigs) = _decode(call);
        vm.prank(origin, origin);
        uint256 start = gasleft();
        IMockForwarder(MOCK_FORWARDER).report(address(target), raw, context, sigs);
        gasUsed = start - gasleft();
    }

    function _decode(bytes memory call)
        internal
        pure
        returns (address receiver, bytes memory raw, bytes memory context, bytes[] memory sigs)
    {
        return abi.decode(_slice(call, 4, call.length), (address, bytes, bytes, bytes[]));
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = b[from + i];
        }
    }

    function _metadata(bytes memory call) internal pure returns (bytes memory) {
        (, bytes memory raw,,) = _decode(call);
        return _slice(raw, 45, 109);
    }

    function _payload(bytes memory call) internal pure returns (bytes memory) {
        (, bytes memory raw,,) = _decode(call);
        return _slice(raw, 109, raw.length);
    }

    function _prodMetadata(bytes10 name) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), name, CRE_WALLET, bytes2(0));
    }

    function _assertHeader(bytes memory raw, SimulationReceiver r, bytes10 name) internal view {
        assertEq(_slice(raw, 45, 77), abi.encodePacked(SIM_WORKFLOW_ID));
        assertEq(_slice(raw, 77, 87), abi.encodePacked(name));
        assertEq(_slice(raw, 87, 107), abi.encodePacked(SIM_OWNER));
        assertEq(r.getExpectedWorkflowId(), SIM_WORKFLOW_ID);
        assertEq(r.getExpectedWorkflowName(), name);
        assertEq(r.getExpectedAuthor(), SIM_OWNER);
    }
}
