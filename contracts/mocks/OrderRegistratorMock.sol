// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IOrderRegistrator } from "../interfaces/IOrderRegistrator.sol";

contract OrderRegistratorMock is IOrderRegistrator {
    IOrderMixin private immutable _LIMIT_ORDER_PROTOCOL;

    mapping(bytes32 orderHash => uint256 timestamp) public announcedAt;

    constructor(IOrderMixin limitOrderProtocol) {
        _LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
    }

    function setAnnouncedAt(bytes32 orderHash, uint256 timestamp) external {
        announcedAt[orderHash] = timestamp;
    }

    /// @dev Stores the first announcement timestamp like the real registrator, but skips signature validation.
    function registerOrder(IOrderMixin.Order calldata order, bytes calldata extension, bytes calldata signature) external {
        bytes32 orderHash = _LIMIT_ORDER_PROTOCOL.hashOrder(order);
        if (announcedAt[orderHash] == 0) {
            announcedAt[orderHash] = block.timestamp;
        }
        emit OrderRegistered(order, extension, signature);
    }
}
