// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

/**
 * @notice Signature bookkeeping shared by the Aave V4 mocks. Signatures are not verified.
 * @dev Every applied or replayed intent is counted. A replayed nonce is a no-op, like a front-run signature.
 * `failSignedCalls` makes every intent revert, standing in for a call starved of gas.
 */
abstract contract SignedCallsMock {
    error SignedCallFailed();

    bool public failSignedCalls;
    uint256 public signedCalls;
    mapping(address owner => mapping(uint256 nonce => bool)) public usedNonces;

    function setFailSignedCalls(bool fail) external {
        failSignedCalls = fail;
    }

    function _consumeIntent(address owner, uint256 nonce) internal returns (bool) {
        if (failSignedCalls) revert SignedCallFailed();
        signedCalls++;
        if (usedNonces[owner][nonce]) return false;
        usedNonces[owner][nonce] = true;
        return true;
    }
}
