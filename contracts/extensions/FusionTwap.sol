// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IAmountGetter } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IAmountGetter.sol";
import { IPreInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPreInteraction.sol";
import { ExtensionLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/ExtensionLib.sol";
import { MakerTraits, MakerTraitsLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/MakerTraitsLib.sol";

/**
 * @title FusionTwap
 * @notice Executes one signed Fusion order as a TWAP: the order unlocks in equal parts, one per interval, every
 * part is sold through a fresh run of the settlement's Dutch auction, and nothing is fillable after the last interval.
 * @dev The order extension references this contract three times, and the contract keeps no storage:
 * - as the pre-interaction, whose data is the schedule, it caps the cumulative filled amount by the parts
 *   unlocked so far, measured with the remaining amount the limit order protocol tracks for the order;
 * - as both amount getters, placed in front of the settlement's getter, it restarts the settlement's auction at
 *   the start of the current part by rewriting the auction start time it forwards.
 * The getters read the schedule from the pre-interaction and the pre-interaction checks that both getters route
 * here, so an order that misses any of the three references cannot be filled.
 * A part that is not filled within its own interval stays unlocked and is sold on the current part's auction, at
 * whatever point that curve has reached. An auction shorter than the interval leaves the price at the limit until
 * the next part starts, so the auction duration should equal the interval.
 */
contract FusionTwap is IAmountGetter, IPreInteraction {
    using ExtensionLib for bytes;
    using MakerTraitsLib for MakerTraits;

    uint256 private constant _SCHEDULE_LENGTH = 9;
    /// @dev Offset of the 4-byte auction start time inside the settlement's `AuctionDetails`.
    uint256 private constant _AUCTION_START_TIME_OFFSET = 7;

    error TwapNotStarted();
    error TwapEnded();
    error TwapScheduleNotFound();
    error TwapRequiresMultipleFills();
    error TwapInvalidSchedule();
    error TwapInvalidAuctionDetails();
    error TwapAmountNotUnlocked(uint256 filledAmount, uint256 unlockedAmount);

    /**
     * @notice See {IPreInteraction-preInteraction}.
     * @dev Reverts unless both amount getters route to this contract and the fill keeps the order within its
     * unlocked parts. It moves no funds and writes no state, so it is safe for anyone to call.
     * `extraData` is the schedule:
     * ```
     * 4 bytes - start time of the first part
     * 3 bytes - interval between parts, in seconds
     * 2 bytes - number of parts
     * ```
     */
    function preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 /* orderHash */,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) external view {
        if (!_isRoutedHere(extension.makingAmountData()) || !_isRoutedHere(extension.takingAmountData())) {
            revert TwapScheduleNotFound();
        }
        (uint256 startTime, uint256 interval, uint256 parts) = _parseSchedule(extraData);
        uint256 unlockedAmount = Math.mulDiv(order.makingAmount, _currentPart(startTime, interval, parts) + 1, parts);
        uint256 filledAmount = order.makingAmount - remainingMakingAmount + makingAmount;
        if (filledAmount > unlockedAmount) revert TwapAmountNotUnlocked(filledAmount, unlockedAmount);
    }

    /**
     * @notice See {IAmountGetter-getMakingAmount}.
     * @dev `extraData` is the next amount getter's address followed by its data, which must start with the
     * settlement's `AuctionDetails`. The auction start time in it is replaced with the current part's start.
     */
    function getMakingAmount(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) external view returns (uint256) {
        (IAmountGetter getter, bytes memory getterData) = _restartAuction(order, extension, extraData);
        return getter.getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, getterData);
    }

    /**
     * @notice See {IAmountGetter-getTakingAmount}.
     * @dev `extraData` has the same format as in {getMakingAmount}.
     */
    function getTakingAmount(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) external view returns (uint256) {
        (IAmountGetter getter, bytes memory getterData) = _restartAuction(order, extension, extraData);
        return getter.getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, getterData);
    }

    /**
     * @dev Splits `extraData` into the next getter and its data, with the auction start time moved to the start
     * of the current part. Fails closed when the schedule would not be enforced on fill: the order must route its
     * pre-interaction to this contract and track its remaining amount across multiple fills.
     */
    function _restartAuction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes calldata extraData
    ) private view returns (IAmountGetter getter, bytes memory getterData) {
        bytes calldata preInteractionData = extension.preInteractionTargetAndData();
        if (!order.makerTraits.needPreInteractionCall() || !_isRoutedHere(preInteractionData)) revert TwapScheduleNotFound();
        if (order.makerTraits.useBitInvalidator()) revert TwapRequiresMultipleFills();
        (uint256 startTime, uint256 interval, uint256 parts) = _parseSchedule(preInteractionData[20:]);

        if (extraData.length < 20 + _AUCTION_START_TIME_OFFSET + 4) revert TwapInvalidAuctionDetails();
        getter = IAmountGetter(address(bytes20(extraData)));
        getterData = extraData[20:];

        bytes4 partStartTime = bytes4(uint32(startTime + _currentPart(startTime, interval, parts) * interval));
        for (uint256 i = 0; i < 4; i++) {
            getterData[_AUCTION_START_TIME_OFFSET + i] = partStartTime[i];
        }
    }

    function _isRoutedHere(bytes calldata targetAndData) private view returns (bool) {
        return targetAndData.length >= 20 && address(bytes20(targetAndData)) == address(this);
    }

    function _parseSchedule(bytes calldata schedule) private pure returns (
        uint256 startTime,
        uint256 interval,
        uint256 parts
    ) {
        if (schedule.length < _SCHEDULE_LENGTH) revert TwapInvalidSchedule();
        startTime = uint32(bytes4(schedule[0:4]));
        interval = uint24(bytes3(schedule[4:7]));
        parts = uint16(bytes2(schedule[7:9]));
        if (startTime == 0 || interval == 0 || parts == 0 || startTime + (parts - 1) * interval > type(uint32).max) {
            revert TwapInvalidSchedule();
        }
    }

    function _currentPart(uint256 startTime, uint256 interval, uint256 parts) private view returns (uint256 part) {
        if (block.timestamp < startTime) revert TwapNotStarted();
        part = (block.timestamp - startTime) / interval;
        if (part >= parts) revert TwapEnded();
    }
}
