// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IReceiver} from "../../src/vendor/chainlink/IReceiver.sol";

/// @notice A local stand-in for Chainlink's MockKeystoneForwarder, the contract `cre workflow
///         simulate --broadcast` sends reports through. It keeps the three behaviours the receiver
///         tests depend on, read off a trace of the live one at 0x9eF6468C5f37b976E57d52054c693269479A784d:
///         anyone may call report, no signature is checked, and a receiver that reverts does not
///         revert the transaction. The result is only visible in the ReportProcessed event.
/// @dev The raw report starts with a 109 byte header. The receiver is handed bytes 45 to 109 as
///      metadata (workflow id, name, owner, report id) and everything after as the report.
contract LocalMockForwarder {
    uint256 internal constant FORWARDER_METADATA_LENGTH = 45;
    uint256 internal constant METADATA_LENGTH = 109;

    /// @notice Same signature and topic as the live mock's event.
    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    /// @notice Delivers a report to a receiver without checking anything, like the live mock.
    /// @param receiver The receiver to call.
    /// @param rawReport The 109 byte header followed by the workflow's payload.
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
