// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";

import { IAaveV4GiverPositionManager } from "../../interfaces/aave-v4/IAaveV4GiverPositionManager.sol";
import { AaveV4SpokeMock } from "./AaveV4SpokeMock.sol";

contract AaveV4GiverPositionManagerMock is IAaveV4GiverPositionManager {
    using SafeERC20 for IERC20;

    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        IERC20 underlying = IERC20(AaveV4SpokeMock(spoke).getReserve(reserveId).underlying);
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        underlying.forceApprove(spoke, amount);
        return AaveV4SpokeMock(spoke).supply(reserveId, amount, onBehalfOf);
    }
}
