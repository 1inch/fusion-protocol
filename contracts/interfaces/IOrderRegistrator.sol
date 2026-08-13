// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title IOrderRegistrator
 * @notice The announcement surface of the order registrator that anchored auctions read.
 */
interface IOrderRegistrator {
    /// @notice The time an order was first registered, or zero when it never was.
    function announcedAt(bytes32 orderHash) external view returns (uint256 timestamp);
}
