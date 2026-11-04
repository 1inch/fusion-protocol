// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { RevertReasonForwarder } from "@1inch/solidity-utils/contracts/libraries/RevertReasonForwarder.sol";

/// @notice Contract wallet that accepts signatures of its owner (EIP-1271) and executes the owner's calls.
contract SmartWalletMock is IERC1271 {
    error OnlyOwner();

    address public immutable OWNER;

    constructor(address owner) {
        OWNER = owner;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != OWNER) revert OnlyOwner();
        bool success;
        // solhint-disable-next-line avoid-low-level-calls
        (success, result) = target.call(data);
        if (!success) RevertReasonForwarder.reRevert();
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError error, ) = ECDSA.tryRecover(hash, signature);
        return error == ECDSA.RecoverError.NoError && signer == OWNER ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
