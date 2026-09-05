// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

/**
 * @title IOrderRegistrator
 * @notice The announcement surface of the order registrator that anchored auctions read.
 */
interface IOrderRegistrator {
    /**
     * @notice Returns the time an order was first registered, or zero when it never was.
     * @param orderHash The hash of the order.
     * @return timestamp The block timestamp of the first registration.
     */
    function announcedAt(bytes32 orderHash) external view returns (uint256 timestamp);
}
