// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IAaveV4Spoke } from "./aave-v4/IAaveV4Spoke.sol";
import { IAaveV4SignatureGateway } from "./aave-v4/IAaveV4SignatureGateway.sol";
import { IAaveV4TakerPositionManager } from "./aave-v4/IAaveV4TakerPositionManager.sol";

/**
 * @title Aave V4 collateral swap extension
 * @notice Swaps one Aave V4 supply position into another on the same Spoke through a Fusion order, with the taker paying first.
 */
interface IAaveV4CollateralSwap {
    /**
     * @notice Swap parameters, ABI-encoded as the order's maker asset suffix.
     * @param spoke The Spoke holding both reserves.
     * @param sellReserveId The reserve the maker sells. Its underlying goes to the taker.
     * @param buyReserveId The reserve that receives the taker asset. Its underlying must be the order's taker asset.
     * @param minHealthFactor Minimum health factor of the maker after each fill, in WAD. Zero keeps only Aave's own check.
     * @param maxDust On the final fill, a leftover of at most this amount in the sell reserve is withdrawn too and sent to the maker.
     * @param flags Bit 0 renounces the withdraw allowance on the final fill. Bit 1 requires the buy reserve to be enabled as collateral.
     */
    struct SwapParams {
        address spoke;
        uint256 sellReserveId;
        uint256 buyReserveId;
        uint256 minHealthFactor;
        uint256 maxDust;
        uint256 flags;
    }

    /**
     * @notice Aave V4 signatures of the maker, applied on the first fill. A permit with a zero deadline is skipped.
     * @param positionManagers Approves the Giver, Taker and SignatureGateway position managers on the Spoke.
     * @param collateral Enables the buy reserve as collateral through the SignatureGateway.
     * @param withdrawal Grants this contract a withdraw allowance on the sell reserve.
     */
    struct Permits {
        IAaveV4Spoke.SetUserPositionManagers positionManagers;
        bytes positionManagersSignature;
        IAaveV4SignatureGateway.SetUsingAsCollateral collateral;
        bytes collateralSignature;
        IAaveV4TakerPositionManager.WithdrawPermit withdrawal;
        bytes withdrawalSignature;
    }

    /**
     * @notice Emitted after each fill.
     * @param orderHash The filled order.
     * @param maker The owner of the position.
     * @param spoke The Spoke holding both reserves.
     * @param sellReserveId The reserve the collateral was withdrawn from.
     * @param buyReserveId The reserve the taker asset was supplied to.
     * @param withdrawn The amount withdrawn from the sell reserve, including any dust sent to the maker.
     * @param supplied The amount supplied to the buy reserve.
     * @param recipient The fill target that received the sold collateral.
     */
    event CollateralSwap(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed spoke,
        uint256 sellReserveId,
        uint256 buyReserveId,
        uint256 withdrawn,
        uint256 supplied,
        address recipient
    );

    error TakerAssetMismatch();
    error SameReserve();
    error InvalidPermit();
    error CollateralNotEnabled();
    error InsufficientWithdrawal(uint256 withdrawn, uint256 expected);
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);
}
