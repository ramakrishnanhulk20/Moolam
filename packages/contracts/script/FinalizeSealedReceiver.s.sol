// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @notice Runs the queued listing of the sealed receiver once the policy's 24 hour delay has
///         passed, then reads the list back.
/// @dev Everything it acts on comes from deployments/sealed-receiver-monad-mainnet.json, the file
///      DeploySealedReceiver.s.sol writes, and is checked against the chain before anything is
///      sent: the pending change must still be there, must be the add of that exact receiver, and
///      its delay must be over. `finalizeAs` runs the same steps for a sender given by address,
///      which is how the fork test drives it without a key.
contract FinalizeSealedReceiver is Script {
    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    string internal constant DEPLOYMENT_FILE = "deployments/sealed-receiver-monad-mainnet.json";

    error WrongChain(uint256 actual, uint256 expected);
    error DeploymentFileMissing();
    error HasNoCode(address target);
    error NothingQueued(bytes32 changeId);
    error QueuedChangeIsNotThisListing(bytes32 changeId);
    /// @notice The 24 hour delay is still running. Try again after executeAfter.
    error TooEarly(uint64 executeAfter, uint256 secondsLeft);
    error NotPolicyOwner(address sender, address owner);
    error NotListedAfterExecute(address sealedReceiver);
    error PublicReceiverDropped(address publicReceiver);

    /// @notice Lists the sealed receiver from the wallet in DEPLOYER_PRIVATE_KEY.
    /// @dev Reverts WrongChain off Monad mainnet, DeploymentFileMissing before the deploy has run,
    ///      and every check in `_ready`. Does nothing and sends nothing when the receiver is
    ///      already listed. Run without --broadcast for a dry run.
    /// @return listed Whether the policy lists the sealed receiver afterwards.
    function run() external returns (bool listed) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileMissing();

        string memory json = vm.readFile(DEPLOYMENT_FILE);
        VerifierPolicy policy = VerifierPolicy(vm.parseJsonAddress(json, ".policy"));
        address sealedReceiver = vm.parseJsonAddress(json, ".receiver");
        bytes32 changeId = vm.parseJsonBytes32(json, ".changeId");
        address publicReceiver = vm.parseJsonAddress(vm.readFile("deployments/monad-mainnet.json"), ".receiver");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        if (!_ready(policy, sealedReceiver, changeId, deployer)) return true;

        vm.startBroadcast(deployerKey);
        policy.execute(changeId);
        vm.stopBroadcast();

        listed = _readBack(policy, sealedReceiver, publicReceiver);
    }

    /// @notice The same steps as `run` for a sender and addresses given directly. Reads no file.
    /// @dev For the fork test. Reverts on every check in `_ready` and in the read-back.
    /// @param owner The policy owner that sends the execute.
    /// @param policy The VerifierPolicy holding the queued listing.
    /// @param sealedReceiver The receiver the change lists.
    /// @param publicReceiver The receiver already listed, which must still be listed afterwards.
    /// @param changeId The id queueAddReceiver returned.
    /// @return listed Whether the policy lists the sealed receiver afterwards.
    function finalizeAs(
        address owner,
        VerifierPolicy policy,
        address sealedReceiver,
        address publicReceiver,
        bytes32 changeId
    ) external returns (bool listed) {
        if (!_ready(policy, sealedReceiver, changeId, owner)) return true;

        vm.startBroadcast(owner);
        policy.execute(changeId);
        vm.stopBroadcast();

        listed = _readBack(policy, sealedReceiver, publicReceiver);
    }

    /// @dev False means the receiver is already listed and there is nothing to send. Every other
    ///      outcome is either true or a revert, so a wrong or stale change id stops the run before
    ///      a transaction is built.
    function _ready(VerifierPolicy policy, address sealedReceiver, bytes32 changeId, address sender)
        internal
        view
        returns (bool)
    {
        if (address(policy).code.length == 0) revert HasNoCode(address(policy));
        if (sealedReceiver.code.length == 0) revert HasNoCode(sealedReceiver);

        if (policy.isReceiver(sealedReceiver)) {
            console2.log("The sealed receiver is already listed. Nothing to do.", sealedReceiver);
            return false;
        }

        address policyOwner = policy.owner();
        if (policyOwner != sender) revert NotPolicyOwner(sender, policyOwner);

        VerifierPolicy.PendingChange memory change = policy.getPendingChange(changeId);
        if (change.executeAfter == 0) revert NothingQueued(changeId);
        if (change.op != policy.OP_ADD_RECEIVER() || keccak256(change.data) != keccak256(abi.encode(sealedReceiver))) {
            revert QueuedChangeIsNotThisListing(changeId);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < change.executeAfter) {
            uint256 secondsLeft = change.executeAfter - block.timestamp;
            console2.log("Too early: the 24 hour delay has not passed. Seconds left:", secondsLeft);
            revert TooEarly(change.executeAfter, secondsLeft);
        }
        return true;
    }

    function _readBack(VerifierPolicy policy, address sealedReceiver, address publicReceiver)
        internal
        view
        returns (bool listed)
    {
        listed = policy.isReceiver(sealedReceiver);
        bool publicListed = policy.isReceiver(publicReceiver);

        console2.log("policy                  ", address(policy));
        console2.log("sealed receiver         ", sealedReceiver);
        console2.log("sealed receiver listed  ", listed);
        console2.log("public receiver         ", publicReceiver);
        console2.log("public receiver listed  ", publicListed);
        console2.log("sealed receiver registry", address(MoolamReceiver(sealedReceiver).REGISTRY()));

        if (!listed) revert NotListedAfterExecute(sealedReceiver);
        if (!publicListed) revert PublicReceiverDropped(publicReceiver);
    }
}
