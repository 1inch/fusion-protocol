// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { UniERC20 } from "@1inch/solidity-utils/contracts/libraries/UniERC20.sol";
import { WhitelistRegistry } from "./WhitelistRegistry.sol";

/**
 * @title CrosschainWhitelistRegistry
 * @notice The contract manages a promotees for crosschain resolvers. It also includes an
 * emergency rescue function for tokens sent to the contract accidentally.
 */
contract CrosschainWhitelistRegistry is Ownable {
    using UniERC20 for IERC20;

    error SamePromotee();

    /// @notice Emitted when a new worker for a resolver is set.
    event Promotion(address promoter, uint256 chainId, address promotee);

    mapping(address promoter => mapping(uint256 chainId => address promotee)) public promotions;

    WhitelistRegistry public immutable WHITELIST_REGISTRY;

    constructor(WhitelistRegistry _whitelistRegistry) Ownable(msg.sender) {
        WHITELIST_REGISTRY = _whitelistRegistry;
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
     * @notice Returns the worker list for a particular chain ID.
     * @param chainId The chain ID to get the promoted addresses for.
     * @return promotees A list of worker addresses.
     */
    function getPromotees(uint256 chainId) external view returns (address[] memory promotees) {
        promotees = WHITELIST_REGISTRY.getWhitelist();
        unchecked {
            uint256 len = promotees.length;
            for (uint256 i = 0; i < len; ++i) {
                promotees[i] = promotions[promotees[i]][chainId];
            }
        }
    }
}
