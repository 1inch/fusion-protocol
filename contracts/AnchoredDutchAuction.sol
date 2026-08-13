// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { DutchAuctionBase } from "./DutchAuctionBase.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

/**
 * @title Announcement-anchored Dutch auction
 * @notice Dutch auction whose curve and resolver exclusivity may run from the order's on-chain
 * announcement instead of build-time timestamps.
 * @dev Opt-in per order via the top bit of the uint32 timestamps the legacy encodings already
 * carry (`auctionStartTime`, whitelist `allowedTime`); anchoring takes the later of announcement
 * and built time. The bit is free until 19 Jan 2038.
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

    /// @dev {DutchAuctionBase-_getNetBump} with an anchored start raised to the announcement time.
    function _auctionNetBump(bytes32 orderHash, bytes calldata auctionDetails) internal view returns (int256 netBump, bytes calldata tail) {
        unchecked {
            uint256 auctionStartTime = uint32(bytes4(auctionDetails[7:11]));
            if (auctionStartTime & _ANCHORED_FLAG == 0) {
                return _getNetBump(auctionDetails);
            }

            uint256 auctionDuration = uint24(bytes3(auctionDetails[11:14]));
            uint256 initialRateBump = uint24(bytes3(auctionDetails[14:17]));

            auctionStartTime &= _TIMESTAMP_MASK;
            uint256 anchoredStartTime = _announcedAt(orderHash);
            if (anchoredStartTime > auctionStartTime) auctionStartTime = anchoredStartTime;

            uint256 auctionBump;
            (auctionBump, tail) = _getAuctionBump(auctionStartTime, auctionStartTime + auctionDuration, initialRateBump, auctionDetails[17:]);
            netBump = int256(auctionBump) - int256(_getGasBump(auctionDetails));
        }
    }

    /**
     * @dev Announcement-based deadline and exclusivity checks; a no-op for a legacy blob.
     * `whitelistData` layout:
     * ```
     * 4 bytes - allowed time; top bit: anchored
     * 3 bytes - anchored allowed-time delay (present when anchored); its top bit adds the deadline
     * 3 bytes - announcement deadline delay (present when the deadline bit is set)
     * 1 byte - size of the whitelist
     * (bytes12)[N] — taker whitelist
     * ```
     */
    function _validateAnchoredFill(bytes calldata whitelistData, bytes32 orderHash, address taker) internal view {
        unchecked {
            if (uint32(bytes4(whitelistData)) & _ANCHORED_FLAG == 0) return;

            uint256 announcedAt = _announcedAt(orderHash);
            uint256 anchoredDelay = uint24(bytes3(whitelistData[4:7]));
            bool hasDeadline = anchoredDelay & _DEADLINE_FLAG != 0;
            if (hasDeadline && block.timestamp > announcedAt + uint24(bytes3(whitelistData[7:10]))) {
                revert AuctionExpired();
            }

            uint256 offset = 4 + (hasDeadline ? 6 : 3);
            _checkAnchoredExclusivity(whitelistData[offset:], taker, announcedAt + (anchoredDelay & _DELAY_MASK));
        }
    }

    /// @dev Absolute allowed time and the offset of the whitelist size byte, anchored fields skipped.
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

    /// @dev The settlement's ladder walk, starting from the anchored allowed time.
    function _checkAnchoredExclusivity(bytes calldata whitelistData, address taker, uint256 allowedTime) private view {
        unchecked {
            uint80 maskedTakerAddress = uint80(uint160(taker));
            bytes calldata whitelist = whitelistData[1:1 + 12 * uint8(whitelistData[0])];

            while (whitelist.length > 0) {
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
        if (address(_ORDER_REGISTRATOR) == address(0)) revert OrderNotAnnounced();
        announcedAt = _ORDER_REGISTRATOR.announcedAt(orderHash);
        if (announcedAt == 0) revert OrderNotAnnounced();
    }
}
