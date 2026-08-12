// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";

import { IOrderRegistrator } from "../interfaces/IOrderRegistrator.sol";

/// @title Records announcements the way the order registrator does: write-once, at the current timestamp.
contract OrderRegistratorMock is IOrderRegistrator {
    IOrderMixin private immutable _LIMIT_ORDER_PROTOCOL;

    mapping(bytes32 orderHash => uint256 timestamp) private _announcedAt;

    constructor(IOrderMixin limitOrderProtocol) {
        _LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
    }

    function registerOrder(IOrderMixin.Order calldata order) external {
        bytes32 orderHash = _LIMIT_ORDER_PROTOCOL.hashOrder(order);
        if (_announcedAt[orderHash] == 0) {
            _announcedAt[orderHash] = block.timestamp;
        }
    }

    function announcedAt(bytes32 orderHash) external view returns (uint256 timestamp) {
        return _announcedAt[orderHash];
    }
}
