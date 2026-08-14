// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IOrderRegistrator as IOrderRegistratorBase } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderRegistrator.sol";

/**
 * @title IOrderRegistrator
 * @notice Extends the package interface with the announcement timestamp getter from limit-order-protocol PR #431.
 * @dev Once the getter is released in the package interface, this file can be removed in favor of it.
 */
interface IOrderRegistrator is IOrderRegistratorBase {
    /**
     * @notice Returns the timestamp when the order was first announced.
     * @param orderHash The hash of the order.
     * @return timestamp The block timestamp of the first announcement, or 0 if the order was not announced.
     */
    function announcedAt(bytes32 orderHash) external view returns (uint256 timestamp);
}
