// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SlotDerivation } from "@openzeppelin/contracts/utils/SlotDerivation.sol";
import { TransientSlot } from "@openzeppelin/contracts/utils/TransientSlot.sol";
import { Address, AddressLib } from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IPreInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPreInteraction.sol";
import { IPostInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPostInteraction.sol";
import { ExtensionLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/ExtensionLib.sol";

import {
    IAaveV4Spoke,
    IAaveV4GiverPositionManager,
    IAaveV4TakerPositionManager,
    IAaveV4SignatureGateway
} from "./interfaces/IAaveV4.sol";

/**
 * @title Aave V4 collateral swap adapter (proof of concept)
 * @notice Lets a Fusion order swap one Aave V4 supply position into another on the same Spoke, with the taker paying first.
 * @dev The order uses this contract as its maker asset, so the maker-to-taker transfer of the Limit Order Protocol only
 * records where the maker's collateral has to go. The settlement then forwards the taker asset here as the custom receiver
 * and calls `postInteraction`, which supplies it on behalf of the maker and only afterwards withdraws the maker's collateral
 * to the taker. The Spoke checks the health factor on that withdrawal, with the new collateral already in place.
 *
 * Order layout:
 * - `makerAsset` is this contract and `makerAssetSuffix` is `abi.encode(spoke, sellReserveId)`.
 * - `takerAsset` is the underlying token of the buy reserve.
 * - `preInteraction` is this contract followed by `abi.encode(Permits)`, or by nothing when the maker approved on-chain.
 * - The settlement post-interaction names this contract as the custom receiver and as the extra post-interaction,
 *   with `abi.encode(buyReserveId)` as its data.
 */
contract AaveV4CollateralSwapAdapter is IPreInteraction, IPostInteraction {
    using AddressLib for Address;
    using SafeERC20 for IERC20;
    using ExtensionLib for bytes;
    using SlotDerivation for bytes32;
    using TransientSlot for *;

    struct Permits {
        IAaveV4Spoke.SetUserPositionManagers positionManagers;
        bytes positionManagersSignature;
        IAaveV4SignatureGateway.SetUsingAsCollateral collateral;
        bytes collateralSignature;
        IAaveV4TakerPositionManager.WithdrawPermit withdrawal;
        bytes withdrawalSignature;
    }

    error OnlyLimitOrderProtocol();
    error OnlySettlement();
    error UnexpectedMakerTransfer();
    error MakerTransferNotRecorded();
    error TakerAssetMismatch();
    error InsufficientWithdrawal(uint256 withdrawn, uint256 expected);

    /// @dev Fill being executed: order hash, maker, making amount, taker asset balance. Set by `preInteraction`, consumed by `transferFrom`.
    bytes32 private constant _FILL_SLOT = keccak256("AaveV4CollateralSwapAdapter.fill");
    /// @dev Per order hash: target, spoke, sell reserve id, taker asset balance. Set by `transferFrom`, consumed by `postInteraction`.
    bytes32 private constant _PENDING_SLOT = keccak256("AaveV4CollateralSwapAdapter.pending");

    address private immutable _LIMIT_ORDER_PROTOCOL;
    address private immutable _SETTLEMENT;
    IAaveV4GiverPositionManager private immutable _GIVER;
    IAaveV4TakerPositionManager private immutable _TAKER;
    IAaveV4SignatureGateway private immutable _SIGNATURE_GATEWAY;

    constructor(
        address limitOrderProtocol,
        address settlement,
        IAaveV4GiverPositionManager giver,
        IAaveV4TakerPositionManager taker,
        IAaveV4SignatureGateway signatureGateway
    ) {
        _LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
        _SETTLEMENT = settlement;
        _GIVER = giver;
        _TAKER = taker;
        _SIGNATURE_GATEWAY = signatureGateway;
    }

    /**
     * @notice Applies the maker's Aave V4 signatures and opens the fill.
     * @dev Every signature is optional and failures are ignored, so a later partial fill or a front-run signature does not block the order.
     */
    function preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata extraData
    ) external {
        if (msg.sender != _LIMIT_ORDER_PROTOCOL) revert OnlyLimitOrderProtocol();

        if (extraData.length > 0) {
            (address spoke, ) = abi.decode(extension.makerAssetSuffix(), (address, uint256));
            _applyPermits(spoke, abi.decode(extraData, (Permits)));
        }

        _FILL_SLOT.asBytes32().tstore(orderHash);
        _FILL_SLOT.offset(1).asAddress().tstore(order.maker.get());
        _FILL_SLOT.offset(2).asUint256().tstore(makingAmount);
        _FILL_SLOT.offset(3).asUint256().tstore(IERC20(order.takerAsset.get()).balanceOf(address(this)));
    }

    /**
     * @notice Maker asset hook of the Limit Order Protocol. Records the transfer instead of executing it.
     * @dev Called with `abi.encode(spoke, sellReserveId)` appended to the standard arguments.
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != _LIMIT_ORDER_PROTOCOL) revert OnlyLimitOrderProtocol();

        bytes32 orderHash = _FILL_SLOT.asBytes32().tload();
        if (
            orderHash == bytes32(0) ||
            _FILL_SLOT.offset(1).asAddress().tload() != from ||
            _FILL_SLOT.offset(2).asUint256().tload() != amount
        ) revert UnexpectedMakerTransfer();
        _FILL_SLOT.asBytes32().tstore(bytes32(0));

        bytes32 pending = _PENDING_SLOT.deriveMapping(orderHash);
        if (pending.asAddress().tload() != address(0)) revert UnexpectedMakerTransfer();

        (address spoke, uint256 sellReserveId) = abi.decode(msg.data[100:], (address, uint256));
        pending.asAddress().tstore(to);
        pending.offset(1).asAddress().tstore(spoke);
        pending.offset(2).asUint256().tstore(sellReserveId);
        pending.offset(3).asUint256().tstore(_FILL_SLOT.offset(3).asUint256().tload());
        return true;
    }

    /**
     * @notice Extra post-interaction called by the settlement after the taker has paid and the fees are taken.
     * Supplies the received taker asset on behalf of the maker, then withdraws the maker's collateral to the recorded target.
     */
    function postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata /* extension */,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata extraData
    ) external {
        if (msg.sender != _SETTLEMENT) revert OnlySettlement();

        bytes32 pending = _PENDING_SLOT.deriveMapping(orderHash);
        address to = pending.asAddress().tload();
        if (to == address(0)) revert MakerTransferNotRecorded();
        address spoke = pending.offset(1).asAddress().tload();
        uint256 sellReserveId = pending.offset(2).asUint256().tload();
        uint256 takerAssetBalanceBefore = pending.offset(3).asUint256().tload();
        pending.asAddress().tstore(address(0));

        uint256 buyReserveId = abi.decode(extraData, (uint256));
        address maker = order.maker.get();
        IERC20 takerAsset = IERC20(order.takerAsset.get());
        if (IAaveV4Spoke(spoke).getReserve(buyReserveId).underlying != address(takerAsset)) revert TakerAssetMismatch();

        uint256 received = takerAsset.balanceOf(address(this)) - takerAssetBalanceBefore;
        takerAsset.forceApprove(address(_GIVER), received);
        _GIVER.supplyOnBehalfOf(spoke, buyReserveId, received, maker);

        (, uint256 withdrawn) = _TAKER.withdrawOnBehalfOf(spoke, sellReserveId, makingAmount, maker);
        if (withdrawn < makingAmount) revert InsufficientWithdrawal(withdrawn, makingAmount);
        IERC20(IAaveV4Spoke(spoke).getReserve(sellReserveId).underlying).safeTransfer(to, makingAmount);
    }

    function _applyPermits(address spoke, Permits memory permits) private {
        if (permits.positionManagers.deadline != 0) {
            try IAaveV4Spoke(spoke).setUserPositionManagersWithSig(permits.positionManagers, permits.positionManagersSignature) {} catch {}
        }
        if (permits.collateral.deadline != 0) {
            try _SIGNATURE_GATEWAY.setUsingAsCollateralWithSig(permits.collateral, permits.collateralSignature) {} catch {}
        }
        if (permits.withdrawal.deadline != 0) {
            try _TAKER.approveWithdrawWithSig(permits.withdrawal, permits.withdrawalSignature) {} catch {}
        }
    }
}
