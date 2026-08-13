// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

/**
 * @title Dutch Auction base contract
 * @notice Time-curve rate bump math shared by settlement contracts and auction extensions.
 */
abstract contract DutchAuctionBase {
    uint256 internal constant _BASE_POINTS = 10_000_000; // 100%
    uint256 internal constant _GAS_PRICE_BASE = 1_000_000; // 1000 means 1 Gwei

    /// @dev The top bit of the points count is reserved for extensions to flag their own fields.
    uint256 private constant _POINTS_COUNT_MASK = 0x7f;

    /**
     * @dev Parses auction rate bump data from the `auctionDetails` field.
     * `gasBumpEstimate` and `gasPriceEstimate` are used to estimate the transaction costs
     * which are then offset from the auction rate bump.
     * @param auctionDetails AuctionDetails is a tightly packed struct of the following format:
     * ```
     * struct AuctionDetails {
     *     bytes3 gasBumpEstimate;
     *     bytes4 gasPriceEstimate;
     *     bytes4 auctionStartTime;
     *     bytes3 auctionDuration;
     *     bytes3 initialRateBump;
     *     (bytes3,bytes2)[N] pointsAndTimeDeltas;
     * }
     * ```
     * @return rateBump The rate bump.
     * @return Remaining calldata after parsing auction data.
     */
    function _getRateBump(bytes calldata auctionDetails) internal view virtual returns (uint256, bytes calldata) {
        (int256 netBump, bytes calldata tail) = _getNetBump(auctionDetails);
        return (_clampBump(netBump), tail);
    }

    /// @dev Auction bump net of the gas bump; negative when the gas bump exceeds it.
    function _getNetBump(bytes calldata auctionDetails) internal view virtual returns (int256 netBump, bytes calldata tail) {
        unchecked {
            uint256 auctionStartTime = uint32(bytes4(auctionDetails[7:11]));
            uint256 auctionFinishTime = auctionStartTime + uint24(bytes3(auctionDetails[11:14]));
            uint256 initialRateBump = uint24(bytes3(auctionDetails[14:17]));
            uint256 auctionBump;
            (auctionBump, tail) = _getAuctionBump(auctionStartTime, auctionFinishTime, initialRateBump, auctionDetails[17:]);
            netBump = int256(auctionBump) - int256(_getGasBump(auctionDetails));
        }
    }

    /// @dev The rate bump estimating the taker's transaction costs at the current base fee.
    function _getGasBump(bytes calldata auctionDetails) internal view returns (uint256) {
        unchecked {
            uint256 gasBumpEstimate = uint24(bytes3(auctionDetails[0:3]));
            uint256 gasPriceEstimate = uint32(bytes4(auctionDetails[3:7]));
            return gasBumpEstimate == 0 || gasPriceEstimate == 0 ? 0 : gasBumpEstimate * block.basefee / gasPriceEstimate / _GAS_PRICE_BASE;
        }
    }

    /// @dev Clamps a net bump to a non-negative rate bump.
    function _clampBump(int256 netBump) internal pure returns (uint256) {
        return netBump > 0 ? uint256(netBump) : 0;
    }

    /**
     * @dev Calculates auction price bump. Auction is represented as a piecewise linear function with `N` points.
     * Each point is represented as a pair of `(rateBump, timeDelta)`, where `rateBump` is the
     * rate bump in basis points and `timeDelta` is the time delta in seconds.
     * The rate bump is interpolated linearly between the points.
     * The last point is assumed to be `(0, auctionDuration)`.
     * @param auctionStartTime The time when the auction starts.
     * @param auctionFinishTime The time when the auction finishes.
     * @param initialRateBump The initial rate bump.
     * @param pointsAndTimeDeltas The points and time deltas structure.
     * @return The rate bump at the current time.
     * @return Remaining calldata after the parsed points.
     */
    function _getAuctionBump(
        uint256 auctionStartTime, uint256 auctionFinishTime, uint256 initialRateBump, bytes calldata pointsAndTimeDeltas
    ) internal view virtual returns (uint256, bytes calldata) {
        unchecked {
            uint256 currentPointTime = auctionStartTime;
            uint256 currentRateBump = initialRateBump;
            uint256 pointsCount = uint8(pointsAndTimeDeltas[0]) & _POINTS_COUNT_MASK;
            pointsAndTimeDeltas = pointsAndTimeDeltas[1:];
            bytes calldata tail = pointsAndTimeDeltas[5 * pointsCount:];

            if (block.timestamp <= auctionStartTime) {
                return (initialRateBump, tail);
            } else if (block.timestamp >= auctionFinishTime) {
                return (0, tail);
            }

            for (uint256 i = 0; i < pointsCount; i++) {
                uint256 nextRateBump = uint24(bytes3(pointsAndTimeDeltas[:3]));
                uint256 nextPointTime = currentPointTime + uint16(bytes2(pointsAndTimeDeltas[3:5]));
                if (block.timestamp <= nextPointTime) {
                    return (((block.timestamp - currentPointTime) * nextRateBump + (nextPointTime - block.timestamp) * currentRateBump) / (nextPointTime - currentPointTime), tail);
                }
                currentRateBump = nextRateBump;
                currentPointTime = nextPointTime;
                pointsAndTimeDeltas = pointsAndTimeDeltas[5:];
            }
            return ((auctionFinishTime - block.timestamp) * currentRateBump / (auctionFinishTime - currentPointTime), tail);
        }
    }
}
