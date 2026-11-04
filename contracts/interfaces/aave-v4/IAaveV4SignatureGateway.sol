// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title Minimal Aave V4 SignatureGateway interface
 * @notice Executes Spoke actions from a user's EIP-712 signature. The user must approve the gateway as a position manager on the Spoke.
 */
interface IAaveV4SignatureGateway {
    struct SetUsingAsCollateral {
        address spoke;
        uint256 reserveId;
        bool useAsCollateral;
        address onBehalfOf;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Enables or disables `params.reserveId` as collateral for `params.onBehalfOf`.
    function setUsingAsCollateralWithSig(SetUsingAsCollateral calldata params, bytes calldata signature) external;
}
