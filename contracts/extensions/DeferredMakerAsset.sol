// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SlotDerivation } from "@openzeppelin/contracts/utils/SlotDerivation.sol";
import { TransientSlot } from "@openzeppelin/contracts/utils/TransientSlot.sol";
import { Address, AddressLib } from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import { UniERC20 } from "@1inch/solidity-utils/contracts/libraries/UniERC20.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { IPreInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPreInteraction.sol";
import { IPostInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IPostInteraction.sol";
import { ExtensionLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/ExtensionLib.sol";
import { MakerTraits, MakerTraitsLib } from "@1inch/limit-order-protocol-contract/contracts/libraries/MakerTraitsLib.sol";

/**
 * @title Deferred maker asset
 * @notice Base for order extensions whose maker side is released only after the taker has paid.
 * @dev The order uses this contract as its maker asset. The Limit Order Protocol's maker-to-taker transfer only records
 * where the maker asset has to go. The taker asset is routed to this contract, either as the order receiver or as the
 * Settlement's custom receiver, and the post-interaction then hands what arrived to `_settle`, which releases the maker asset.
 *
 * Every fill runs `preInteraction`, `transferFrom` and `postInteraction` in that order inside one Limit Order Protocol call.
 * State between them lives in transient storage keyed by the order hash, so fills nested through taker interactions stay separate.
 */
abstract contract DeferredMakerAsset is IPreInteraction, IPostInteraction, Ownable {
    using AddressLib for Address;
    using UniERC20 for IERC20;
    using ExtensionLib for bytes;
    using MakerTraitsLib for MakerTraits;
    using SlotDerivation for bytes32;
    using TransientSlot for *;

    /// @notice Thrown when `preInteraction` or `transferFrom` is called by anyone but the Limit Order Protocol.
    error OnlyLimitOrderProtocol();
    /// @notice Thrown when `postInteraction` is called by anyone but the Settlement or the Limit Order Protocol.
    error OnlyFillCallers();
    /// @notice Thrown when the order is not built for this contract, for example when its post-interaction or its taker asset does not reach it.
    error UnsupportedOrder();
    /// @notice Thrown when a maker transfer does not match the fill opened by `preInteraction`, targets this contract,
    /// or repeats an order inside its own fill.
    error UnexpectedMakerTransfer();
    /// @notice Thrown when `postInteraction` runs for an order without a recorded maker transfer.
    error MakerTransferNotRecorded();
    /// @notice Thrown when no taker asset reached this contract during the fill.
    error NothingReceived();

    /// @dev Fill opened by `preInteraction` and consumed by the following `transferFrom`: order hash, maker, making amount, taker asset balance.
    bytes32 private constant _FILL_SLOT = keccak256("DeferredMakerAsset.fill");
    /// @dev Per order hash, written by `transferFrom` and consumed by `postInteraction`: fill target, taker asset balance.
    bytes32 private constant _PENDING_SLOT = keccak256("DeferredMakerAsset.pending");

    /// @dev Settlement post-interaction data after the Settlement address, as parsed by `FeeTaker` and `SimpleSettlement`.
    uint256 private constant _CUSTOM_RECEIVER_FLAG = 0x01;
    uint256 private constant _CUSTOM_RECEIVER_OFFSET = 41; // flags (1), integrator fee recipient (20), protocol fee recipient (20)
    uint256 private constant _FEES_LENGTH = 6; // integrator fee (2), integrator share (1), resolver fee (2), whitelist discount (1)
    uint256 private constant _ALLOWED_TIME_LENGTH = 4;
    uint256 private constant _WHITELIST_ENTRY_LENGTH = 12; // address tail (10), delay (2)
    uint256 private constant _SURPLUS_LENGTH = 33; // estimated taking amount (32), protocol surplus fee (1)

    /// @notice The Limit Order Protocol (1inch Router V6) whose fills this contract takes part in.
    address public immutable LIMIT_ORDER_PROTOCOL;
    /// @notice The Fusion Settlement allowed to call `postInteraction` as its chained post-interaction.
    address public immutable SETTLEMENT;

    modifier onlyLimitOrderProtocol() {
        if (msg.sender != LIMIT_ORDER_PROTOCOL) revert OnlyLimitOrderProtocol();
        _;
    }

    /**
     * @param limitOrderProtocol The Limit Order Protocol.
     * @param settlement The Fusion Settlement.
     * @param initialOwner The owner, who can only rescue tokens sent to this contract by mistake.
     */
    constructor(address limitOrderProtocol, address settlement, address initialOwner) Ownable(initialOwner) {
        LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
        SETTLEMENT = settlement;
    }

    /**
     * @notice Checks that an order is built for this contract. Reverts when it is not.
     * @dev Runs in every pre-interaction. Off-chain services can call it to validate an order before broadcasting it.
     * The Limit Order Protocol checks the extension against the order salt and the signature separately.
     * @param order The order.
     * @param extension The order extension.
     */
    function validateOrder(IOrderMixin.Order calldata order, bytes calldata extension) external view {
        _validateOrder(order, extension);
    }

    /**
     * @notice See {IPreInteraction-preInteraction}.
     * @dev Validates the order, runs `_beforeMakerTransfer` and opens the fill for the following `transferFrom`.
     */
    function preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) external onlyLimitOrderProtocol {
        _validateOrder(order, extension);
        _beforeMakerTransfer(order, extension, remainingMakingAmount, extraData);

        _FILL_SLOT.asBytes32().tstore(orderHash);
        _FILL_SLOT.offset(1).asAddress().tstore(order.maker.get());
        _FILL_SLOT.offset(2).asUint256().tstore(makingAmount);
        _FILL_SLOT.offset(3).asUint256().tstore(IERC20(order.takerAsset.get()).balanceOf(address(this)));
    }

    /**
     * @notice Maker asset hook of the Limit Order Protocol. Records the fill target instead of transferring anything.
     * @dev The selector matches `IERC20.transferFrom`. The Limit Order Protocol appends the maker asset suffix, which is ignored here.
     * @param from The order maker.
     * @param to The fill target chosen by the taker.
     * @param amount The making amount of the fill.
     * @return Always true.
     */
    function transferFrom(address from, address to, uint256 amount) external onlyLimitOrderProtocol returns (bool) {
        bytes32 orderHash = _FILL_SLOT.asBytes32().tload();
        if (
            orderHash == bytes32(0) ||
            from != _FILL_SLOT.offset(1).asAddress().tload() ||
            amount != _FILL_SLOT.offset(2).asUint256().tload() ||
            to == address(this)
        ) revert UnexpectedMakerTransfer();
        _FILL_SLOT.asBytes32().tstore(bytes32(0));

        bytes32 pending = _PENDING_SLOT.deriveMapping(orderHash);
        if (pending.asAddress().tload() != address(0)) revert UnexpectedMakerTransfer();
        pending.asAddress().tstore(to);
        pending.offset(1).asUint256().tstore(_FILL_SLOT.offset(3).asUint256().tload());
        return true;
    }

    /**
     * @notice See {IPostInteraction-postInteraction}.
     * @dev Called by the Settlement as its chained post-interaction, or by the Limit Order Protocol for plain limit orders.
     * Measures the taker asset that arrived during the fill and hands it to `_settle`.
     */
    function postInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 remainingMakingAmount,
        bytes calldata /* extraData */
    ) external {
        if (msg.sender != SETTLEMENT && msg.sender != LIMIT_ORDER_PROTOCOL) revert OnlyFillCallers();

        bytes32 pending = _PENDING_SLOT.deriveMapping(orderHash);
        address target = pending.asAddress().tload();
        if (target == address(0)) revert MakerTransferNotRecorded();
        uint256 takerAssetBalanceBefore = pending.offset(1).asUint256().tload();
        pending.asAddress().tstore(address(0));

        uint256 received = IERC20(order.takerAsset.get()).balanceOf(address(this)) - takerAssetBalanceBefore;
        if (received == 0) revert NothingReceived();

        _settle(order, extension, orderHash, makingAmount, remainingMakingAmount, received, target);
    }

    /**
     * @notice Sends tokens that reached this contract outside of a fill to the owner.
     * @param token The token to rescue. The zero address and 0xEeee...EEeE stand for the native currency.
     * @param amount The amount to rescue.
     */
    function rescueFunds(IERC20 token, uint256 amount) external onlyOwner {
        token.uniTransfer(payable(msg.sender), amount);
    }

    /**
     * @dev Checks the order shape and that both the post-interaction and the taker asset end at this contract.
     * Overrides add their own checks and must call this implementation.
     */
    function _validateOrder(IOrderMixin.Order calldata order, bytes calldata extension) internal view virtual {
        MakerTraits makerTraits = order.makerTraits;
        if (
            order.makerAsset.get() != address(this) ||
            makerTraits.unwrapWeth() ||
            makerTraits.usePermit2() ||
            !makerTraits.needPreInteractionCall() ||
            !makerTraits.needPostInteractionCall()
        ) revert UnsupportedOrder();

        bytes calldata preInteractionData = extension.preInteractionTargetAndData();
        if (preInteractionData.length < 20 || address(bytes20(preInteractionData)) != address(this)) revert UnsupportedOrder();

        bytes calldata postInteractionData = extension.postInteractionTargetAndData();
        if (postInteractionData.length < 20) revert UnsupportedOrder();
        address postInteractionTarget = address(bytes20(postInteractionData));
        address receiver = order.receiver.get();
        if (postInteractionTarget == address(this)) {
            if (postInteractionData.length != 20 || receiver != address(this)) revert UnsupportedOrder();
        } else if (postInteractionTarget == SETTLEMENT) {
            _validateSettlementData(postInteractionData[20:], receiver);
        } else {
            revert UnsupportedOrder();
        }
    }

    /**
     * @dev Called in the pre-interaction after the order is validated, before the maker transfer is recorded.
     * @param order The order.
     * @param extension The order extension.
     * @param remainingMakingAmount The making amount left before this fill.
     * @param extraData The pre-interaction data after this contract's address.
     */
    function _beforeMakerTransfer(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        uint256 remainingMakingAmount,
        bytes calldata extraData
    ) internal virtual;

    /**
     * @dev Called in the post-interaction once the taker has paid. Must release `makingAmount` of the maker asset to `target`.
     * @param order The order.
     * @param extension The order extension.
     * @param orderHash The order hash.
     * @param makingAmount The making amount of this fill.
     * @param remainingMakingAmount The making amount left before this fill.
     * @param received The amount of taker asset this contract received during the fill.
     * @param target The fill target that must receive the maker asset.
     */
    function _settle(
        IOrderMixin.Order calldata order,
        bytes calldata extension,
        bytes32 orderHash,
        uint256 makingAmount,
        uint256 remainingMakingAmount,
        uint256 received,
        address target
    ) internal virtual;

    /**
     * @dev Checks that the Settlement calls this contract as its chained post-interaction, with no data,
     * and that the taker asset reaches this contract: either it is the order receiver, or the order receiver is the
     * Settlement and this contract is its custom receiver.
     * @param data The Settlement post-interaction data after the Settlement address.
     * @param receiver The order receiver.
     */
    function _validateSettlementData(bytes calldata data, address receiver) private view {
        if (data.length < _CUSTOM_RECEIVER_OFFSET) revert UnsupportedOrder();
        uint256 offset = _CUSTOM_RECEIVER_OFFSET;
        if (uint8(data[0]) & _CUSTOM_RECEIVER_FLAG != 0) {
            if (data.length < offset + 20) revert UnsupportedOrder();
            if (receiver == SETTLEMENT && address(bytes20(data[offset:])) != address(this)) revert UnsupportedOrder();
            offset += 20;
        } else if (receiver == SETTLEMENT) {
            revert UnsupportedOrder();
        }
        if (receiver != SETTLEMENT && receiver != address(this)) revert UnsupportedOrder();

        offset += _FEES_LENGTH + _ALLOWED_TIME_LENGTH;
        if (data.length <= offset) revert UnsupportedOrder();
        offset += 1 + uint256(uint8(data[offset])) * _WHITELIST_ENTRY_LENGTH + _SURPLUS_LENGTH;
        if (data.length != offset + 20 || address(bytes20(data[offset:])) != address(this)) revert UnsupportedOrder();
    }
}
