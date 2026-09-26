// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Does NOT cover: Monad's own P-256 (Foundry answers 0x0100 itself), the Chainlink forwarder, or real MON spent.

import {Test, console2} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

import {MoolamRegistry} from "../../src/MoolamRegistry.sol";
import {MoolamReceiver} from "../../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../../src/VerifierPolicy.sol";
import {Kind, PassportInput, Passport} from "../../src/interfaces/IMoolamRegistry.sol";
import {WebAuthnFixture} from "../utils/WebAuthnFixture.sol";

// The slice of the ERC-8004 Identity Registry this test uses.
interface IAgentIdentity {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
    function name() external view returns (string memory);
}

contract ERC8004ForkTest is Test {
    // The ERC-8004 Identity Registry Monad's docs point builders at, on chain 143.
    address internal constant AGENT_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
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
    address internal creWallet = makeAddr("creWallet");

    string internal constant WORKFLOW_NAME = "moolam-verifier";

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
        // Same two calls the deploy script makes right after `new`, author first.
        moolamReceiver.setExpectedAuthor(creWallet);
        moolamReceiver.setExpectedWorkflowName(WORKFLOW_NAME);

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
        assertEq(moolamReceiver.getExpectedAuthor(), creWallet);
        assertTrue(moolamReceiver.getExpectedWorkflowName() != bytes10(0));
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
        // The agent owner is read back from the canonical registry, not from ours.
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
