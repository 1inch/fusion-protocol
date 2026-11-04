// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title Minimal Aave V4 Spoke interface
 * @notice Subset of the Aave V4 Spoke used by the Fusion Aave V4 extensions.
 * @dev Struct layouts mirror the deployed contracts, see https://github.com/aave/aave-v4/tree/main/src/spoke.
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

    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    /// @notice Returns the reserve listed under `reserveId`.
    function getReserve(uint256 reserveId) external view returns (Reserve memory);

    /// @notice Returns the amount of underlying `user` has supplied to `reserveId`.
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);

    /// @notice Returns whether `user` uses `reserveId` as collateral and whether they borrow it.
    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool usingAsCollateral, bool borrowing);

    /// @notice Returns the account data of `user`, including its health factor in WAD.
    function getUserAccountData(address user) external view returns (UserAccountData memory);

    /// @notice Approves or revokes position managers for `params.onBehalfOf` with an EIP-712 signature.
    function setUserPositionManagersWithSig(SetUserPositionManagers calldata params, bytes calldata signature) external;
}
