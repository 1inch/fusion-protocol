// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IOrderMixin } from "@1inch/limit-order-protocol-contract/contracts/interfaces/IOrderMixin.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { GnosisSafeStorage } from "@gnosis.pm/safe-contracts/contracts/examples/libraries/GnosisSafeStorage.sol";
import { GnosisSafe } from "@gnosis.pm/safe-contracts/contracts/GnosisSafe.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { IOrderRegistrator } from "./interfaces/IOrderRegistrator.sol";

contract SafeOrderBuilder is GnosisSafeStorage {
    error StaleOraclePrice();

    bytes32 private constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");

    IOrderMixin private immutable _LIMIT_ORDER_PROTOCOL;
    IOrderRegistrator private immutable _ORDER_REGISTRATOR;

    constructor(IOrderMixin limitOrderProtocol, IOrderRegistrator orderRegistrator) {
        _LIMIT_ORDER_PROTOCOL = limitOrderProtocol;
        _ORDER_REGISTRATOR = orderRegistrator;
    }

    struct OracleQueryParams {
        AggregatorV3Interface oracle;
        uint256 originalAnswer;
        uint256 ttl;
    }

    function buildAndSignOrder(
        IOrderMixin.Order memory order,
        bytes calldata extension,
        OracleQueryParams calldata makerAssetOracleParams,
        OracleQueryParams calldata takerAssetOracleParams
    ) external {
        {
            // account for makerAsset volatility
            (, int256 latestAnswer,, uint256 updatedAt,) = makerAssetOracleParams.oracle.latestRoundData();
            // solhint-disable-next-line not-rely-on-time
            if (updatedAt + makerAssetOracleParams.ttl < block.timestamp) revert StaleOraclePrice();
            order.takingAmount = Math.mulDiv(order.takingAmount, uint256(latestAnswer), makerAssetOracleParams.originalAnswer);
        }

        {
            // account for takerAsset volatility
            (, int256 latestAnswer,, uint256 updatedAt,) = takerAssetOracleParams.oracle.latestRoundData();
            // solhint-disable-next-line not-rely-on-time
            if (updatedAt + takerAssetOracleParams.ttl < block.timestamp) revert StaleOraclePrice();
            order.takingAmount = Math.mulDiv(order.takingAmount, takerAssetOracleParams.originalAnswer, uint256(latestAnswer));
        }

        bytes32 msgHash = _getMessageHash(abi.encode(_LIMIT_ORDER_PROTOCOL.hashOrder(order)));
        signedMessages[msgHash] = 1;

        _ORDER_REGISTRATOR.registerOrder(order, extension, "");
    }

    /// @dev Returns hash of a message that can be signed by owners.
    /// @param message Message that should be hashed
    /// @return Message hash.
    function _getMessageHash(bytes memory message) private view returns (bytes32) {
        bytes32 safeMessageHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(message)));
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), GnosisSafe(payable(address(this))).domainSeparator(), safeMessageHash));
    }
}
