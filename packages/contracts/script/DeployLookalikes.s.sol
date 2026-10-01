// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {MoolamLookalikes} from "../src/MoolamLookalikes.sol";
import {MoolamDecisions} from "../src/MoolamDecisions.sol";
import {IMoolamRegistry} from "../src/interfaces/IMoolamRegistry.sol";

/// @title ITypeAndVersion
/// @notice The version string Chainlink's forwarders answer with.
interface ITypeAndVersion {
    /// @notice The contract's type and version, such as "KeystoneForwarder 1.0.0".
    function typeAndVersion() external view returns (string memory);
}

/// @title DeployLookalikes
/// @notice Deploys MoolamLookalikes and MoolamDecisions on Monad mainnet. Pins the look-alike receiver
///         to Chainlink's forwarder, Moolam's workflow owner and workflow name, reads all three back,
///         then renounces its ownership so nobody can re-point it.
/// @dev Forge simulates the whole script before it sends anything, so a failed read-back means no
///      transaction is broadcast at all. Without --broadcast it is a dry run.
contract DeployLookalikes is Script {
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant REGISTRY = 0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0;
    address internal constant POLICY = 0x54e8Ed8c2c3Cf2A36F8B3AC4c7f02acFD2455821;
    address internal constant FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    string internal constant FORWARDER_VERSION = "KeystoneForwarder 1.0.0";
    address internal constant WORKFLOW_OWNER = 0xf072a8c620bFc818875736E3f2d3A2A339c06584;
    string internal constant WORKFLOW_NAME = "moolam-verifier";
    // Written out, not computed, so the read-back checks the template's hashing too.
    bytes10 internal constant WORKFLOW_NAME_PIN = 0x34623863303364663034;

    error WrongChain(uint256 actual, uint256 expected);
    error HasNoCode(address target);
    error NotTheKeystoneForwarder(string typeAndVersion);
    error RegistryPolicyMismatch(address registryPolicy);
    error PinMismatch(string field);
    error StillOwned(address owner);

    /// @notice Deploys from DEPLOYER_PRIVATE_KEY.
    /// @return lookalikes The look-alike receiver, pinned and with ownership renounced.
    /// @return decisions The decisions contract.
    function run() external returns (MoolamLookalikes lookalikes, MoolamDecisions decisions) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _preflight();

        vm.startBroadcast(deployerKey);
        (lookalikes, decisions) = _deployPinRenounce();
        vm.stopBroadcast();

        _print(vm.addr(deployerKey), lookalikes, decisions);
    }

    /// @notice The same steps as `run` for a sender given by address, for a fork rehearsal.
    /// @param deployer The address to act as.
    /// @return lookalikes The look-alike receiver, pinned and with ownership renounced.
    /// @return decisions The decisions contract.
    function deployAs(address deployer) external returns (MoolamLookalikes lookalikes, MoolamDecisions decisions) {
        _preflight();

        vm.startBroadcast(deployer);
        (lookalikes, decisions) = _deployPinRenounce();
        vm.stopBroadcast();

        _print(deployer, lookalikes, decisions);
    }

    function _preflight() internal view {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (REGISTRY.code.length == 0) revert HasNoCode(REGISTRY);
        if (POLICY.code.length == 0) revert HasNoCode(POLICY);
        if (FORWARDER.code.length == 0) revert HasNoCode(FORWARDER);
        string memory version = ITypeAndVersion(FORWARDER).typeAndVersion();
        if (keccak256(bytes(version)) != keccak256(bytes(FORWARDER_VERSION))) revert NotTheKeystoneForwarder(version);
        address registryPolicy = IMoolamRegistry(REGISTRY).policy();
        if (registryPolicy != POLICY) revert RegistryPolicyMismatch(registryPolicy);
    }

    function _deployPinRenounce() internal returns (MoolamLookalikes lookalikes, MoolamDecisions decisions) {
        lookalikes = new MoolamLookalikes(FORWARDER);
        // Author before name: the template refuses a name with no author behind it.
        lookalikes.setExpectedAuthor(WORKFLOW_OWNER);
        lookalikes.setExpectedWorkflowName(WORKFLOW_NAME);

        if (lookalikes.getForwarderAddress() != FORWARDER) revert PinMismatch("forwarder");
        if (lookalikes.getExpectedAuthor() != WORKFLOW_OWNER) revert PinMismatch("workflow owner");
        if (lookalikes.getExpectedWorkflowName() != WORKFLOW_NAME_PIN) revert PinMismatch("workflow name");
        if (lookalikes.getExpectedWorkflowId() != bytes32(0)) revert PinMismatch("workflow id");

        // The template allows renouncing, so the pins become permanent this way rather than by a lock.
        lookalikes.renounceOwnership();
        if (lookalikes.owner() != address(0)) revert StillOwned(lookalikes.owner());

        decisions = new MoolamDecisions(REGISTRY, POLICY);
        if (address(decisions.REGISTRY()) != REGISTRY) revert PinMismatch("decisions registry");
        if (address(decisions.POLICY()) != POLICY) revert PinMismatch("decisions policy");
    }

    function _print(address deployer, MoolamLookalikes lookalikes, MoolamDecisions decisions) internal view {
        console2.log("chain id               ", block.chainid);
        console2.log("deployer               ", deployer);
        console2.log("MoolamLookalikes       ", address(lookalikes));
        console2.log("MoolamDecisions        ", address(decisions));
        console2.log("read back forwarder    ", lookalikes.getForwarderAddress());
        console2.log("read back author       ", lookalikes.getExpectedAuthor());
        console2.log("read back name         ");
        console2.logBytes10(lookalikes.getExpectedWorkflowName());
        console2.log("lookalikes owner       ", lookalikes.owner());
        console2.log("decisions registry     ", address(decisions.REGISTRY()));
        console2.log("decisions policy       ", address(decisions.POLICY()));
    }
}
