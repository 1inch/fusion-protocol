// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../Settlement.sol";

contract SettlementMock is Settlement {
    constructor(IWhitelistRegistry whitelist, address limitOrderProtocol, IERC20 token)
        Settlement(whitelist, limitOrderProtocol, token)
    {}  // solhint-disable-line no-empty-blocks

    function decreaseAvailableCreditMock(address account, uint256 amount) external onlyOwner returns (uint256 allowance) {
        _chargeFee(account, amount);
    }
}
