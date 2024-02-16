// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { BaseExtension } from "./extensions/BaseExtension.sol";
import { FeeIntegratorExtension } from "./extensions/FeeIntegratorExtension.sol";
import { FeeResolverExtension } from "./extensions/FeeResolverExtension.sol";
import { WhitelistExtension } from "./extensions/WhitelistExtension.sol";


/**
 * @title Simple Settlement contract
 * @notice Contract to execute limit orders settlement, created by Fusion mode.
 */
contract SimpleSettlement is WhitelistExtension, FeeResolverExtension, FeeIntegratorExtension {
    /**
     * @notice Initializes the contract.
     * @param limitOrderProtocol The limit order protocol contract.
     * @param token The token to charge protocol fees in.
     */
    constructor(address limitOrderProtocol, IERC20 token) BaseExtension(limitOrderProtocol) FeeResolverExtension(token) {}

    function _postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal virtual override(WhitelistExtension, FeeResolverExtension, FeeIntegratorExtension) {
        super._postInteraction(order, extension, orderHash, taker, makingAmount, takingAmount, remainingMakingAmount, extraData);
    }
}
