// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IOrderRegistrator } from "../interfaces/IOrderRegistrator.sol";

contract OrderRegistratorMock is IOrderRegistrator {
    mapping(bytes32 orderHash => uint256 timestamp) public override registeredAt;

    function setRegisteredAt(bytes32 orderHash, uint256 timestamp) external {
        registeredAt[orderHash] = timestamp;
    }
}
