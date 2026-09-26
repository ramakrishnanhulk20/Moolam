// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IReceiver} from "../../src/vendor/chainlink/IReceiver.sol";

/// @notice A local copy of Chainlink's MockKeystoneForwarder, as traced on mainnet: anyone may call
///         report, no signature is checked, and a reverting receiver does not revert the transaction.
contract LocalMockForwarder {
    uint256 internal constant FORWARDER_METADATA_LENGTH = 45;
    uint256 internal constant METADATA_LENGTH = 109;

    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external {
        bytes32 executionId = bytes32(rawReport[1:33]);
        bytes2 reportId = bytes2(rawReport[107:109]);
        (bool ok,) = receiver.call(
            abi.encodeCall(
                IReceiver.onReport,
                (rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH], rawReport[METADATA_LENGTH:])
            )
        );
        emit ReportProcessed(receiver, executionId, reportId, ok);
    }
}
