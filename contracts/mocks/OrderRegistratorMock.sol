// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

contract OrderRegistratorMock is IOrderRegistrator {
    mapping(bytes32 orderHash => uint256 timestamp) public announcedAt;

    function setAnnouncedAt(bytes32 orderHash, uint256 timestamp) external {
        announcedAt[orderHash] = timestamp;
    }

    function announcedAt(bytes32 orderHash) external view returns (uint256) {
        return announcedAt[orderHash];
    }
}
