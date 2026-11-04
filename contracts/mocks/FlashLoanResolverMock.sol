// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { RevertReasonForwarder } from "@1inch/solidity-utils/contracts/libraries/RevertReasonForwarder.sol";

interface IMorphoFlashLoan {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/**
 * @notice Resolver without inventory for orders where the taker pays first: borrows the taker asset with a
 * Morpho Blue flash loan, fills, turns the maker asset it receives back into the borrowed asset, and repays.
 */
contract FlashLoanResolverMock {
    using SafeERC20 for IERC20;

    error OnlyOwner();
    error OnlyMorpho();

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address private immutable _OWNER;
    address private immutable _MORPHO;
    address private immutable _LIMIT_ORDER_PROTOCOL;

    constructor(address morpho, address limitOrderProtocol) {
        _OWNER = msg.sender;
        _MORPHO = morpho;
        _LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
    }

    receive() external payable {}

    /**
     * @param token The taker asset to borrow.
     * @param amount The amount to borrow.
     * @param fill Calldata for the Limit Order Protocol fill.
     * @param unwind Calls that run after the fill and must leave at least `amount` of `token` here.
     */
    function flashFill(IERC20 token, uint256 amount, bytes calldata fill, Call[] calldata unwind) external {
        if (msg.sender != _OWNER) revert OnlyOwner();
        IMorphoFlashLoan(_MORPHO).flashLoan(address(token), amount, abi.encode(token, fill, unwind));
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != _MORPHO) revert OnlyMorpho();
        (IERC20 token, bytes memory fill, Call[] memory unwind) = abi.decode(data, (IERC20, bytes, Call[]));

        token.forceApprove(_LIMIT_ORDER_PROTOCOL, assets);
        _call(_LIMIT_ORDER_PROTOCOL, 0, fill);
        for (uint256 i = 0; i < unwind.length; i++) {
            _call(unwind[i].target, unwind[i].value, unwind[i].data);
        }
        token.forceApprove(_MORPHO, assets);
    }

    function _call(address target, uint256 value, bytes memory data) private {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = target.call{ value: value }(data);
        if (!success) RevertReasonForwarder.reRevert();
    }
}
