// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MoolamReceiver} from "../src/MoolamReceiver.sol";
import {VerifierPolicy} from "../src/VerifierPolicy.sol";

/// @notice Deploys a second MoolamReceiver pinned to the sealed workflow and queues its listing.
///         Same bytecode as the public receiver; only the pinned name differs, so each refuses the
///         other's reports. FinalizeSealedReceiver.s.sol lists it after the 24 hour delay.
contract DeploySealedReceiver is Script {
    struct Deployment {
        address deployer;
        MoolamReceiver sealedReceiver;
        address workflowAuthor;
        bytes10 workflowName;
        bytes32 changeId;
        uint64 executeAfter;
    }

    uint64 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    address internal constant PRODUCTION_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant WORKFLOW_AUTHOR = 0xC79620AF233a4434b03f6B57239F8A9E71B3C178;
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

    /// @notice Deploys, pins and queues from DEPLOYER_PRIVATE_KEY. Without --broadcast it is a dry run.
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

    /// @notice The same steps as `run` for a sender given by address, for the fork test. Writes no file.
    function deployAs(address deployer) external returns (Deployment memory d) {
        (VerifierPolicy policy, address registry) = _preflight(deployer);

        vm.startBroadcast(deployer);
        d = _deployPinAndQueue(deployer, policy, registry);
        vm.stopBroadcast();

        _print(d, policy, registry);
    }

    /// @notice Writes the four transaction hashes into the deployment file. Run after `run`.
    /// @dev The hashes come in as arguments: the policy was not deployed here, so its call has no
    ///      contract name the broadcast cheatcodes can search by.
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
        // Author first: a name with no author makes the template refuse every report.
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
        json = vm.serializeString(root, "txHashes", "pending");

        vm.writeJson(json, DEPLOYMENT_FILE);
        console2.log("Wrote", DEPLOYMENT_FILE);
    }
}
