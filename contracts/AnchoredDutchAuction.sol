// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { DutchAuctionBase } from "./DutchAuctionBase.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

/**
 * @title Announcement-anchored Dutch auction
 * @notice Dutch auction whose curve and resolver exclusivity may be measured from an order's
 * on-chain announcement, for orders whose submission time is unknown at build time.
 * @dev Opt-in per order via the top bit of the uint32 timestamps the legacy encodings already
 * carry, so a legacy blob parses unchanged: the top bit of `auctionStartTime` and of the whitelist
 * `allowedTime` anchor the start and the exclusivity to the announcement (each taking the later of
 * announcement and built time), and the top bit of the anchored delay adds a fill deadline. Free
 * until 19 Jan 2038 (2^31 s) — replace before then, when real timestamps set it and anchored reads
 * revert.
 */
abstract contract AnchoredDutchAuction is DutchAuctionBase {
    uint256 private constant _ANCHORED_FLAG = 1 << 31; // top bit of a uint32 timestamp
    uint256 private constant _TIMESTAMP_MASK = _ANCHORED_FLAG - 1;
    uint256 private constant _DEADLINE_FLAG = 1 << 23; // top bit of the uint24 anchored delay
    uint256 private constant _DELAY_MASK = _DEADLINE_FLAG - 1;

    error AllowedTimeViolation();
    error OrderNotAnnounced();
    error AuctionExpired();

    /// @dev Zero disables anchoring: anchored orders fail closed with `OrderNotAnnounced`.
    IOrderRegistrator private immutable _ORDER_REGISTRATOR;

    constructor(IOrderRegistrator orderRegistrator) {
        _ORDER_REGISTRATOR = orderRegistrator;
    }

    /// @dev Rate bump for the AuctionDetails of {DutchAuctionBase-_getRateBump}; when the top bit of
    /// `auctionStartTime` is set, the start becomes max(announcement, built start).
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
     * @dev Anchored pre-checks for a fill; a no-op for a legacy blob. Walks the exclusivity ladder
     * from the announcement and enforces the optional deadline; the caller walks the same ladder
     * from the absolute allowed time, so a taker must clear both. `whitelistData` layout:
     * ```
     * 4 bytes - allowed time; top bit: measure exclusivity from the announcement too
     * 3 bytes - anchored allowed-time delay (present when set); its top bit adds the deadline
     * 3 bytes - announcement deadline delay (present when the deadline bit is set)
     * 1 byte - size of the whitelist
     * (bytes12)[N] — taker whitelist
     * ```
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

    /// @dev Absolute allowed time and the offset of the whitelist size byte, skipping the anchored
    /// fields (enforced by `_validateAnchoredFill`) so a whitelist walk works anchored or not.
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

    /// @dev Walks the resolver ladder from the anchored allowed time, mirroring the settlement's
    /// walk from the absolute one.
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

    /// @dev Order's announcement time; reverts when never announced or no registrator is set.
    function _announcedAt(bytes32 orderHash) private view returns (uint256 announcedAt) {
        IOrderRegistrator orderRegistrator = _ORDER_REGISTRATOR;
        if (address(orderRegistrator) == address(0)) revert OrderNotAnnounced();
        announcedAt = orderRegistrator.announcedAt(orderHash);
        if (announcedAt == 0) revert OrderNotAnnounced();
    }
}
