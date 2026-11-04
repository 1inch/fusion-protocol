// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";

contract ContractMakerMock is IERC1271 {
    using SafeERC20 for IERC20;

    error OnlySigner();

    address private immutable _SIGNER;

    constructor(address signer) {
        _SIGNER = signer;
    }

    function approve(IERC20 token, address spender) external {
        if (msg.sender != _SIGNER) revert OnlySigner();
        token.forceApprove(spender, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == _SIGNER ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
