// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Address, AddressLib} from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { RevertReasonForwarder } from "@1inch/solidity-utils/contracts/libraries/RevertReasonForwarder.sol";
import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { ITakerInteraction } from "@1inch/limit-order-protocol-contract/contracts/interfaces/ITakerInteraction.sol";

contract ResolverMock is ITakerInteraction {
    error OnlyOwner();
    error NotTaker();
    error OnlyLOP();
    error FailedExternalCall(uint256 index, bytes reason);

    using SafeERC20 for IERC20;
    using AddressLib for Address;

    bytes1 private constant _FINALIZE_INTERACTION = 0x01;

    address private immutable _SETTLEMENT_EXTENSION;
    IOrderMixin private immutable _LOPV4;
    address private immutable _OWNER;

    modifier onlyOwner () {
        if (msg.sender != _OWNER) revert OnlyOwner();
        _;
    }

    constructor(address settlementExtension, IOrderMixin limitOrderProtocol) {
        _SETTLEMENT_EXTENSION = settlementExtension;
        _LOPV4 = limitOrderProtocol;
        _OWNER = msg.sender;
    }

    function approve(IERC20 token, address to) external onlyOwner {
        token.forceApprove(to, type(uint256).max);
    }

    function settleOrders(bytes calldata data) external onlyOwner() {
        _settleOrders(data);
    }

    /// @dev High byte of `packing` contains number of permits, each 2 bits from lowest contains length of permit (index in [92,120,148] array)
    function settleOrdersWithPermits(bytes calldata data, uint256 packing, bytes calldata packedPermits) external onlyOwner {
        _performPermits(packing, packedPermits);
        _settleOrders(data);
    }

    function _settleOrders(bytes calldata data) internal {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success,) = address(_LOPV4).call(data);
        if (!success) RevertReasonForwarder.reRevert();
    }

    function takerInteraction(
        IOrderMixin.Order calldata /* order */,
        bytes calldata /* extension */,
        bytes32 /* orderHash */,
        address taker,
        uint256 /* makingAmount */,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata extraData
    ) public {
        if (msg.sender != address(_LOPV4)) revert OnlyLOP();
        if (taker != address(this)) revert NotTaker();

        unchecked {
            if (extraData[0] == _FINALIZE_INTERACTION) {
                if (extraData.length > 1) {
                    (Address[] memory targets, bytes[] memory calldatas) = abi.decode(extraData[1:], (Address[], bytes[]));
                    for (uint256 i = 0; i < targets.length; ++i) {
                        // solhint-disable-next-line avoid-low-level-calls
                        (bool success, bytes memory reason) = targets[i].get().call(calldatas[i]);
                        if (!success) revert FailedExternalCall(i, reason);
                    }
                }
            } else {
                _settleOrders(extraData[1:]);
            }
        }
    }

    function _performPermits(uint256 packing, bytes calldata packedPermits) private {
        unchecked {
            uint256 permitsCount = packing >> 248;
            uint256 start = 0;
            for (uint256 i = 0; i < permitsCount; i++) {
                uint256 length = (packing >> (i << 1)) & 0x03;
                if (length == 0) length = 112;
                else if (length == 1) length = 140;
                else if (length == 2) length = 136;

                bytes calldata permit = packedPermits[start:start + length];
                address owner = address(bytes20(permit));
                IERC20 token = IERC20(address(bytes20(permit[20:])));
                token.safePermit(owner, address(_LOPV4), permit[40:]);
                start += length;
            }
        }
    }
}
