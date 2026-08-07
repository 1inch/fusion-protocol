// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IPostInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPostInteraction.sol";
import { AmountGetterBase } from "@1inch/limit-order-protocol-contract/contracts/extensions/AmountGetterBase.sol";

import { DutchAuctionBase } from "../DutchAuctionBase.sol";
import { IOrderRegistrator } from "../interfaces/IOrderRegistrator.sol";

/**
 * @title FusionAnchoredAuction
 * @notice Dutch auction whose schedule may be anchored to the moment an order was announced on-chain.
 * @dev A standalone amount getter and post-interaction, referenced by address from the order extension —
 * directly or chained behind an already deployed settlement contract — so it requires no settlement
 * redeployment. Each feature is opt-in per order through a flags byte; with no flags set the pricing
 * matches the settlement's own Dutch auction. Amount getters can be skipped by a mis-assembled order,
 * so the announcement deadline lives in the post-interaction, which cannot.
 */
contract FusionAnchoredAuction is AmountGetterBase, DutchAuctionBase, IPostInteraction {
    /// @dev Measure from `announcedAt` instead of the built timestamp alone. Shared by both blobs.
    bytes1 private constant _ANCHORED_FLAG = 0x01;
    /// @dev Exclusivity-blob flag: stop fills after `announcedAt` plus the deadline delay.
    bytes1 private constant _ANNOUNCEMENT_DEADLINE_FLAG = 0x02;

    /// @dev The order relies on its announcement but was never announced.
    error OrderNotAnnounced();
    /// @dev The order is past its announcement deadline.
    error AuctionExpired();
    /// @dev The taker may not fill the order yet.
    error AllowedTimeViolation();
    /// @dev A flag was set without the flag it depends on.
    error InvalidFlagCombination();

    IOrderRegistrator private immutable _ORDER_REGISTRATOR;

    /// @param orderRegistrator The registrator whose announcements anchored orders are measured from.
    constructor(IOrderRegistrator orderRegistrator) {
        _ORDER_REGISTRATOR = orderRegistrator;
    }

    /**
     * @notice See {IPostInteraction-postInteraction}.
     * @dev Holds resolver exclusivity relative to the announcement and enforces the optional
     * announcement deadline. Deliberately callable by anyone: it moves no funds and only reverts,
     * and when chained the caller is a settlement contract, not the limit order protocol.
     * `extraData` consists of:
     * ```
     * 1 byte - flags
     * 4 bytes - allowed time
     * 3 bytes - anchored allowed-time delay (present when the anchored flag is set)
     * 3 bytes - announcement deadline delay (present when the deadline flag is set)
     * 1 byte - size of the whitelist
     * (bytes10,bytes2)[N] - whitelisted address low bytes and the time delta until the next one
     * bytes - custom data to call an extra post-interaction (optional)
     * ```
     * The anchored allowed time is `announcedAt + delay`, taking the max against the absolute allowed
     * time. The deadline reverts fills strictly after `announcedAt + deadline delay` and requires the
     * anchored flag: alone it fails closed rather than silently doing nothing.
     */
    function postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) external {
        unchecked {
            bytes1 flags = extraData[0];
            uint256 allowedTime = uint32(bytes4(extraData[1:5]));
            uint256 offset = 5;

            if (flags & _ANCHORED_FLAG != 0) {
                uint256 announcementTime = _announcedAt(orderHash);
                uint256 anchoredTime = announcementTime + uint24(bytes3(extraData[offset:offset + 3]));
                offset += 3;
                if (anchoredTime > allowedTime) allowedTime = anchoredTime;

                if (flags & _ANNOUNCEMENT_DEADLINE_FLAG != 0) {
                    if (block.timestamp > announcementTime + uint24(bytes3(extraData[offset:offset + 3]))) revert AuctionExpired();
                    offset += 3;
                }
            } else if (flags & _ANNOUNCEMENT_DEADLINE_FLAG != 0) {
                revert InvalidFlagCombination();
            }

            uint256 size = uint8(extraData[offset]);
            offset += 1;
            bytes calldata whitelist = extraData[offset:offset + 12 * size];
            bytes calldata tail = extraData[offset + 12 * size:];

            uint80 maskedTakerAddress = uint80(uint160(taker));
            bool whitelisted;
            for (uint256 i = 0; i < size; i++) {
                if (block.timestamp < allowedTime) revert AllowedTimeViolation();
                if (maskedTakerAddress == uint80(bytes10(whitelist))) {
                    whitelisted = true;
                    break;
                }
                allowedTime += uint16(bytes2(whitelist[10:])); // add next time delta
                whitelist = whitelist[12:];
            }
            if (!whitelisted && block.timestamp < allowedTime) revert AllowedTimeViolation();

            if (tail.length > 19) {
                IPostInteraction(address(bytes20(tail))).postInteraction(
                    order, extension, orderHash, taker, makingAmount, takingAmount, remainingMakingAmount, tail[20:]
                );
            }
        }
    }

    /**
     * @dev Adds anchored dutch auction capabilities to the getter.
     */
    function _getMakingAmount(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal view override returns (uint256) {
        (uint256 rateBump, bytes calldata tail) = _parseRateBump(extraData, orderHash);
        return Math.mulDiv(
            super._getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, tail),
            _BASE_POINTS,
            _BASE_POINTS + rateBump
        );
    }

    /**
     * @dev Adds anchored dutch auction capabilities to the getter.
     */
    function _getTakingAmount(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal view override returns (uint256) {
        (uint256 rateBump, bytes calldata tail) = _parseRateBump(extraData, orderHash);
        return Math.mulDiv(
            super._getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, tail),
            _BASE_POINTS + rateBump,
            _BASE_POINTS,
            Math.Rounding.Ceil
        );
    }

    /**
     * @dev Parses the auction rate bump, resolving an anchored start from the announcement.
     * @param auctionDetails AuctionDetails is a tightly packed struct of the following format:
     * ```
     * struct AuctionDetails {
     *     bytes1 flags;
     *     bytes3 gasBumpEstimate;
     *     bytes4 gasPriceEstimate;
     *     bytes4 auctionStartTime;
     *     bytes3 auctionDuration;
     *     bytes3 initialRateBump;
     *     bytes1 pointsCount;
     *     (bytes3,bytes2)[N] pointsAndTimeDeltas;
     * }
     * ```
     * An anchored auction starts at the later of its announcement and the built start time, so a
     * stale built start is ignored while a deliberately delayed one still holds.
     * @param orderHash The hash of the order, the key the announcement is recorded under.
     * @return rateBump The rate bump at the current time.
     * @return Remaining calldata after parsing auction data.
     */
    function _parseRateBump(bytes calldata auctionDetails, bytes32 orderHash) private view returns (uint256, bytes calldata) {
        unchecked {
            bytes1 flags = auctionDetails[0];
            uint256 gasBumpEstimate = uint24(bytes3(auctionDetails[1:4]));
            uint256 gasPriceEstimate = uint32(bytes4(auctionDetails[4:8]));
            uint256 auctionStartTime = uint32(bytes4(auctionDetails[8:12]));
            uint256 auctionDuration = uint24(bytes3(auctionDetails[12:15]));
            uint256 initialRateBump = uint24(bytes3(auctionDetails[15:18]));

            if (flags & _ANCHORED_FLAG != 0) {
                uint256 anchoredStartTime = _announcedAt(orderHash);
                if (anchoredStartTime > auctionStartTime) auctionStartTime = anchoredStartTime;
            }

            uint256 gasBump = gasBumpEstimate == 0 || gasPriceEstimate == 0 ? 0 : gasBumpEstimate * block.basefee / gasPriceEstimate / _GAS_PRICE_BASE;
            (uint256 auctionBump, bytes calldata tail) = _getAuctionBump(auctionStartTime, auctionStartTime + auctionDuration, initialRateBump, auctionDetails[18:]);
            return (auctionBump > gasBump ? auctionBump - gasBump : 0, tail);
        }
    }

    /**
     * @dev Reads the announcement of an order, reverting when it has never been announced.
     */
    function _announcedAt(bytes32 orderHash) private view returns (uint256) {
        uint256 announcedAt = _ORDER_REGISTRATOR.announcedAt(orderHash);
        if (announcedAt == 0) revert OrderNotAnnounced();
        return announcedAt;
    }
}
