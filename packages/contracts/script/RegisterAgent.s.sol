// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice The slice of the canonical ERC-8004 Identity Registry this script uses. The live
///         contract overloads register three ways; only the one argument form is declared here.
interface IAgentIdentity {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Registers the demo generator agent on the real ERC-8004 Identity Registry on Monad
///         mainnet, from the deployer wallet. The passport registry reads `ownerOf` on that
///         registry, so this agent id is what makes a Generated passport possible at all.
/// @dev Two entry points. `run` sends the registration. `verify` reads the id back from the chain
///      afterwards and proves the deployer owns it, because the id the simulation returns could in
///      principle be taken by another registration landing first.
contract RegisterAgent is Script {
    address internal constant AGENT_IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";

    error WrongChain(uint256 actual, uint256 expected);
    error DeploymentFileMissing();
    error AgentNotOwnedByDeployer(uint256 agentId, address owner, address deployer);

    /// @notice Mints the demo agent to the deployer and writes its id into the deployment file.
    /// @dev The card comes from env MOOLAM_AGENT_URI when set, otherwise from a data URI built
    ///      here. Reverts WrongChain off Monad mainnet and DeploymentFileMissing when the contracts
    ///      have not been deployed yet.
    /// @return agentId The id the registry minted.
    function run() external returns (uint256 agentId) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        string memory agentURI = vm.envOr("MOOLAM_AGENT_URI", _defaultAgentCard());

        vm.startBroadcast(deployerKey);
        agentId = IAgentIdentity(AGENT_IDENTITY).register(agentURI);
        vm.stopBroadcast();

        console2.log("agent owner   ", deployer);
        console2.log("agent id      ", agentId);
        console2.log("agent card URI", agentURI);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();
            vm.writeJson(vm.toString(agentId), DEPLOYMENT_FILE, ".demoAgentId");
            console2.log("Wrote demoAgentId into", DEPLOYMENT_FILE);
        } else {
            console2.log("Dry run: nothing was sent and the deployment file was not touched.");
            console2.log("The id above is what the next registration would get at this block.");
        }
    }

    /// @notice Reads the recorded agent id back from the canonical registry.
    /// @dev Reverts DeploymentFileMissing when there is nothing to check and
    ///      AgentNotOwnedByDeployer when another registration took that id first, which means the
    ///      run should be repeated.
    function verify() external view {
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();

        uint256 agentId = vm.parseJsonUint(vm.readFile(DEPLOYMENT_FILE), ".demoAgentId");
        address deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address agentOwner = IAgentIdentity(AGENT_IDENTITY).ownerOf(agentId);

        if (agentOwner != deployer) revert AgentNotOwnedByDeployer(agentId, agentOwner, deployer);

        console2.log("agent id", agentId, "is owned on the canonical registry by", agentOwner);
    }

    function _defaultAgentCard() internal pure returns (string memory) {
        return string.concat(
            'data:application/json,{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1",',
            '"name":"Moolam demo generator",',
            '"description":"The generator agent behind the Moolam demo. It signs the fingerprint of ',
            'every image it makes, so each passport names the agent that made it.",',
            '"services":[],"active":true}'
        );
    }
}
