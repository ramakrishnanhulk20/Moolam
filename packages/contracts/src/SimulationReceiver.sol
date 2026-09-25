// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReceiverTemplate} from "./vendor/chainlink/ReceiverTemplate.sol";
import {IMoolamRegistry} from "./interfaces/IMoolamRegistry.sol";

/// @title SimulationReceiver
/// @notice The door a Chainlink CRE workflow run in Chainlink's simulator (`cre workflow simulate
///         --broadcast`) uses to write a re-check verdict into the Moolam registry. It accepts a
///         report only when the transaction was sent by one wallet, Moolam's CRE wallet, fixed at
///         deployment and never changeable.
/// @dev Inherits Chainlink's ReceiverTemplate unchanged and is otherwise MoolamReceiver's report
///      path. The simulator delivers through MockKeystoneForwarder, which checks no signature and
///      builds the workflow metadata from bytes the caller supplied. The workflow id, owner and
///      name the simulator stamps are the same for anyone who runs the public workflow, so the
///      forwarder check and the pins keep out other workflows and nothing else. The one value on
///      this path an outsider cannot produce is the externally owned account that signed the
///      transaction, because the mock adds a hop: msg.sender here is always Chainlink's public
///      contract. That is why the sender check reads tx.origin, and why it is the first check in
///      _processReport.
///
///      What this contract does not defend against, stated so nobody assumes it does:
///      - The holder of the CRE wallet's key can write any verdict on any passport through this
///        receiver. The holder of the owner key can re-point the forwarder, change the pins, or
///        list and unlist receivers at the policy. Neither is stopped here.
///      - A verdict is one machine's word. There is no network consensus and no signature check
///        behind a simulated report.
///      - Senders that are smart accounts or relayers are excluded on purpose: tx.origin is always
///        an externally owned account, so only a plain wallet can be the sending wallet.
///      - The CRE wallet must sign nothing but reports. Any contract it calls could call this
///        receiver's forwarder path inside the same transaction and inherit its authority.
///      - Replaying an old report here needs the sending wallet too, so the per-receiver floor
///        starting at zero is an insider matter, not an outsider one.
///      - A stolen machine holding the CRE key means forgery until the owner removes this receiver
///        at the policy, which takes effect at once.
///      - The mock forwarder is Chainlink's contract and may change.
///      A receiver for a real Chainlink network deployment is a separate contract, listed through
///      the policy's 24 hour queue, never this one with its sender rule switched off: there is no
///      switch.
contract SimulationReceiver is ReceiverTemplate {
    /// @notice How far past the current block time a report's executedAt may be.
    /// @dev The workflow stamps executedAt from the simulator machine's wall clock, in unix seconds,
    ///      before the run fetches and fingerprints the picture, and the report transaction lands
    ///      after that, so an honest executedAt sits at or before block.timestamp. The allowance is
    ///      for a machine clock running ahead of Monad's block time. A clock kept by NTP is within
    ///      a second, and one that has lost sync drifts by seconds a day, so an hour is far more
    ///      room than an honest run needs and never refuses one over clock trouble short of a
    ///      wrongly set clock. In the other direction it caps the harm of any value that does land:
    ///      a floor can sit at most one hour ahead, so the honest workflow is locked out of a
    ///      passport for at most one hour, never for ever.
    uint256 public constant MAX_FUTURE_SKEW = 1 hours;

    /// @notice The registry this receiver writes into.
    IMoolamRegistry public immutable REGISTRY;

    /// @notice The only wallet whose transactions this receiver accepts reports from.
    /// @dev Set once in the constructor. There is no setter, and it can never be zero.
    address public immutable SENDING_WALLET;

    mapping(bytes32 passportId => uint64 executedAt) private _lastExecutedAt;

    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice The transaction was not sent by the sending wallet.
    /// @param origin The wallet that signed the transaction.
    /// @param expected The sending wallet.
    error WrongSendingWallet(address origin, address expected);
    /// @notice The report was built for a different chain.
    /// @param reported The chain id inside the report.
    /// @param expected This chain's id.
    error WrongChain(uint256 reported, uint256 expected);
    /// @notice The report is not newer than the last one recorded for this passport.
    /// @param passportId The passport the report is about.
    /// @param reported The report's executedAt.
    /// @param lastSeen The executedAt of the newest report already recorded.
    error StaleReport(bytes32 passportId, uint64 reported, uint64 lastSeen);
    /// @notice The report claims a time further ahead of the block than MAX_FUTURE_SKEW allows.
    /// @param passportId The passport the report is about.
    /// @param reported The report's executedAt.
    /// @param latestAccepted block.timestamp plus MAX_FUTURE_SKEW at the moment it was refused.
    error ReportFromTheFuture(bytes32 passportId, uint64 reported, uint256 latestAccepted);

    /// @notice Deploys the receiver, locked to one registry and one sending wallet for good.
    /// @dev The workflow author, name and id are pinned after deployment with the template's
    ///      owner setters, author before name, because the template refuses a name with no author.
    ///      Reverts InvalidForwarderAddress on a zero forwarder (from the template) and ZeroAddress
    ///      on a zero registry or sending wallet. Emits ForwarderAddressUpdated (from the template).
    /// @param forwarder The forwarder allowed to call onReport, Chainlink's MockKeystoneForwarder.
    /// @param registry The Moolam registry that receives the attestations.
    /// @param sendingWallet The externally owned account that must sign every report transaction.
    constructor(address forwarder, address registry, address sendingWallet) ReceiverTemplate(forwarder) {
        if (registry == address(0) || sendingWallet == address(0)) revert ZeroAddress();
        REGISTRY = IMoolamRegistry(registry);
        SENDING_WALLET = sendingWallet;
    }

    /// @notice The workflow timestamp of the newest report this contract accepted for a passport.
    /// @param passportId The passport to read.
    /// @return The executedAt value from that report, zero when no report has landed yet.
    function lastExecutedAt(bytes32 passportId) external view returns (uint64) {
        return _lastExecutedAt[passportId];
    }

    /// @dev Runs after the template's forwarder and pin checks. The sender check comes first and
    ///      reads nothing from the report, so a stranger learns nothing and writes nothing. The
    ///      chain id and the executedAt window turn a resent or foreign report into a revert, and
    ///      the upper bound stops a far-future executedAt from freezing a passport's floor. The floor
    ///      lives in this contract's own storage, so it guards this receiver only.
    ///      Reverts WrongSendingWallet, WrongChain, StaleReport, ReportFromTheFuture, and whatever
    ///      the registry refuses (NotReceiver, PassportNotFound, AttestationCapReached). The
    ///      registry emits VerificationAttested.
    function _processReport(bytes calldata report) internal override {
        // tx.origin on purpose: the mock forwarder is msg.sender, so the signing wallet is the only
        // value on this path a stranger cannot reproduce. See the contract notes above.
        // solhint-disable avoid-tx-origin
        // forge-lint: disable-next-line(tx-origin)
        if (tx.origin != SENDING_WALLET) revert WrongSendingWallet(tx.origin, SENDING_WALLET);
        // solhint-enable avoid-tx-origin

        (
            uint256 chainId,
            uint64 executedAt,
            bytes32 passportId,
            bool matched,
            uint16 distance,
            bytes32 recomputed
        ) = abi.decode(report, (uint256, uint64, bytes32, bool, uint16, bytes32));

        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);

        uint64 lastSeen = _lastExecutedAt[passportId];
        if (executedAt <= lastSeen) revert StaleReport(passportId, executedAt, lastSeen);

        uint256 latestAccepted = block.timestamp + MAX_FUTURE_SKEW;
        // forge-lint: disable-next-line(block-timestamp)
        if (executedAt > latestAccepted) revert ReportFromTheFuture(passportId, executedAt, latestAccepted);

        _lastExecutedAt[passportId] = executedAt;

        REGISTRY.attest(passportId, matched, distance, recomputed);
    }
}
