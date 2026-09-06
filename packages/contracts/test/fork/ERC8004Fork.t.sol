// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// What this file does NOT cover: Monad's own P-256 implementation. Foundry 1.8.1 answers calls to
// 0x0100 with its own RIP-7212 precompile (measured: one P256.verify costs 7,831 gas here, which is
// the precompile price, not the roughly 190,000 gas of OpenZeppelin's Solidity fallback), so the
// passkey path is exercised but against Foundry's implementation, and only a real mainnet
// transaction runs Monad's. It also does not cover the Chainlink forwarder, which is proven by a
// workflow simulation, and it does not spend real MON: every call here runs against a local fork of
// Monad mainnet state.

import {Test, console2} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {MoolamRegistry} from "../../src/MoolamRegistry.sol";
import {MoolamReceiver} from "../../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";
import {Kind, PassportInput, Passport} from "../../src/interfaces/IMoolamRegistry.sol";
import {WebAuthnFixture} from "../utils/WebAuthnFixture.sol";

/// @notice The slice of the canonical ERC-8004 Identity Registry this project uses. The live
///         contract overloads register three ways; only the one argument form is declared here.
interface IAgentIdentity {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
    function name() external view returns (string memory);
}

contract ERC8004ForkTest is Test {
    /// @dev The ERC-8004 Identity Registry Monad's own docs point builders at, on chain 143.
    address internal constant AGENT_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    /// @dev The production Chainlink KeystoneForwarder on Monad mainnet.
    address internal constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    uint256 internal constant BOND = 1 ether;

    MoolamRegistry internal registry;
    VerifierPolicy internal policy;
    MoolamReceiver internal moolamReceiver;
    IAgentIdentity internal agents;

    address internal owner = makeAddr("owner");
    address internal resolver = makeAddr("resolver");
    address internal treasury = makeAddr("treasury");

    uint256 internal agentOwnerKey = 0xA6E17;
    uint256 internal passkeyKey = 0x5EEDBEEF;
    uint256 internal impostorKey = 0xBADF00D;
    address internal agentOwner;
    address internal impostor;

    uint256 internal agentId;

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

        agents = IAgentIdentity(AGENT_IDENTITY);
        agentOwner = vm.addr(agentOwnerKey);
        impostor = vm.addr(impostorKey);

        policy = new VerifierPolicy(owner, resolver, treasury, BOND);
        registry = new MoolamRegistry(owner, address(policy), AGENT_IDENTITY);
        moolamReceiver = new MoolamReceiver(FORWARDER, address(registry));

        vm.startPrank(owner);
        policy.bootstrapAddReceiver(address(moolamReceiver));
        policy.finalizeBootstrap();
        vm.stopPrank();

        vm.prank(agentOwner);
        agentId = agents.register(_agentCard());

        (bytes32 qx, bytes32 qy) = WebAuthnFixture.publicKey(passkeyKey);
        bytes32 bindDigest = registry.hashBind(agentOwner, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory bindAuth = WebAuthnFixture.sign(passkeyKey, bindDigest);
        vm.prank(agentOwner);
        registry.bindPasskey(qx, qy, bindAuth);
    }

    /// @dev A minimal ERC-8004 registration file, inline as a data URI so the fork test does not
    ///      depend on IPFS being reachable.
    function _agentCard() internal pure returns (string memory) {
        return string.concat(
            'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",',
            '"name":"Moolam fork test agent",',
            '"description":"A throwaway agent registered inside a local fork of Monad mainnet.",',
            '"services":[],"active":true}'
        );
    }

    function _input(bytes32 exactHash, uint256 generatorAgentId) internal view returns (PassportInput memory p) {
        p = PassportInput({
            exactHash: exactHash,
            parentId: bytes32(0),
            creator: agentOwner,
            generatorAgentId: generatorAgentId,
            phash: 0x336b806a7e894e76,
            blockhash256: keccak256("fork-block-hash"),
            manifestHash: keccak256("fork-manifest"),
            kind: Kind.Generated,
            fingerprintVersion: 1,
            metadataURI: "ipfs://moolam-fork-test",
            // forge-lint: disable-next-line(unsafe-typecast)
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function test_theCanonicalRegistryIsLiveAndIsWhatTheContractReads() public view {
        assertGt(AGENT_IDENTITY.code.length, 0);
        assertEq(agents.name(), "AgentIdentity");
        assertEq(registry.agentIdentity(), AGENT_IDENTITY);
        assertEq(address(moolamReceiver.REGISTRY()), address(registry));
        assertEq(moolamReceiver.getForwarderAddress(), FORWARDER);
    }

    function test_aRealAgentIsMintedAndOwnedByTheWalletThatRegisteredIt() public view {
        assertGt(agentId, 0);
        assertEq(agents.ownerOf(agentId), agentOwner);
        console2.log("agent id minted on the canonical registry:", agentId);
    }

    function test_aGeneratedPassportSignedByTheRealAgentOwnerLands() public {
        PassportInput memory p = _input(keccak256("fork-generated-image"), agentId);
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, digest);

        uint256 tokenId = registry.register(p, auth, agentSig);

        Passport memory stored = registry.getPassport(p.exactHash);
        assertEq(tokenId, uint256(p.exactHash));
        assertEq(registry.ownerOf(tokenId), agentOwner);
        assertEq(stored.generatorAgentId, agentId);
        assertEq(uint8(stored.kind), uint8(Kind.Generated));
        // The claim only stands because the wallet that owns the agent on the canonical registry
        // signed the image digest. Read that owner back from their contract, not from ours.
        assertEq(agents.ownerOf(stored.generatorAgentId), registry.ownerOf(tokenId));
    }

    function test_anAgentIdThatDoesNotExistOnTheCanonicalRegistryIsRefused() public {
        uint256 ghostAgentId = type(uint96).max;
        PassportInput memory p = _input(keccak256("fork-ghost-agent"), ghostAgentId);
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory agentSig = WebAuthnFixture.signAsAgent(agentOwnerKey, digest);

        vm.expectRevert(abi.encodeWithSelector(MoolamRegistry.UnknownAgent.selector, ghostAgentId));
        // forge-lint: disable-next-line(unused-return)
        registry.register(p, auth, agentSig);
    }

    function test_aSignatureFromAWalletThatDoesNotOwnTheAgentIsRefused() public {
        PassportInput memory p = _input(keccak256("fork-impostor"), agentId);
        bytes32 digest = registry.hashPassport(p);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnFixture.sign(passkeyKey, digest);
        bytes memory impostorSig = WebAuthnFixture.signAsAgent(impostorKey, digest);

        assertTrue(agents.ownerOf(agentId) != impostor);

        vm.expectRevert(MoolamRegistry.InvalidGeneratorSignature.selector);
        // forge-lint: disable-next-line(unused-return)
        registry.register(p, auth, impostorSig);
    }
}
