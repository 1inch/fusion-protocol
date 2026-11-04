// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title Minimal Aave V4 GiverPositionManager interface
 * @notice Supplies to a Spoke on behalf of a user that approved this manager on the Spoke. The caller provides the funds.
 */
interface IAaveV4GiverPositionManager {
    /// @notice Pulls `amount` of the reserve underlying from the caller and supplies it for `onBehalfOf`.
    /// @return The supplied shares and the supplied amount.
    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}
