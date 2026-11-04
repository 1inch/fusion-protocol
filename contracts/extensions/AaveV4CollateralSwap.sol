// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Address, AddressLib } from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { ExtensionLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/ExtensionLib.sol";

import { IAaveV4CollateralSwap } from "../interfaces/IAaveV4CollateralSwap.sol";
import { IAaveV4Spoke } from "../interfaces/aave-v4/IAaveV4Spoke.sol";
import { IAaveV4GiverPositionManager } from "../interfaces/aave-v4/IAaveV4GiverPositionManager.sol";
import { IAaveV4TakerPositionManager } from "../interfaces/aave-v4/IAaveV4TakerPositionManager.sol";
import { IAaveV4SignatureGateway } from "../interfaces/aave-v4/IAaveV4SignatureGateway.sol";
import { DeferredMakerAsset } from "./DeferredMakerAsset.sol";

/**
 * @title Aave V4 collateral swap
 * @notice Lets a Fusion order swap one Aave V4 supply position into another on the same Spoke, with the taker paying first.
 * @dev The Spoke re-checks the health factor whenever collateral is withdrawn, so the new asset has to be supplied before
 * the old one leaves. A regular fill moves the maker asset first; here the maker asset is this contract, and the
 * withdrawal happens in the post-interaction, after the taker asset was supplied for the maker through the Aave V4
 * GiverPositionManager. The withdrawal goes through the TakerPositionManager, within the allowance the maker granted.
 *
 * Order layout:
 * - `makerAsset` is this contract and `makerAssetSuffix` is `abi.encode(SwapParams)`.
 * - `takerAsset` is the underlying of the buy reserve.
 * - `receiver` is this contract, or the Settlement with this contract as its custom receiver.
 * - `preInteraction` is this contract, optionally followed by `abi.encode(Permits)`.
 * - `postInteraction` is the Settlement with this contract as its chained post-interaction, or this contract alone.
 */
contract AaveV4CollateralSwap is IAaveV4CollateralSwap, DeferredMakerAsset {
    using AddressLib for Address;
    using SafeERC20 for IERC20;
    using ExtensionLib for bytes;

    uint256 private constant _RENOUNCE_ALLOWANCE_FLAG = 1 << 0;
    uint256 private constant _REQUIRE_COLLATERAL_FLAG = 1 << 1;
    uint256 private constant _SWAP_PARAMS_LENGTH = 6 * 32;

    /// @notice Supplies the taker asset to the buy reserve on behalf of the maker.
    IAaveV4GiverPositionManager public immutable GIVER_POSITION_MANAGER;
    /// @notice Withdraws the sold collateral on behalf of the maker, within the allowance granted to this contract.
    IAaveV4TakerPositionManager public immutable TAKER_POSITION_MANAGER;
    /// @notice Enables the buy reserve as collateral from the maker's signature.
    IAaveV4SignatureGateway public immutable SIGNATURE_GATEWAY;

    /**
     * @param limitOrderProtocol The Limit Order Protocol (1inch Router V6).
     * @param settlement The Fusion Settlement.
     * @param giverPositionManager The Aave V4 GiverPositionManager of this chain.
     * @param takerPositionManager The Aave V4 TakerPositionManager of this chain.
     * @param signatureGateway The Aave V4 SignatureGateway of this chain.
     * @param initialOwner The owner, who can only rescue tokens sent to this contract by mistake.
     */
    constructor(
        address limitOrderProtocol,
        address settlement,
        IAaveV4GiverPositionManager giverPositionManager,
        IAaveV4TakerPositionManager takerPositionManager,
        IAaveV4SignatureGateway signatureGateway,
        address initialOwner
    ) DeferredMakerAsset(limitOrderProtocol, settlement, initialOwner) {
        GIVER_POSITION_MANAGER = giverPositionManager;
        TAKER_POSITION_MANAGER = takerPositionManager;
        SIGNATURE_GATEWAY = signatureGateway;
    }

    /**
     * @dev Adds the swap parameter checks: two different reserves, and the buy reserve's underlying is the taker asset.
     */
    function _validateOrder(IOrderMixin.Order calldata order, bytes calldata extension) internal view override {
        super._validateOrder(order, extension);
        SwapParams calldata params = _swapParams(extension);
        if (params.sellReserveId == params.buyReserveId) revert SameReserve();
        if (IAaveV4Spoke(params.spoke).getReserve(params.buyReserveId).underlying != order.takerAsset.get()) revert TakerAssetMismatch();
    }

    /**
     * @dev On the first fill, validates and applies the maker's Aave V4 signatures. They are applied in try/catch, so a
     * signature that was already used, for example by a front-runner, does not block the order.
     */
    function _beforeMakerTransfer(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal override {
        if (extraData.length == 0 || remainingMakingAmount != order.makingAmount) return;

        SwapParams calldata params = _swapParams(extension);
        Permits memory permits = abi.decode(extraData, (Permits));
        _validatePermits(params, order.maker.get(), permits);
        _applyPermits(params.spoke, permits);
    }

    /**
     * @dev Supplies what the taker paid for the maker, then withdraws the sold collateral to the fill target.
     * The Spoke checks the health factor on that withdrawal, with the new supply already counted.
     */
    function _settle(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        uint256 makingAmount,
        uint256 remainingMakingAmount,
        uint256 received,
        address target
    ) internal override {
        SwapParams calldata params = _swapParams(extension);
        IAaveV4Spoke spoke = IAaveV4Spoke(params.spoke);
        address maker = order.maker.get();

        IERC20(order.takerAsset.get()).forceApprove(address(GIVER_POSITION_MANAGER), received);
        GIVER_POSITION_MANAGER.supplyOnBehalfOf(address(spoke), params.buyReserveId, received, maker);

        // A resolver can make the try/catch'd collateral signature fail by forwarding too little gas.
        if (params.flags & _REQUIRE_COLLATERAL_FLAG != 0) {
            (bool usingAsCollateral, ) = spoke.getUserReserveStatus(params.buyReserveId, maker);
            if (!usingAsCollateral) revert CollateralNotEnabled();
        }

        bool finalFill = makingAmount == remainingMakingAmount;
        (, uint256 withdrawn) = TAKER_POSITION_MANAGER.withdrawOnBehalfOf(
            address(spoke),
            params.sellReserveId,
            _withdrawAmount(params, maker, makingAmount, finalFill),
            maker
        );
        if (withdrawn < makingAmount) revert InsufficientWithdrawal(withdrawn, makingAmount);

        IERC20 sellAsset = IERC20(spoke.getReserve(params.sellReserveId).underlying);
        sellAsset.safeTransfer(target, makingAmount);
        if (withdrawn > makingAmount) {
            sellAsset.safeTransfer(maker, withdrawn - makingAmount);
        }

        if (finalFill && params.flags & _RENOUNCE_ALLOWANCE_FLAG != 0) {
            TAKER_POSITION_MANAGER.renounceWithdrawAllowance(address(spoke), params.sellReserveId, maker);
        }

        if (params.minHealthFactor != 0) {
            uint256 healthFactor = spoke.getUserAccountData(maker).healthFactor;
            if (healthFactor < params.minHealthFactor) revert HealthFactorTooLow(healthFactor, params.minHealthFactor);
        }

        emit CollateralSwap(orderHash, maker, address(spoke), params.sellReserveId, params.buyReserveId, withdrawn, received, target);
    }

    /**
     * @dev The making amount, or on the final fill the whole supply when the leftover is within `maxDust`, capped by the allowance.
     */
    function _withdrawAmount(SwapParams calldata params, address maker, uint256 makingAmount, bool finalFill) private view returns (uint256) {
        if (!finalFill || params.maxDust == 0) return makingAmount;

        uint256 supplied = IAaveV4Spoke(params.spoke).getUserSuppliedAssets(params.sellReserveId, maker);
        if (supplied <= makingAmount || supplied - makingAmount > params.maxDust) return makingAmount;

        uint256 allowance = TAKER_POSITION_MANAGER.withdrawAllowance(params.spoke, params.sellReserveId, maker, address(this));
        uint256 amount = supplied < allowance ? supplied : allowance;
        return amount > makingAmount ? amount : makingAmount;
    }

    /**
     * @dev Rejects signatures that would do anything other than this order needs: approve the three position managers,
     * enable the buy reserve as collateral, and let this contract withdraw from the sell reserve.
     */
    function _validatePermits(SwapParams calldata params, address maker, Permits memory permits) private view {
        if (permits.positionManagers.deadline != 0) {
            if (permits.positionManagers.onBehalfOf != maker) revert InvalidPermit();
            IAaveV4Spoke.PositionManagerUpdate[] memory updates = permits.positionManagers.updates;
            for (uint256 i = 0; i < updates.length; i++) {
                address positionManager = updates[i].positionManager;
                if (
                    !updates[i].approve ||
                    (
                        positionManager != address(GIVER_POSITION_MANAGER) &&
                        positionManager != address(TAKER_POSITION_MANAGER) &&
                        positionManager != address(SIGNATURE_GATEWAY)
                    )
                ) revert InvalidPermit();
            }
        }

        IAaveV4SignatureGateway.SetUsingAsCollateral memory collateral = permits.collateral;
        if (
            collateral.deadline != 0 &&
            (
                collateral.spoke != params.spoke ||
                collateral.reserveId != params.buyReserveId ||
                !collateral.useAsCollateral ||
                collateral.onBehalfOf != maker
            )
        ) revert InvalidPermit();

        IAaveV4TakerPositionManager.WithdrawPermit memory withdrawal = permits.withdrawal;
        if (
            withdrawal.deadline != 0 &&
            (
                withdrawal.spoke != params.spoke ||
                withdrawal.reserveId != params.sellReserveId ||
                withdrawal.owner != maker ||
                withdrawal.spender != address(this)
            )
        ) revert InvalidPermit();
    }

    /**
     * @dev Position managers first: the SignatureGateway and the TakerPositionManager only work once the maker approved them.
     */
    function _applyPermits(address spoke, Permits memory permits) private {
        if (permits.positionManagers.deadline != 0) {
            try IAaveV4Spoke(spoke).setUserPositionManagersWithSig(permits.positionManagers, permits.positionManagersSignature) {} catch {}
        }
        if (permits.collateral.deadline != 0) {
            try SIGNATURE_GATEWAY.setUsingAsCollateralWithSig(permits.collateral, permits.collateralSignature) {} catch {}
        }
        if (permits.withdrawal.deadline != 0) {
            try TAKER_POSITION_MANAGER.approveWithdrawWithSig(permits.withdrawal, permits.withdrawalSignature) {} catch {}
        }
    }

    function _swapParams(bytes calldata extension) private pure returns (SwapParams calldata params) {
        bytes calldata suffix = extension.makerAssetSuffix();
        if (suffix.length != _SWAP_PARAMS_LENGTH) revert UnsupportedOrder();
        assembly ("memory-safe") {
            params := suffix.offset
        }
    }
}
