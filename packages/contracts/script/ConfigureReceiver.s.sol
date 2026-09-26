// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";

/// @notice Pins a deployed MoolamReceiver to one Chainlink workflow, or clears the pin for a
///         `cre workflow simulate` run. A zero CRE_WALLET_ADDRESS and empty CRE_WORKFLOW_NAME clear it.
contract ConfigureReceiver is Script {
    error ReceiverHasNoCode(address moolamReceiver);
    error NameWithoutAuthor();

    /// @notice Sets or clears the expected workflow author and name. Run by the receiver's owner.
    function run() external {
        address receiverAddress = vm.envAddress("RECEIVER");
        if (receiverAddress.code.length == 0) revert ReceiverHasNoCode(receiverAddress);

        address author = vm.envOr("CRE_WALLET_ADDRESS", address(0));
        string memory name = vm.envOr("CRE_WORKFLOW_NAME", string(""));
        if (author == address(0) && bytes(name).length != 0) revert NameWithoutAuthor();

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        MoolamReceiver moolamReceiver = MoolamReceiver(receiverAddress);

        vm.startBroadcast(deployerKey);
        if (author == address(0)) {
            // Name first: a name with no author makes the template refuse every report.
            moolamReceiver.setExpectedWorkflowName("");
            moolamReceiver.setExpectedAuthor(address(0));
        } else {
            moolamReceiver.setExpectedAuthor(author);
            moolamReceiver.setExpectedWorkflowName(name);
        }
        vm.stopBroadcast();

        console2.log("receiver        ", receiverAddress);
        console2.log("owner           ", moolamReceiver.owner());
        console2.log("forwarder       ", moolamReceiver.getForwarderAddress());
        console2.log("expected author ", moolamReceiver.getExpectedAuthor());
        console2.log("workflow name   ", name);
        console2.logBytes10(moolamReceiver.getExpectedWorkflowName());
    }
}
