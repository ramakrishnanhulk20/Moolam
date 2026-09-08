// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";

/// @notice Pins an already deployed MoolamReceiver to one Chainlink workflow, or unpins it again.
/// @dev The deploy script pins the live receiver at deploy time. This script is for the receiver
///      that is already on chain and for the switch a simulation needs: `cre workflow simulate`
///      talks through a mock forwarder that sends no workflow metadata, so a pinned receiver
///      refuses every simulated report. Clear the pin for a simulation, set it again afterwards.
///      Reads RECEIVER, CRE_WALLET_ADDRESS and CRE_WORKFLOW_NAME from the environment. An empty
///      CRE_WORKFLOW_NAME and a zero CRE_WALLET_ADDRESS clear the pin.
contract ConfigureReceiver is Script {
    error ReceiverHasNoCode(address moolamReceiver);
    error NameWithoutAuthor();

    /// @notice Sets or clears the expected workflow author and workflow name on the receiver.
    /// @dev Must be run by the receiver's owner, which is the deployer wallet. Reverts
    ///      ReceiverHasNoCode when RECEIVER points at an empty address and NameWithoutAuthor when
    ///      a name is given with no author, which is a state Chainlink's template refuses to serve.
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
            // Clearing runs name first: an author of zero with a name still set makes the template
            // revert every report, and that half-state must never exist between two transactions.
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
