// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

/**
 * @title IOrderRegistrator
 * @notice Minimal interface for reading order registration timestamps.
 */
interface IOrderRegistrator {
    /**
     * @notice Returns the timestamp when the order was registered.
     * @param orderHash The hash of the order.
     * @return The block timestamp of the registration, or 0 if the order was not registered.
     */
    function registeredAt(bytes32 orderHash) external view returns (uint256);
}
