// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";

import { IAaveV4Spoke } from "../../interfaces/aave-v4/IAaveV4Spoke.sol";
import { SignedCallsMock } from "./SignedCallsMock.sol";

/**
 * @notice Aave V4 Spoke with the behaviour the collateral swap depends on: position managers, supply without
 * enabling collateral, and a health factor check on collateral withdrawals.
 * @dev Positions are kept in underlying units. Prices are in WAD per underlying unit, debt is a plain value set by tests.
 * A partial withdrawal burns 1 wei more of the position than it pays out, like share rounding in the real Spoke.
 */
contract AaveV4SpokeMock is SignedCallsMock {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error HealthFactorBelowThreshold();

    struct ReserveData {
        address underlying;
        uint256 price;
        uint16 collateralFactor;
    }

    uint256 private constant _WAD = 1e18;
    uint256 private constant _BPS = 10_000;

    ReserveData[] private _reserves;
    mapping(address user => mapping(uint256 reserveId => uint256)) private _supplied;
    mapping(address user => mapping(uint256 reserveId => bool)) private _usingAsCollateral;
    mapping(address user => uint256) public debtValue;
    mapping(address positionManager => bool) public isPositionManagerActive;
    mapping(address user => mapping(address positionManager => bool)) private _approvals;

    modifier onlyPositionManager(address onBehalfOf) {
        if (!isPositionManager(onBehalfOf, msg.sender)) revert Unauthorized();
        _;
    }

    function addReserve(address underlying, uint256 price, uint16 collateralFactor) external returns (uint256 reserveId) {
        reserveId = _reserves.length;
        _reserves.push(ReserveData(underlying, price, collateralFactor));
    }

    function setPrice(uint256 reserveId, uint256 price) external {
        _reserves[reserveId].price = price;
    }

    function setDebt(address user, uint256 value) external {
        debtValue[user] = value;
    }

    function setPositionManagerActive(address positionManager, bool active) external {
        isPositionManagerActive[positionManager] = active;
    }

    function setUserPositionManager(address positionManager, bool approve) external {
        _approvals[msg.sender][positionManager] = approve;
    }

    function setUserPositionManagersWithSig(IAaveV4Spoke.SetUserPositionManagers calldata params, bytes calldata /* signature */) external {
        if (!_consumeIntent(params.onBehalfOf, params.nonce)) return;
        for (uint256 i = 0; i < params.updates.length; i++) {
            _approvals[params.onBehalfOf][params.updates[i].positionManager] = params.updates[i].approve;
        }
    }

    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external onlyPositionManager(onBehalfOf) returns (uint256, uint256) {
        IERC20(_reserves[reserveId].underlying).safeTransferFrom(msg.sender, address(this), amount);
        _supplied[onBehalfOf][reserveId] += amount;
        return (amount, amount);
    }

    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external onlyPositionManager(onBehalfOf) returns (uint256, uint256) {
        uint256 supplied = _supplied[onBehalfOf][reserveId];
        uint256 withdrawn = amount < supplied ? amount : supplied;
        uint256 burned = withdrawn < supplied ? withdrawn + 1 : withdrawn;
        _supplied[onBehalfOf][reserveId] = supplied - burned;
        if (_usingAsCollateral[onBehalfOf][reserveId] && healthFactor(onBehalfOf) < _WAD) revert HealthFactorBelowThreshold();
        IERC20(_reserves[reserveId].underlying).safeTransfer(msg.sender, withdrawn);
        return (burned, withdrawn);
    }

    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external onlyPositionManager(onBehalfOf) {
        _usingAsCollateral[onBehalfOf][reserveId] = usingAsCollateral;
        if (!usingAsCollateral && healthFactor(onBehalfOf) < _WAD) revert HealthFactorBelowThreshold();
    }

    function isPositionManager(address user, address positionManager) public view returns (bool) {
        return user == positionManager || (isPositionManagerActive[positionManager] && _approvals[user][positionManager]);
    }

    function getReserve(uint256 reserveId) external view returns (IAaveV4Spoke.Reserve memory reserve) {
        reserve.underlying = _reserves[reserveId].underlying;
    }

    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256) {
        return _supplied[user][reserveId];
    }

    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool) {
        return (_usingAsCollateral[user][reserveId], false);
    }

    function getUserAccountData(address user) external view returns (IAaveV4Spoke.UserAccountData memory data) {
        data.healthFactor = healthFactor(user);
    }

    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = debtValue[user];
        if (debt == 0) return type(uint256).max;
        uint256 weightedCollateral;
        for (uint256 i = 0; i < _reserves.length; i++) {
            if (_usingAsCollateral[user][i]) {
                weightedCollateral += _supplied[user][i] * _reserves[i].price / _WAD * _reserves[i].collateralFactor / _BPS;
            }
        }
        return weightedCollateral * _WAD / debt;
    }
}
