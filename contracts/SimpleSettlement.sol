// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { FeeTaker } from "@1inch/limit-order-protocol-contract/contracts/extensions/FeeTaker.sol";

import { AnchoredDutchAuction } from "./AnchoredDutchAuction.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

/**
 * @title Simple Settlement contract
 * @notice Contract to execute limit orders settlement, created by Fusion mode.
 * @dev The Dutch auction and the resolver exclusivity may be anchored to the moment an order was
 * announced on-chain; see {AnchoredDutchAuction} for the opt-in encoding and its 2038 horizon.
 */
contract SimpleSettlement is FeeTaker, AnchoredDutchAuction {
    using Math for uint256;

    /// @dev FeeTaker's custom-receiver bit in the first byte of its post-interaction data.
    bytes1 private constant _CUSTOM_RECEIVER_FLAG = 0x01;

    error InvalidProtocolSurplusFee();
    error InvalidEstimatedTakingAmount();

    /**
     * @notice Initializes the contract.
     * @param limitOrderProtocol The limit order protocol contract.
     * @param accessToken Contract address whose tokens allow filling limit orders with a fee for resolvers that are outside the whitelist.
     * @param weth The WETH address.
     * @param owner The owner of the contract.
     * @param orderRegistrator The registrator whose announcements anchored orders are measured from,
     * or the zero address when announcements are unavailable on this chain.
     */
    constructor(address limitOrderProtocol, IERC20 accessToken, address weth, address owner, IOrderRegistrator orderRegistrator)
        FeeTaker(limitOrderProtocol, accessToken, weth, owner)
        AnchoredDutchAuction(orderRegistrator)
    {}

    /**
     * @dev Calculates fee amounts depending on whether the taker is in the whitelist and whether they have an _ACCESS_TOKEN.
     * @param order The user's order.
     * @param taker The taker address.
     * @param takingAmount The amount of the asset being taken.
     * @param extraData The extra data has the following format:
     * FeeTaker structure determined by `super._getFeeAmounts`:
     *      2 bytes — integrator fee percentage (in 1e5)
     *      1 bytes - integrator rev share percentage (in 1e2)
     *      2 bytes — resolver fee percentage (in 1e5)
     *      bytes — whitelist structure determined by `_isWhitelistedPostInteractionImpl` implementation
     * Surpluses fee structure:
     *      32 bytes - estimated taking amount
     *      1 byte - protocol surplus fee (in 1e2)
     * ```
     * @return integratorFeeAmount Fee amount paid to the integrator.
     * @return protocolFeeAmount Fee amount paid to the protocol.
     * @return tail Remaining calldata after processing fee-related fields.
     */
    function _getFeeAmounts(IOrderMixin.Order calldata order, address taker, uint256 takingAmount, uint256 makingAmount, bytes calldata extraData) internal virtual override returns (uint256 integratorFeeAmount, uint256 protocolFeeAmount, bytes calldata tail) {
        (integratorFeeAmount, protocolFeeAmount, tail) = super._getFeeAmounts(order, taker, takingAmount, makingAmount, extraData);

        uint256 estimatedTakingAmount = uint256(bytes32(tail));
        if (estimatedTakingAmount < order.takingAmount) {
            revert InvalidEstimatedTakingAmount();
        }

        uint256 actualTakingAmount = takingAmount - integratorFeeAmount - protocolFeeAmount;
        uint256 scaledEstimatedTakingAmount = estimatedTakingAmount.mulDiv(makingAmount, order.makingAmount, Math.Rounding.Ceil);
        if (actualTakingAmount > scaledEstimatedTakingAmount) {
            uint256 protocolSurplusFee = uint256(uint8(tail[32]));
            if (protocolSurplusFee > _BASE_1E2) revert InvalidProtocolSurplusFee();
            protocolFeeAmount += (actualTakingAmount - scaledEstimatedTakingAmount).mulDiv(protocolSurplusFee, _BASE_1E2);
        }
        tail = tail[33:];
    }

    /**
     * @notice See {FeeTaker-_postInteraction}.
     * @dev Runs the announcement-anchored checks, which need the order hash, before handing the fill
     * to the fee logic. The whitelist blob is read in place inside FeeTaker's `extraData`, whose
     * layout pins the offsets used below:
     * ```
     * 1 byte - FeeTaker flags (0x01 signals a custom receiver)
     * 20 bytes — integrator fee recipient
     * 20 bytes - protocol fee recipient
     * 20 bytes — receiver of taking tokens (present when the custom-receiver flag is set)
     * 5 bytes - integrator fee, integrator rev share and resolver fee
     * 1 byte - whitelist discount numerator
     * bytes - whitelist blob determined by `_isWhitelistedPostInteractionImpl`
     * ```
     */
    function _postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal virtual override {
        unchecked {
            // 1 flags + 20 + 20 recipients (+ 20 custom receiver) + 6 fee bytes, per the layout above.
            uint256 whitelistOffset = extraData[0] & _CUSTOM_RECEIVER_FLAG == _CUSTOM_RECEIVER_FLAG ? 67 : 47;
            _validateAnchoredFill(extraData[whitelistOffset:], orderHash, taker);
        }
        super._postInteraction(order, extension, orderHash, taker, makingAmount, takingAmount, remainingMakingAmount, extraData);
    }

    /**
     * @dev Adds dutch auction capabilities to the getter
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
        (uint256 rateBump, bytes calldata tail) = _auctionRateBump(orderHash, extraData);
        return Math.mulDiv(
            super._getMakingAmount(order, extension, orderHash, taker, takingAmount, remainingMakingAmount, tail),
            _BASE_POINTS,
            _BASE_POINTS + rateBump
        );
    }

    /**
     * @dev Adds dutch auction capabilities to the getter
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
        (uint256 rateBump, bytes calldata tail) = _auctionRateBump(orderHash, extraData);
        return Math.mulDiv(
            super._getTakingAmount(order, extension, orderHash, taker, makingAmount, remainingMakingAmount, tail),
            _BASE_POINTS + rateBump,
            _BASE_POINTS,
            Math.Rounding.Ceil
        );
    }

    /**
     * @dev Validates whether the taker is whitelisted.
     * @param whitelistData Whitelist data is a tightly packed struct of the following format:
     * ```
     * 4 bytes - allowed time
     * 1 byte - size of the whitelist
     * (bytes12)[N] — taker whitelist
     * ```
     * Only 10 lowest bytes of the address are used for comparison.
     * When the allowed time carries the anchored bit, the anchored fields of
     * {AnchoredDutchAuction-_validateAnchoredFill} sit between it and the whitelist size; they are
     * enforced by `_postInteraction`, so this walk skips them.
     * @param taker The taker address to check.
     * @return isWhitelisted Whether the taker is whitelisted.
     * @return tail Remaining calldata.
     */
    function _isWhitelistedPostInteractionImpl(bytes calldata whitelistData, address taker) internal view override returns (bool isWhitelisted, bytes calldata tail) {
        unchecked {
            uint80 maskedTakerAddress = uint80(uint160(taker));
            (uint256 allowedTime, uint256 offset) = _skipAnchoredFields(whitelistData);
            uint256 size = uint8(whitelistData[offset]);
            bytes calldata whitelist = whitelistData[offset + 1:offset + 1 + 12 * size];
            tail = whitelistData[offset + 1 + 12 * size:];

            for (uint256 i = 0; i < size; i++) {
                uint80 whitelistedAddress = uint80(bytes10(whitelist));
                if (block.timestamp < allowedTime) {
                    revert AllowedTimeViolation();
                } else if (maskedTakerAddress == whitelistedAddress) {
                    return (true, tail);
                }
                allowedTime += uint16(bytes2(whitelist[10:])); // add next time delta
                whitelist = whitelist[12:];
            }
            if (block.timestamp < allowedTime) {
                revert AllowedTimeViolation();
            }
        }
    }
}
