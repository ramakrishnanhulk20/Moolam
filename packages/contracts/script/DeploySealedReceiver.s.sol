// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @notice Deploys a second MoolamReceiver for private re-checks, pins it to the sealed workflow,
///         and queues its listing in the VerifierPolicy. The bytecode is the reviewed receiver,
///         unchanged. Only the pinned workflow name differs, so every verdict on chain names the
///         workflow that wrote it: the public receiver takes moolam-verifier, this one takes
///         moolam-sealed-verifier, and each refuses the other's reports.
/// @dev The policy closed its setup window at the first deploy, so the listing waits 24 hours in
///      the open. FinalizeSealedReceiver.s.sol runs it once the delay has passed. Three entry
///      points: `run` deploys with the key from the environment and writes
///      deployments/sealed-receiver-monad-mainnet.json, `record` fills in the transaction hashes
///      afterwards, and `deployAs` runs the same steps for a sender given by address, which is
///      how the fork test drives it without a key.
contract DeploySealedReceiver is Script {
    /// @notice What the deploy produced, read back from the contracts rather than assumed.
    struct Deployment {
        address deployer;
        MoolamReceiver sealedReceiver;
        address workflowAuthor;
        bytes10 workflowName;
        bytes32 changeId;
        uint64 executeAfter;
    }

    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    /// @dev The production Chainlink KeystoneForwarder on Monad mainnet, the same one the public
    ///      receiver trusts.
    address internal constant PRODUCTION_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    /// @dev The CRE wallet that owns both workflows. Checked against the public receiver's own pin
    ///      before anything is sent, so the two receivers cannot drift apart on who the author is.
    address internal constant WORKFLOW_AUTHOR = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
    /// @dev The name in the sealed workflow's workflow.yaml. Chainlink's template stores it as the
    ///      first ten hex characters of its sha256.
    string internal constant WORKFLOW_NAME = "moolam-sealed-verifier";

    string internal constant LIVE_FILE = "deployments/monad-mainnet.json";
    string internal constant DEPLOYMENT_FILE = "deployments/sealed-receiver-monad-mainnet.json";

    error WrongChain(uint256 actual, uint256 expected);
    error DeploymentFileMissing();
    error HasNoCode(address target);
    error ForwarderMismatch(address publicReceiverForwarder, address expected);
    error RegistryMismatch(address publicReceiverRegistry, address recorded);
    error AuthorMismatch(address publicReceiverAuthor, address expected);
    error PublicReceiverNotListed(address publicReceiver);
    error NotPolicyOwner(address deployer, address owner);
    error AlreadyDeployed(address sealedReceiver);
    error DeploymentFileNotWritten();

    /// @notice Deploys the sealed receiver, pins it and queues its listing, from the wallet in
    ///         DEPLOYER_PRIVATE_KEY.
    /// @dev Reverts WrongChain off Monad mainnet, DeploymentFileMissing without the live deployment
    ///      file, AlreadyDeployed when an earlier run left a receiver with code at the recorded
    ///      address, and every check in `_preflight`. Run without --broadcast for a dry run that
    ///      sends nothing and writes nothing.
    /// @return d The deployment as read back from the contracts.
    function run() external returns (Deployment memory d) {
        _refuseIfAlreadyDeployed();
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        (VerifierPolicy policy, address registry) = _preflight(deployer);

        vm.startBroadcast(deployerKey);
        d = _deployPinAndQueue(deployer, policy, registry);
        vm.stopBroadcast();

        _print(d, policy, registry);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _write(d, policy, registry);
        } else {
            console2.log("Dry run: no transaction was sent and no deployment file was written.");
        }
    }

    /// @notice The same steps as `run` for a sender given by address. Writes no file.
    /// @dev For the fork test, where the policy owner is acted as without its key. A broadcast
    ///      through this entry needs the signer supplied on the command line, so `run` stays the
    ///      path for the real deploy. Reverts on every check in `_preflight`.
    /// @param deployer The wallet that sends the four transactions. Must own the policy.
    /// @return d The deployment as read back from the contracts.
    function deployAs(address deployer) external returns (Deployment memory d) {
        (VerifierPolicy policy, address registry) = _preflight(deployer);

        vm.startBroadcast(deployer);
        d = _deployPinAndQueue(deployer, policy, registry);
        vm.stopBroadcast();

        _print(d, policy, registry);
    }

    /// @notice Writes the four transaction hashes of the last broadcast into the deployment file.
    /// @dev Run after `run --broadcast`, without broadcasting. The launch script reads the hashes
    ///      from Foundry's broadcast artifact for this script and checks each receipt on chain
    ///      first. They come in as arguments because Foundry cannot name the policy call from
    ///      inside a script: the policy was not deployed by this script, so its artifact entry has
    ///      no contract name to search by. Reverts DeploymentFileNotWritten when `run` has not
    ///      written the file yet.
    /// @param createTx The hash of the receiver deployment.
    /// @param authorTx The hash of setExpectedAuthor.
    /// @param nameTx The hash of setExpectedWorkflowName.
    /// @param queueTx The hash of queueAddReceiver.
    function record(bytes32 createTx, bytes32 authorTx, bytes32 nameTx, bytes32 queueTx) external {
        if (!vm.exists(DEPLOYMENT_FILE)) revert DeploymentFileNotWritten();

        string memory hashes = "txHashes";
        string memory json = vm.serializeBytes32(hashes, "receiver", createTx);
        json = vm.serializeBytes32(hashes, "setExpectedAuthor", authorTx);
        json = vm.serializeBytes32(hashes, "setExpectedWorkflowName", nameTx);
        json = vm.serializeBytes32(hashes, "queueAddReceiver", queueTx);
        vm.writeJson(json, DEPLOYMENT_FILE, ".txHashes");

        console2.log("Recorded transaction hashes into", DEPLOYMENT_FILE);
    }

    /// @dev Every check that can fail runs before the first transaction, so a mistake stops the
    ///      run with nothing sent.
    function _preflight(address deployer) internal view returns (VerifierPolicy policy, address registry) {
        if (block.chainid != MONAD_MAINNET_CHAIN_ID) revert WrongChain(block.chainid, MONAD_MAINNET_CHAIN_ID);
        if (!vm.exists(LIVE_FILE)) revert DeploymentFileMissing();

        string memory live = vm.readFile(LIVE_FILE);
        policy = VerifierPolicy(vm.parseJsonAddress(live, ".policy"));
        registry = vm.parseJsonAddress(live, ".registry");
        MoolamReceiver publicReceiver = MoolamReceiver(vm.parseJsonAddress(live, ".receiver"));

        if (address(policy).code.length == 0) revert HasNoCode(address(policy));
        if (registry.code.length == 0) revert HasNoCode(registry);
        if (address(publicReceiver).code.length == 0) revert HasNoCode(address(publicReceiver));
        if (PRODUCTION_FORWARDER.code.length == 0) revert HasNoCode(PRODUCTION_FORWARDER);

        _matchThePublicReceiver(policy, registry, publicReceiver, deployer);
    }

    /// @dev The sealed receiver must trust the same forwarder, write to the same registry and
    ///      answer to the same author as the receiver already live, and the sender must be able to
    ///      queue the listing.
    function _matchThePublicReceiver(
        VerifierPolicy policy,
        address registry,
        MoolamReceiver publicReceiver,
        address deployer
    ) internal view {
        address liveForwarder = publicReceiver.getForwarderAddress();
        if (liveForwarder != PRODUCTION_FORWARDER) revert ForwarderMismatch(liveForwarder, PRODUCTION_FORWARDER);
        address liveRegistry = address(publicReceiver.REGISTRY());
        if (liveRegistry != registry) revert RegistryMismatch(liveRegistry, registry);
        address liveAuthor = publicReceiver.getExpectedAuthor();
        if (liveAuthor != WORKFLOW_AUTHOR) revert AuthorMismatch(liveAuthor, WORKFLOW_AUTHOR);
        if (!policy.isReceiver(address(publicReceiver))) revert PublicReceiverNotListed(address(publicReceiver));

        address policyOwner = policy.owner();
        if (policyOwner != deployer) revert NotPolicyOwner(deployer, policyOwner);
    }

    function _deployPinAndQueue(address deployer, VerifierPolicy policy, address registry)
        internal
        returns (Deployment memory d)
    {
        MoolamReceiver sealedReceiver = new MoolamReceiver(PRODUCTION_FORWARDER, registry);
        // The author goes in first. Chainlink's template refuses every report when a name is
        // pinned without an author, so setting the name first would leave a window where the
        // receiver is bricked.
        sealedReceiver.setExpectedAuthor(WORKFLOW_AUTHOR);
        sealedReceiver.setExpectedWorkflowName(WORKFLOW_NAME);
        bytes32 changeId = policy.queueAddReceiver(address(sealedReceiver));

        d = Deployment({
            deployer: deployer,
            sealedReceiver: sealedReceiver,
            workflowAuthor: sealedReceiver.getExpectedAuthor(),
            workflowName: sealedReceiver.getExpectedWorkflowName(),
            changeId: changeId,
            executeAfter: policy.getPendingChange(changeId).executeAfter
        });
    }

    function _refuseIfAlreadyDeployed() internal view {
        if (!vm.exists(DEPLOYMENT_FILE)) return;
        address recorded = vm.parseJsonAddress(vm.readFile(DEPLOYMENT_FILE), ".receiver");
        if (recorded.code.length != 0) revert AlreadyDeployed(recorded);
    }

    function _print(Deployment memory d, VerifierPolicy policy, address registry) internal view {
        console2.log("chain id           ", block.chainid);
        console2.log("deployer           ", d.deployer);
        console2.log("block              ", block.number);
        console2.log("sealed receiver    ", address(d.sealedReceiver));
        console2.log("receiver owner     ", d.sealedReceiver.owner());
        console2.log("forwarder          ", d.sealedReceiver.getForwarderAddress());
        console2.log("registry           ", address(d.sealedReceiver.REGISTRY()));
        console2.log("policy             ", address(policy));
        console2.log("recorded registry  ", registry);
        console2.log("workflow author    ", d.workflowAuthor);
        console2.log("workflow name      ", WORKFLOW_NAME);
        console2.log("pinned name bytes10");
        console2.logBytes10(d.workflowName);
        console2.log("change id");
        console2.logBytes32(d.changeId);
        console2.log("execute after      ", d.executeAfter);
    }

    function _write(Deployment memory d, VerifierPolicy policy, address registry) internal {
        string memory root = "sealedReceiver";
        string memory json = vm.serializeUint(root, "chainId", block.chainid);
        json = vm.serializeAddress(root, "deployer", d.deployer);
        json = vm.serializeUint(root, "block", block.number);
        json = vm.serializeUint(root, "timestamp", block.timestamp);
        json = vm.serializeAddress(root, "receiver", address(d.sealedReceiver));
        json = vm.serializeAddress(root, "policy", address(policy));
        json = vm.serializeAddress(root, "registry", registry);
        json = vm.serializeAddress(root, "forwarder", PRODUCTION_FORWARDER);
        json = vm.serializeAddress(root, "workflowAuthor", d.workflowAuthor);
        json = vm.serializeString(root, "workflowName", WORKFLOW_NAME);
        json = vm.serializeBytes(root, "workflowNameEncoded", abi.encodePacked(d.workflowName));
        json = vm.serializeBytes32(root, "changeId", d.changeId);
        json = vm.serializeUint(root, "executeAfter", d.executeAfter);
        // Filled by `record` once the transactions have landed and their hashes exist.
        json = vm.serializeString(root, "txHashes", "pending");

        vm.writeJson(json, DEPLOYMENT_FILE);
        console2.log("Wrote", DEPLOYMENT_FILE);
    }
}
