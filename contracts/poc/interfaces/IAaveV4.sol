// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @dev Minimal subset of the Aave V4 interfaces used by the collateral swap proof of concept.
 * Struct layouts mirror the deployed contracts, see https://github.com/aave/aave-v4/tree/main/src.
 */
interface IAaveV4Spoke {
    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags;
        uint32 dynamicConfigKey;
    }

    struct PositionManagerUpdate {
        address positionManager;
        bool approve;
    }

    struct SetUserPositionManagers {
        address onBehalfOf;
        PositionManagerUpdate[] updates;
        uint256 nonce;
        uint256 deadline;
    }

    function getReserve(uint256 reserveId) external view returns (Reserve memory);

    function setUserPositionManagersWithSig(SetUserPositionManagers calldata params, bytes calldata signature) external;
}

interface IAaveV4GiverPositionManager {
    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

interface IAaveV4TakerPositionManager {
    struct WithdrawPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    function approveWithdrawWithSig(WithdrawPermit calldata params, bytes calldata signature) external;

    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

interface IAaveV4SignatureGateway {
    struct SetUsingAsCollateral {
        address spoke;
        uint256 reserveId;
        bool useAsCollateral;
        address onBehalfOf;
        uint256 nonce;
        uint256 deadline;
    }

    function setUsingAsCollateralWithSig(SetUsingAsCollateral calldata params, bytes calldata signature) external;
}
