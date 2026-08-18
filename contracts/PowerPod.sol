// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { FarmingDelegationPlugin } from "@1inch/delegating/contracts/FarmingDelegationPlugin.sol";
import { IVotable } from "@1inch/st1inch/contracts/interfaces/IVotable.sol";
import { ISt1inch } from "@1inch/st1inch/contracts/interfaces/ISt1inch.sol";
import { VotingPowerCalculator } from "@1inch/st1inch/contracts/helpers/VotingPowerCalculator.sol";

/**
 * @title PowerPod
 * @notice The contract combines farming and delegation features of pods with voting power calculations for the participating accounts.
 * @dev Limits pods number and the gas usage per pod.
 */
contract PowerPod is FarmingDelegationPlugin, VotingPowerCalculator, IVotable {
    uint256 private constant _MAX_SHARE_PODS = 3;
    uint256 private constant _SHARE_POD_GAS_LIMIT = 140_000;

    constructor(string memory name_, string memory symbol_, ISt1inch st1inch)
        FarmingDelegationPlugin(name_, symbol_, st1inch, _MAX_SHARE_PODS, _SHARE_POD_GAS_LIMIT)
        VotingPowerCalculator(st1inch.EXP_BASE(), st1inch.ORIGIN())
    {}

    /**
     * @dev Returns the voting power of the specified account at the current block.
     * @param account The account to get the voting power for.
     * @return votingPower The voting power of the account.
     */
    function votingPowerOf(address account) external view virtual returns (uint256 /* votingPower */) {
        return _votingPowerAt(balanceOf(account), block.timestamp);
    }
}
