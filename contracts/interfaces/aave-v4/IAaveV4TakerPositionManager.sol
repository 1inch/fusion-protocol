// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title Minimal Aave V4 TakerPositionManager interface
 * @notice Withdraws from a Spoke on behalf of a user, within a per-reserve allowance the user grants to the caller.
 */
interface IAaveV4TakerPositionManager {
    struct WithdrawPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Sets the withdraw allowance described by `params` with the owner's EIP-712 signature. The allowance is replaced, not increased.
    function approveWithdrawWithSig(WithdrawPermit calldata params, bytes calldata signature) external;

    /// @notice Withdraws up to `amount` of `onBehalfOf`'s supply in `reserveId` and sends it to the caller.
    /// @return The withdrawn shares and the withdrawn amount.
    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);

    /// @notice Sets the caller's withdraw allowance from `owner` to zero.
    function renounceWithdrawAllowance(address spoke, uint256 reserveId, address owner) external;

    /// @notice Returns how much `spender` may withdraw from `owner`'s supply in `reserveId`.
    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender) external view returns (uint256);
}
