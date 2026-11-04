// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";

import { IAaveV4TakerPositionManager } from "../../interfaces/aave-v4/IAaveV4TakerPositionManager.sol";
import { AaveV4SpokeMock } from "./AaveV4SpokeMock.sol";
import { SignedCallsMock } from "./SignedCallsMock.sol";

/// @dev Consumes the allowance by the change of the owner's position, as the real TakerPositionManager does.
contract AaveV4TakerPositionManagerMock is IAaveV4TakerPositionManager, SignedCallsMock {
    using SafeERC20 for IERC20;

    error InsufficientWithdrawAllowance(uint256 allowance, uint256 amount);

    mapping(address spoke => mapping(uint256 reserveId => mapping(address owner => mapping(address spender => uint256)))) private _allowances;

    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount) external {
        _allowances[spoke][reserveId][msg.sender][spender] = amount;
    }

    function approveWithdrawWithSig(WithdrawPermit calldata params, bytes calldata /* signature */) external {
        if (!_consumeIntent(params.owner, params.nonce)) return;
        _allowances[params.spoke][params.reserveId][params.owner][params.spender] = params.amount;
    }

    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256) {
        uint256 allowance = _allowances[spoke][reserveId][onBehalfOf][msg.sender];
        if (allowance < amount) revert InsufficientWithdrawAllowance(allowance, amount);

        uint256 suppliedBefore = AaveV4SpokeMock(spoke).getUserSuppliedAssets(reserveId, onBehalfOf);
        (uint256 shares, uint256 withdrawn) = AaveV4SpokeMock(spoke).withdraw(reserveId, amount, onBehalfOf);
        if (allowance != type(uint256).max) {
            uint256 consumed = suppliedBefore - AaveV4SpokeMock(spoke).getUserSuppliedAssets(reserveId, onBehalfOf);
            _allowances[spoke][reserveId][onBehalfOf][msg.sender] = allowance > consumed ? allowance - consumed : 0;
        }

        IERC20(AaveV4SpokeMock(spoke).getReserve(reserveId).underlying).safeTransfer(msg.sender, withdrawn);
        return (shares, withdrawn);
    }

    function renounceWithdrawAllowance(address spoke, uint256 reserveId, address owner) external {
        _allowances[spoke][reserveId][owner][msg.sender] = 0;
    }

    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender) external view returns (uint256) {
        return _allowances[spoke][reserveId][owner][spender];
    }
}
