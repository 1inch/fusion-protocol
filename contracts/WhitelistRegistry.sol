// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { UniERC20 } from "@1inch/solidity-utils/contracts/libraries/UniERC20.sol";
import { AddressSet, AddressArray } from "@1inch/solidity-utils/contracts/libraries/AddressSet.sol";

/**
 * @title WhitelistRegistry
 * @notice The contract manages a whitelist for trading resolvers, providing functions to register,
 * promote and remove addresses, as well as setting various thresholds and limits. It also includes an
 * emergency rescue function for tokens sent to the contract accidentally.
 */
contract WhitelistRegistry is Ownable {
    using UniERC20 for IERC20;
    using AddressSet for AddressSet.Data;
    using AddressArray for AddressArray.Data;

    error BalanceLessThanThreshold();
    error AlreadyRegistered();
    error SamePromotee();
    error InvalidThreshold();

    /// @notice Emitted after a new resolver is registered.
    event Registered(address addr);
    /// @notice Emitted when a resolver is pushed out of whitelist.
    event Unregistered(address addr);
    /// @notice Emitted when the new minimum total supply percentage to get into the whitelist is set.
    event ResolverPercentageThresholdSet(uint256 resolverPercentageThreshold);
    /// @notice Emitted when a new worker for a resolver is set.
    event Promotion(address promoter, uint256 chainId, address promotee);

    uint256 public constant BASIS_POINTS = 10000;
    IERC20 public immutable TOKEN;

    mapping(address promoter => mapping(uint256 chainId => address promotee)) public promotions;
    // 100% = 10000, 10% = 1000, 1% = 100
    uint256 public resolverPercentageThreshold;

    AddressSet.Data private _whitelist;

    constructor(
        IERC20 token_,
        uint256 resolverPercentageThreshold_
    ) Ownable(msg.sender) {
        TOKEN = token_;
        _setResolverPercentageThreshold(resolverPercentageThreshold_);
    }

    /**
     * @notice Allows the contract owner to recover any tokens accidentally sent to the contract.
     * @param token_ The token to recover.
     * @param amount The amount of tokens to recover.
     */
    function rescueFunds(IERC20 token_, uint256 amount) external onlyOwner {
        token_.uniTransfer(payable(msg.sender), amount);
    }

    /**
     * @notice Allows the contract owner to set a new resolver threshold.
     * The resolver threshold is the minimum total supply percentage required to get into the whitelist.
     * @param resolverPercentageThreshold_ The new resolver threshold.
     */
    function setResolverPercentageThreshold(uint256 resolverPercentageThreshold_) external onlyOwner {
        _setResolverPercentageThreshold(resolverPercentageThreshold_);
    }


    /**
     * @notice Attempts to register the caller in the whitelist.
     * @dev Reverts if the caller's total supply percentage is below the resolver threshold.
     */
    function register() external {
        uint256 percentageThreshold = resolverPercentageThreshold;
        uint256 totalSupply = TOKEN.totalSupply();
        if (!_isValidBalance(percentageThreshold, TOKEN.balanceOf(msg.sender), totalSupply)) revert BalanceLessThanThreshold();
        if (!_whitelist.add(msg.sender)) revert AlreadyRegistered();
        emit Registered(msg.sender);
        _clean(percentageThreshold, totalSupply);
    }

    /**
     * @notice Registers a worker for the resolver to settle orders.
     * @param chainId The chain ID where the worker will assigned.
     * @param promotee The worker's address.
     */
    function promote(uint256 chainId, address promotee) external {
        if (promotions[msg.sender][chainId] == promotee) revert SamePromotee();
        promotions[msg.sender][chainId] = promotee;
        emit Promotion(msg.sender, chainId, promotee);
    }

    /**
     * @notice Cleans the whitelist by removing addresses that fall below the resolver threshold.
     */
    function clean() external {
        _clean(resolverPercentageThreshold, TOKEN.totalSupply());
    }

    /**
     * @notice Returns the addresses in the whitelist.
     * @return whitelist A list of whitelisted addresses.
     */
    function getWhitelist() external view returns (address[] memory /* whitelist */) {
        return _whitelist.items.get();
    }

    /**
     * @notice Returns the worker list for a particular chain ID.
     * @param chainId The chain ID to get the promoted addresses for.
     * @return promotees A list of worker addresses.
     */
    function getPromotees(uint256 chainId) external view returns (address[] memory promotees) {
        promotees = _whitelist.items.get();
        unchecked {
            uint256 len = promotees.length;
            for (uint256 i = 0; i < len; ++i) {
                promotees[i] = promotions[promotees[i]][chainId];
            }
        }
    }

    function _setResolverPercentageThreshold(uint256 resolverPercentageThreshold_) private {
        if (resolverPercentageThreshold_ > BASIS_POINTS) revert InvalidThreshold();
        resolverPercentageThreshold = resolverPercentageThreshold_;
        emit ResolverPercentageThresholdSet(resolverPercentageThreshold_);
    }

    function _removeFromWhitelist(address account) private {
        _whitelist.remove(account);
        emit Unregistered(account);
    }

    function _isValidBalance(uint256 percentageThreshold, uint256 balance, uint256 totalSupply) private pure returns (bool) {
        return (
            balance > 0 &&
            balance * BASIS_POINTS >= totalSupply * percentageThreshold)
        ;
    }

    /**
     * @dev Removes addresses from the whitelist that fall below the resolver threshold.
     * @param percentageThreshold The whitelist enforced minimal percentage of token's total suplly.
     * @param totalSupply The total supply of the token.
     */
    function _clean(uint256 percentageThreshold, uint256 totalSupply) private {
        uint256 whitelistLength = _whitelist.length();
        unchecked {
            for (uint256 i = 0; i < whitelistLength; ) {
                address curWhitelisted = _whitelist.at(i);
                uint256 balance = TOKEN.balanceOf(curWhitelisted);
                if (!_isValidBalance(percentageThreshold, balance, totalSupply)) {
                    _removeFromWhitelist(curWhitelisted);
                    whitelistLength--;
                } else {
                    i++;
                }
            }
        }
    }
}
