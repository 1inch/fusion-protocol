// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { AnchoredDutchAuction } from "./AnchoredDutchAuction.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

/**
 * @title Partial-fill premium auction
 * @notice Dutch auction where a fill that leaves part of the order behind pays a premium, so
 * sweeping the remainder is the cheapest way to fill.
 * @dev Opt-in per order via the top bit of the auction points count, which a legacy blob never
 * sets. The curve follows the time points, read over the fill's share of the remainder in `_SHARE_BASE`:
 * ```
 * 3 bytes - initial premium, paid by a vanishing fill
 * 1 byte - points count
 * (bytes3,bytes2)[M] — premiums and share deltas
 * ```
 */
abstract contract PartialFillPremiumAuction is AnchoredDutchAuction {
    uint256 private constant _FILL_CURVE_FLAG = 0x80; // top bit of the uint8 auction points count
    uint256 private constant _SHARE_BASE = 10_000;

    /// @dev The fill curve header is a 3-byte initial premium followed by the 1-byte points count.
    uint256 private constant _CURVE_POINTS_COUNT_OFFSET = 3;
    uint256 private constant _CURVE_HEADER_SIZE = 4;

    /// @dev Each fill curve point is a 3-byte premium followed by a 2-byte share delta.
    uint256 private constant _CURVE_POINT_SIZE = 5;

    error NonMonotonicFillCurve();

    constructor(IOrderRegistrator orderRegistrator) AnchoredDutchAuction(orderRegistrator) {}

    /// @dev The auction's net bump and its fill curve, which is empty for an order without one.
    function _parseAuctionDetails(bytes32 orderHash, bytes calldata auctionDetails)
        internal view returns (int256 netBump, bytes calldata fillCurve, bytes calldata tail)
    {
        unchecked {
            (netBump, tail) = _auctionNetBump(orderHash, auctionDetails);
            if (uint8(auctionDetails[_POINTS_COUNT_OFFSET]) & _FILL_CURVE_FLAG == 0) {
                fillCurve = tail[:0];
            } else {
                uint256 length = _CURVE_HEADER_SIZE + _CURVE_POINT_SIZE * uint256(uint8(tail[_CURVE_POINTS_COUNT_OFFSET]));
                fillCurve = tail[:length];
                tail = tail[length:];
            }
        }
    }

    /// @dev Rate bump for a fill of known size; a completing fill never reads the curve.
    function _fillRateBump(int256 netBump, bytes calldata fillCurve, uint256 makingAmount, uint256 remainingMakingAmount)
        internal pure returns (uint256)
    {
        unchecked {
            if (fillCurve.length != 0 && makingAmount < remainingMakingAmount) {
                netBump += int256(_fillPremium(makingAmount, remainingMakingAmount, fillCurve));
            }
            return _clampBump(netBump);
        }
    }

    /// @dev Making-amount path: the fill size is estimated at the worst (initial) premium and
    /// repriced, which can only overstate the bump.
    function _estimatedFillRateBump(int256 netBump, bytes calldata fillCurve, uint256 unbumpedMakingAmount, uint256 remainingMakingAmount)
        internal pure returns (uint256)
    {
        unchecked {
            if (fillCurve.length == 0) return _clampBump(netBump);
            uint256 worstRateBump = _clampBump(netBump + int256(uint256(uint24(bytes3(fillCurve[0:3])))));
            uint256 estimatedMakingAmount = Math.mulDiv(unbumpedMakingAmount, _BASE_POINTS, _BASE_POINTS + worstRateBump);
            return _fillRateBump(netBump, fillCurve, estimatedMakingAmount, remainingMakingAmount);
        }
    }

    /// @dev Premium interpolated over the fill's share of the remainder, ending at zero for a full
    /// sweep. A rising curve would reward splitting a fill, so the walk rejects it lazily.
    function _fillPremium(uint256 makingAmount, uint256 remainingMakingAmount, bytes calldata fillCurve) private pure returns (uint256) {
        unchecked {
            uint256 currentPremium = uint24(bytes3(fillCurve[0:3]));
            uint256 share = Math.mulDiv(makingAmount, _SHARE_BASE, remainingMakingAmount);
            if (share == 0) return currentPremium;

            uint256 currentShare = 0;
            uint256 pointsCount = uint8(fillCurve[_CURVE_POINTS_COUNT_OFFSET]);
            bytes calldata points = fillCurve[_CURVE_HEADER_SIZE:];
            for (uint256 i = 0; i < pointsCount; i++) {
                uint256 nextPremium = uint24(bytes3(points[:3]));
                if (nextPremium > currentPremium) revert NonMonotonicFillCurve();
                uint256 nextShare = currentShare + uint16(bytes2(points[3:5]));
                if (share <= nextShare) {
                    return ((share - currentShare) * nextPremium + (nextShare - share) * currentPremium) / (nextShare - currentShare);
                }
                currentPremium = nextPremium;
                currentShare = nextShare;
                points = points[_CURVE_POINT_SIZE:];
            }
            return (_SHARE_BASE - share) * currentPremium / (_SHARE_BASE - currentShare);
        }
    }
}
