// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IVerifierPolicy} from "./interfaces/IVerifierPolicy.sol";

/// @title VerifierPolicy
/// @notice Holds the list of addresses allowed to write attestations into the Moolam registry,
///         plus the dispute resolver, the treasury and the bond size. The registry is immutable,
///         so this contract is the only moving part of the system.
/// @dev Every change that widens trust waits 24 hours in the open, which gives anyone watching
///      time to react before a new verifier can write. Removing a receiver is immediate, because
///      a compromised verifier must be cut off in one transaction.
contract VerifierPolicy is IVerifierPolicy, Ownable2Step {
    /// @notice A change waiting out its delay.
    struct PendingChange {
        bytes32 op;
        uint64 executeAfter;
        bytes data;
    }

    /// @notice How long a queued change waits before it can run.
    uint64 public constant CHANGE_DELAY = 24 hours;

    /// @notice Operation tag for adding a receiver.
    bytes32 public constant OP_ADD_RECEIVER = keccak256("ADD_RECEIVER");
    /// @notice Operation tag for changing the resolver.
    bytes32 public constant OP_SET_RESOLVER = keccak256("SET_RESOLVER");
    /// @notice Operation tag for changing the treasury.
    bytes32 public constant OP_SET_TREASURY = keccak256("SET_TREASURY");
    /// @notice Operation tag for changing the dispute bond.
    bytes32 public constant OP_SET_DISPUTE_BOND = keccak256("SET_DISPUTE_BOND");

    /// @notice False until the owner closes the setup window. Once true it can never go back.
    bool public bootstrapped;

    mapping(address receiver => bool listed) private _receivers;
    mapping(bytes32 changeId => PendingChange change) private _pending;

    address private _resolver;
    address private _treasury;
    uint256 private _disputeBond;

    /// @notice A change was put in the queue and its 24 hour clock started.
    /// @param id The change id, keccak256 of the operation tag and its encoded data.
    /// @param op Which operation was queued.
    /// @param data The encoded argument the operation will apply.
    /// @param executeAfter The timestamp from which execute will work.
    event ChangeQueued(bytes32 indexed id, bytes32 indexed op, bytes data, uint64 executeAfter);

    /// @notice A queued change ran.
    /// @param id The change id.
    event ChangeExecuted(bytes32 indexed id);

    /// @notice A queued change was dropped before it ran.
    /// @param id The change id.
    event ChangeCancelled(bytes32 indexed id);

    /// @notice An address may now write attestations.
    /// @param receiver The listed receiver.
    event ReceiverAdded(address indexed receiver);

    /// @notice An address may no longer write attestations.
    /// @param receiver The receiver that was dropped.
    event ReceiverRemoved(address indexed receiver);

    /// @notice The dispute resolver changed.
    /// @param resolver The new resolver.
    event ResolverSet(address indexed resolver);

    /// @notice The treasury changed.
    /// @param treasury The new treasury.
    event TreasurySet(address indexed treasury);

    /// @notice The dispute bond changed.
    /// @param bond The new bond in wei.
    event DisputeBondSet(uint256 bond);

    /// @notice The setup window closed. From here on every widening of trust waits 24 hours.
    event BootstrapFinalized();

    error ZeroAddress();
    error BootstrapClosed();
    error AlreadyReceiver();
    error NotAReceiver();
    error ChangeAlreadyQueued();
    error UnknownChange();
    error ChangeNotReady(uint64 executeAfter);

    /// @notice Deploys the policy with its starting settings.
    /// @param initialOwner The owner. Uses two step transfer, so a typo cannot lose the contract.
    /// @param initialResolver The address allowed to settle disputes.
    /// @param initialTreasury Where rejected challengers' bonds go.
    /// @param initialDisputeBond The bond a challenger must post, in wei.
    constructor(address initialOwner, address initialResolver, address initialTreasury, uint256 initialDisputeBond)
        Ownable(initialOwner)
    {
        if (initialResolver == address(0) || initialTreasury == address(0)) revert ZeroAddress();
        _resolver = initialResolver;
        _treasury = initialTreasury;
        _disputeBond = initialDisputeBond;
        emit ResolverSet(initialResolver);
        emit TreasurySet(initialTreasury);
        emit DisputeBondSet(initialDisputeBond);
    }

    /// @inheritdoc IVerifierPolicy
    function isReceiver(address who) external view returns (bool) {
        return _receivers[who];
    }

    /// @inheritdoc IVerifierPolicy
    function resolver() external view returns (address) {
        return _resolver;
    }

    /// @inheritdoc IVerifierPolicy
    function treasury() external view returns (address) {
        return _treasury;
    }

    /// @inheritdoc IVerifierPolicy
    function disputeBond() external view returns (uint256) {
        return _disputeBond;
    }

    /// @notice Reads a queued change.
    /// @param id The change id returned by the queue call.
    /// @return The pending change. A zero executeAfter means nothing is queued under that id.
    function getPendingChange(bytes32 id) external view returns (PendingChange memory) {
        return _pending[id];
    }

    /// @notice Adds a receiver immediately, during the setup window only.
    /// @dev Reverts BootstrapClosed once finalizeBootstrap has run, ZeroAddress on the zero
    ///      address, AlreadyReceiver when the address is already listed. Emits ReceiverAdded.
    /// @param who The receiver contract to list.
    function bootstrapAddReceiver(address who) external onlyOwner {
        if (bootstrapped) revert BootstrapClosed();
        _addReceiver(who);
    }

    /// @notice Closes the setup window for good. After this, adding trust takes 24 hours.
    /// @dev Reverts BootstrapClosed if already closed. Emits BootstrapFinalized.
    function finalizeBootstrap() external onlyOwner {
        if (bootstrapped) revert BootstrapClosed();
        bootstrapped = true;
        emit BootstrapFinalized();
    }

    /// @notice Drops a receiver at once. No delay, because a compromised verifier must stop
    ///         writing in the same block the owner notices.
    /// @dev Reverts NotAReceiver when the address is not listed. Emits ReceiverRemoved.
    /// @param who The receiver to drop.
    function removeReceiver(address who) external onlyOwner {
        if (!_receivers[who]) revert NotAReceiver();
        _receivers[who] = false;
        emit ReceiverRemoved(who);
    }

    /// @notice Queues adding a receiver.
    /// @dev Reverts ZeroAddress, AlreadyReceiver or ChangeAlreadyQueued. Emits ChangeQueued.
    /// @param who The receiver to list once the delay passes.
    /// @return id The change id to pass to execute or cancel.
    function queueAddReceiver(address who) external onlyOwner returns (bytes32 id) {
        if (who == address(0)) revert ZeroAddress();
        if (_receivers[who]) revert AlreadyReceiver();
        return _queue(OP_ADD_RECEIVER, abi.encode(who));
    }

    /// @notice Queues a new dispute resolver.
    /// @dev Reverts ZeroAddress or ChangeAlreadyQueued. Emits ChangeQueued.
    /// @param who The new resolver.
    /// @return id The change id.
    function queueSetResolver(address who) external onlyOwner returns (bytes32 id) {
        if (who == address(0)) revert ZeroAddress();
        return _queue(OP_SET_RESOLVER, abi.encode(who));
    }

    /// @notice Queues a new treasury.
    /// @dev Reverts ZeroAddress or ChangeAlreadyQueued. Emits ChangeQueued.
    /// @param who The new treasury.
    /// @return id The change id.
    function queueSetTreasury(address who) external onlyOwner returns (bytes32 id) {
        if (who == address(0)) revert ZeroAddress();
        return _queue(OP_SET_TREASURY, abi.encode(who));
    }

    /// @notice Queues a new dispute bond.
    /// @dev Reverts ChangeAlreadyQueued. Emits ChangeQueued.
    /// @param bond The new bond in wei.
    /// @return id The change id.
    function queueSetDisputeBond(uint256 bond) external onlyOwner returns (bytes32 id) {
        return _queue(OP_SET_DISPUTE_BOND, abi.encode(bond));
    }

    /// @notice Runs a queued change once its delay has passed.
    /// @dev Reverts UnknownChange when nothing is queued under the id, ChangeNotReady while the
    ///      delay is still running. Emits ChangeExecuted plus the event for the specific change.
    /// @param id The change id.
    function execute(bytes32 id) external onlyOwner {
        PendingChange memory change = _pending[id];
        if (change.executeAfter == 0) revert UnknownChange();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < change.executeAfter) revert ChangeNotReady(change.executeAfter);

        delete _pending[id];

        if (change.op == OP_ADD_RECEIVER) {
            _addReceiver(abi.decode(change.data, (address)));
        } else if (change.op == OP_SET_RESOLVER) {
            address who = abi.decode(change.data, (address));
            _resolver = who;
            emit ResolverSet(who);
        } else if (change.op == OP_SET_TREASURY) {
            address who = abi.decode(change.data, (address));
            _treasury = who;
            emit TreasurySet(who);
        } else {
            uint256 bond = abi.decode(change.data, (uint256));
            _disputeBond = bond;
            emit DisputeBondSet(bond);
        }

        emit ChangeExecuted(id);
    }

    /// @notice Drops a queued change before it runs.
    /// @dev Reverts UnknownChange when nothing is queued under the id. Emits ChangeCancelled.
    /// @param id The change id.
    function cancel(bytes32 id) external onlyOwner {
        if (_pending[id].executeAfter == 0) revert UnknownChange();
        delete _pending[id];
        emit ChangeCancelled(id);
    }

    function _queue(bytes32 op, bytes memory data) private returns (bytes32 id) {
        id = keccak256(abi.encode(op, data));
        if (_pending[id].executeAfter != 0) revert ChangeAlreadyQueued();

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 executeAfter = uint64(block.timestamp) + CHANGE_DELAY;
        _pending[id] = PendingChange({op: op, executeAfter: executeAfter, data: data});
        emit ChangeQueued(id, op, data, executeAfter);
    }

    function _addReceiver(address who) private {
        if (who == address(0)) revert ZeroAddress();
        if (_receivers[who]) revert AlreadyReceiver();
        _receivers[who] = true;
        emit ReceiverAdded(who);
    }
}
