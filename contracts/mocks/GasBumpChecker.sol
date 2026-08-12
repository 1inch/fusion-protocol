// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { SimpleSettlement } from "../SimpleSettlement.sol";
import { IOrderRegistrator } from "../interfaces/IOrderRegistrator.sol";

contract GasBumpChecker is SimpleSettlement {
    error InvalidResult(uint256 actual, uint256 expected);

    constructor(IERC20 accessToken, address weth, address owner)
        SimpleSettlement(address(this), accessToken, weth, owner, IOrderRegistrator(address(0)))
    {}

    function testGetTakingAmount(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData,
        uint256 expectedResult
    ) external view {
        uint256 res = this.getTakingAmount(
            order,
            extension,
            orderHash,
            taker,
            makingAmount,
            remainingMakingAmount,
            extraData
        );
        if (res != expectedResult) revert InvalidResult(res, expectedResult);
    }
}
