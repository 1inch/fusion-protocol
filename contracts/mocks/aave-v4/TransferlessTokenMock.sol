// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Token whose `transferFrom` reports success without moving anything.
contract TransferlessTokenMock is ERC20 {
    constructor() ERC20("Transferless", "TLT") {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return true;
    }
}
