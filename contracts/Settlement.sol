// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";
import { SimpleSettlement } from "./SimpleSettlement.sol";

/**
 * @title Settlement contract
 * @notice Contract to execute limit orders settlement on Mainnet, created by Fusion mode.
 */
contract Settlement is SimpleSettlement {
    error InvalidPriorityFee();

    constructor(address limitOrderProtocol, IERC20 accessToken, address weth, address owner, IOrderRegistrator orderRegistrator)
        SimpleSettlement(limitOrderProtocol, accessToken, weth, owner, orderRegistrator)
    {}

    function _postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal virtual override {
        if (!_isPriorityFeeValid()) revert InvalidPriorityFee();
        super._postInteraction(order, extension, orderHash, taker, makingAmount, takingAmount, remainingMakingAmount, extraData);
    }

    /**
     * @dev Validates priority fee according to the spec
     * https://snapshot.org/#/1inch.eth/proposal/0xa040c60050147a0f67042ae024673e92e813b5d2c0f748abf70ddfa1ed107cbe
     * For blocks with baseFee <10.6 gwei – the priorityFee is capped at 70% of the baseFee.
     * For blocks with baseFee between 10.6 gwei and 104.1 gwei – the priorityFee is capped at 50% of the baseFee.
     * For blocks with baseFee >104.1 gwei – priorityFee is capped at 65% of the block’s baseFee.
     */
    function _isPriorityFeeValid() internal view returns(bool) {
        unchecked {
            uint256 baseFee = block.basefee;
            uint256 priorityFee = tx.gasprice - baseFee;

            if (baseFee < 10.6 gwei) {
                return priorityFee * 100 <= baseFee * 70;
            } else if (baseFee > 104.1 gwei) {
                return priorityFee * 100 <= baseFee * 65;
            } else {
                return priorityFee * 2 <= baseFee;
            }
        }
    }
}
