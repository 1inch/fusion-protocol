// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { DutchAuctionBase } from "./DutchAuctionBase.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

/**
 * @title Announcement-anchored Dutch auction
 * @notice Dutch auction whose curve and resolver exclusivity may be measured from an order's
 * on-chain announcement, for orders whose exact submission time is unknown at build time.
 * @dev Opt-in per order via the top bit of the uint32 timestamps the legacy encodings already
 * carry, so a legacy blob parses unchanged:
 * - `auctionStartTime` top bit: start at max(announcement, built start);
 * - whitelist `allowedTime` top bit: measure exclusivity from the announcement too;
 * - anchored-delay top bit: revert fills after `announcedAt` + deadline delay (lives inside the
 *   anchored field, so it cannot be set without it).
 * The top bit is free until 19 Jan 2038 (2^31 s); replace before then, when real timestamps set it
 * and anchored reads fail closed.
 */
abstract contract AnchoredDutchAuction is DutchAuctionBase {
    /// @dev Top bit of a uint32 timestamp, unset in legitimate timestamps until 19 January 2038.
    uint256 private constant _ANCHORED_FLAG = 1 << 31;
    uint256 private constant _TIMESTAMP_MASK = _ANCHORED_FLAG - 1;
    /// @dev Top bit of the uint24 anchored delay; real delays are minutes, never 97 days.
    uint256 private constant _DEADLINE_FLAG = 1 << 23;
    uint256 private constant _DELAY_MASK = _DEADLINE_FLAG - 1;

    /// @dev The taker's window in the resolver ladder has not opened yet.
    error AllowedTimeViolation();
    /// @dev The order relies on its announcement but was never announced.
    error OrderNotAnnounced();
    /// @dev The order is past its announcement deadline.
    error AuctionExpired();

    /// @dev Zero disables anchoring: anchored orders fail closed with `OrderNotAnnounced`.
    IOrderRegistrator private immutable _ORDER_REGISTRATOR;

    /**
     * @param orderRegistrator The registrator whose announcements anchored orders are measured from,
     * or the zero address when announcements are unavailable on this chain.
     */
    constructor(IOrderRegistrator orderRegistrator) {
        _ORDER_REGISTRATOR = orderRegistrator;
    }

    /**
     * @dev Parses the auction rate bump. With the anchored bit unset, reads exactly as the legacy
     * parser; when set, starts the auction at max(announcement, built start).
     * @param orderHash The order hash, the announcement key.
     * @param auctionDetails Tightly packed struct of the following format:
     * ```
     * struct AuctionDetails {
     *     bytes3 gasBumpEstimate;
     *     bytes4 gasPriceEstimate;
     *     bytes4 auctionStartTime;   // top bit: anchor the start to the announcement
     *     bytes3 auctionDuration;
     *     bytes3 initialRateBump;
     *     bytes1 pointsCount;
     *     (bytes3,bytes2)[N] pointsAndTimeDeltas;
     * }
     * ```
     * @return rateBump The rate bump at the current time.
     * @return Remaining calldata after parsing auction data.
     */
    function _auctionRateBump(bytes32 orderHash, bytes calldata auctionDetails) internal view returns (uint256, bytes calldata) {
        unchecked {
            uint256 auctionStartTime = uint32(bytes4(auctionDetails[7:11]));
            if (auctionStartTime & _ANCHORED_FLAG == 0) {
                return _getRateBump(auctionDetails);
            }

            uint256 gasBumpEstimate = uint24(bytes3(auctionDetails[0:3]));
            uint256 gasPriceEstimate = uint32(bytes4(auctionDetails[3:7]));
            uint256 auctionDuration = uint24(bytes3(auctionDetails[11:14]));
            uint256 initialRateBump = uint24(bytes3(auctionDetails[14:17]));

            auctionStartTime &= _TIMESTAMP_MASK;
            uint256 anchoredStartTime = _announcedAt(orderHash);
            if (anchoredStartTime > auctionStartTime) auctionStartTime = anchoredStartTime;

            uint256 gasBump = gasBumpEstimate == 0 || gasPriceEstimate == 0 ? 0 : gasBumpEstimate * block.basefee / gasPriceEstimate / _GAS_PRICE_BASE;
            (uint256 auctionBump, bytes calldata tail) = _getAuctionBump(auctionStartTime, auctionStartTime + auctionDuration, initialRateBump, auctionDetails[17:]);
            return (auctionBump > gasBump ? auctionBump - gasBump : 0, tail);
        }
    }

    /**
     * @dev Runs the anchored checks of a fill: the exclusivity walk from the announcement and the
     * optional deadline (reverts fills after `announcedAt` + delay). No-op for a legacy blob. The
     * caller also walks the ladder from the absolute allowed time, so a taker must clear both.
     * @param whitelistData Tightly packed struct of the following format:
     * ```
     * 4 bytes - allowed time; top bit: measure exclusivity from the announcement too
     * 3 bytes - anchored allowed-time delay (present when set); its top bit adds the deadline
     * 3 bytes - announcement deadline delay (present when the deadline bit is set)
     * 1 byte - size of the whitelist
     * (bytes12)[N] — taker whitelist
     * ```
     * @param orderHash The order hash, the announcement key.
     * @param taker The taker address to check.
     */
    function _validateAnchoredFill(bytes calldata whitelistData, bytes32 orderHash, address taker) internal view {
        unchecked {
            uint256 allowedTime = uint32(bytes4(whitelistData));
            if (allowedTime & _ANCHORED_FLAG == 0) return;

            uint256 announcementTime = _announcedAt(orderHash);
            uint256 anchoredDelay = uint24(bytes3(whitelistData[4:7]));
            uint256 offset = 7;

            if (anchoredDelay & _DEADLINE_FLAG != 0) {
                if (block.timestamp > announcementTime + uint24(bytes3(whitelistData[7:10]))) revert AuctionExpired();
                offset = 10;
            }

            _checkAnchoredExclusivity(whitelistData[offset:], taker, announcementTime + (anchoredDelay & _DELAY_MASK));
        }
    }

    /**
     * @dev Reads the absolute allowed time and locates the whitelist size byte, skipping the
     * anchored fields (enforced by `_validateAnchoredFill`), so a whitelist walk works either way.
     * @param whitelistData Whitelist data in the format of `_validateAnchoredFill`.
     * @return allowedTime The absolute allowed time, anchored bit masked off.
     * @return offset The offset of the whitelist size byte.
     */
    function _skipAnchoredFields(bytes calldata whitelistData) internal pure returns (uint256 allowedTime, uint256 offset) {
        unchecked {
            allowedTime = uint32(bytes4(whitelistData));
            offset = 4;
            if (allowedTime & _ANCHORED_FLAG != 0) {
                offset += uint24(bytes3(whitelistData[4:7])) & _DEADLINE_FLAG != 0 ? 6 : 3;
                allowedTime &= _TIMESTAMP_MASK;
            }
        }
    }

    /**
     * @dev Walks the resolver ladder from the anchored allowed time, mirroring the settlement's
     * walk from the absolute one.
     * @param whitelistData The whitelist size byte followed by the taker entries.
     * @param taker The taker address to check.
     * @param allowedTime The anchored time the ladder is measured from.
     */
    function _checkAnchoredExclusivity(bytes calldata whitelistData, address taker, uint256 allowedTime) private view {
        unchecked {
            uint80 maskedTakerAddress = uint80(uint160(taker));
            uint256 size = uint8(whitelistData[0]);
            bytes calldata whitelist = whitelistData[1:1 + 12 * size];

            for (uint256 i = 0; i < size; i++) {
                if (block.timestamp < allowedTime) revert AllowedTimeViolation();
                if (maskedTakerAddress == uint80(bytes10(whitelist))) return;
                allowedTime += uint16(bytes2(whitelist[10:])); // add next time delta
                whitelist = whitelist[12:];
            }
            if (block.timestamp < allowedTime) revert AllowedTimeViolation();
        }
    }

    /**
     * @dev Reads an order's announcement, reverting when never announced or no registrator is set.
     * @param orderHash The order hash.
     * @return announcedAt The announcement time.
     */
    function _announcedAt(bytes32 orderHash) private view returns (uint256 announcedAt) {
        IOrderRegistrator orderRegistrator = _ORDER_REGISTRATOR;
        if (address(orderRegistrator) == address(0)) revert OrderNotAnnounced();
        announcedAt = orderRegistrator.announcedAt(orderHash);
        if (announcedAt == 0) revert OrderNotAnnounced();
    }
}
