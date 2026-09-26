// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";

import {MoolamConsent} from "../src/MoolamConsent.sol";

/// @notice Deploys MoolamConsent to Monad mainnet against the live registry recorded in
///         deployments/monad-mainnet.json, never a hand typed address.
contract DeployConsent is Script {
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant DEPLOYMENT_FILE = "deployments/monad-mainnet.json";

    error WrongChain(uint256 actual, uint256 expected);
    error DeploymentFileMissing();
    error RegistryHasNoCode(address registry);

    /// @notice Deploys the consent register. Without --broadcast it is a dry run.
    function run() external returns (MoolamConsent consent) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();

        address registry = vm.parseJsonAddress(vm.readFile(DEPLOYMENT_FILE), ".registry");
        if (registry.code.length == 0) revert RegistryHasNoCode(registry);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        consent = new MoolamConsent(registry);
        vm.stopBroadcast();

        console2.log("chain id       ", block.chainid);
        console2.log("deployer       ", deployer);
        console2.log("block          ", block.number);
        console2.log("MoolamConsent  ", address(consent));
        console2.log("registry read  ", consent.REGISTRY());
        console2.log("standard       ", consent.STANDARD());
        console2.log("min interval   ", consent.MIN_INTERVAL());
        console2.log("max info bytes ", consent.MAX_INFO_BYTES());
        console2.log("max page       ", consent.MAX_PAGE());
        console2.log("max batch      ", consent.MAX_BATCH());
        // Proves the recorded address really is the passport registry.
        console2.log("registry symbol", IERC721Metadata(registry).symbol());
    }
}
