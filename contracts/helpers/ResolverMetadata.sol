// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { ITokenizedDelegationPlugin } from "@1inch/delegating/contracts/interfaces/ITokenizedDelegationPlugin.sol";

/// @notice Stores resolvers link to their metadata, which is displayed in 1inch dapp.
contract ResolverMetadata {

    /// @dev Emitted when an unregistered resolver tries to perform a restricted operation.
    error NotRegisteredDelegatee();

    ITokenizedDelegationPlugin public immutable DELEGATION;
    mapping (address resolver => string url) public getUrl;

    /// @dev Modifier to check if the sender is a registered resolver.
    modifier onlyRegistered {
        if (address(DELEGATION.registration(msg.sender)) == address(0)) revert NotRegisteredDelegatee();
        _;
    }

    constructor(ITokenizedDelegationPlugin delegation_) {
        DELEGATION = delegation_;
    }

    /**
     * @notice Sets the resolver's URL pointing to the metadata.
     * @dev Only resolver registered for delegation can call this function.
     * @param url The resolver URL to be set for the resolver.
     */
    function setResolverUrl(string calldata url) external onlyRegistered {
        getUrl[msg.sender] = url;
    }
}
