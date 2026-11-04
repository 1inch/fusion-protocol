# 1inch Fusion Protocol

[![Build Status](https://github.com/1inch/fusion-protocol/workflows/CI/badge.svg)](https://github.com/1inch/fusion-protocol/actions)
[![Coverage Status](https://codecov.io/gh/1inch/fusion-protocol/branch/master/graph/badge.svg?token=ZtdQHKURYO)](https://codecov.io/gh/1inch/fusion-protocol)
[![NPM Package](https://img.shields.io/npm/v/@1inch/limit-order-settlement.svg)](https://www.npmjs.com/package/@1inch/limit-order-settlement)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

Smart contracts for 1inch Fusion — the intent-based swap mode of the 1inch Network.

In Fusion, a user does not send a swap transaction. They sign an off-chain order for the [1inch Limit Order Protocol](https://github.com/1inch/limit-order-protocol) whose exchange rate improves over time as a Dutch auction. Professional market makers, called resolvers, compete to fill that order and pay the gas for it. The user gets a rate that no longer depends on their own gas budget or on the mempool, and the fill never becomes a public pending transaction that can be front-run.

This repository holds the on-chain half of that flow: the settlement extension that the Limit Order Protocol calls while filling a Fusion order, the registries that decide which resolvers may fill, and the access token that gates them.

## How a Fusion order is settled

1. The maker signs a limit order whose extension points at the settlement contract, so the contract acts as both the amount getter and the post-interaction handler for every fill.
2. A resolver calls `fillOrder` on the Limit Order Protocol. `SimpleSettlement` computes the price for the current block through `_getMakingAmount` / `_getTakingAmount`, applying the auction rate bump encoded in the order's `auctionDetails`.
3. In the post-interaction, the contract checks that the caller is allowed to fill right now. The whitelist is packed into the order itself as a start time plus per-resolver time deltas, which gives each whitelisted resolver an exclusivity window before the next one is allowed in. A taker outside the whitelist can only fill once the whole schedule has elapsed, and only while holding the access token.
4. Fees are taken from the taking amount: an integrator fee, a protocol fee, and a configurable share of any surplus above the estimated taking amount quoted when the order was created.
5. On Ethereum mainnet the `Settlement` contract additionally rejects a fill whose priority fee exceeds the cap set by [1inch DAO proposal](https://snapshot.org/#/1inch.eth/proposal/0xa040c60050147a0f67042ae024673e92e813b5d2c0f748abf70ddfa1ed107cbe), which stops resolvers from bidding away the user's surplus in gas.

The auction curve is a piecewise linear function: an initial rate bump that decays through a list of `(rateBump, timeDelta)` points down to zero at the end of the auction. The current base fee is folded into the calculation through `gasBumpEstimate` and `gasPriceEstimate`, so the part of the bump that merely compensates the resolver for gas disappears when gas is cheaper than it was at quote time.

## Contracts

| Contract | Description |
| --- | --- |
| [`SimpleSettlement`](contracts/SimpleSettlement.sol) | The settlement extension. Dutch auction pricing, whitelist and timing checks, integrator / protocol / surplus fees. Deployed on every supported network. |
| [`Settlement`](contracts/Settlement.sol) | `SimpleSettlement` plus the mainnet priority fee cap. |
| [`WhitelistRegistry`](contracts/WhitelistRegistry.sol) | On-chain resolver whitelist. An address registers by holding at least a configured percentage of `PowerPod` total supply, and is evicted by `clean()` once it drops below that threshold. Resolvers also promote a worker address per chain to do the actual settling. |
| [`CrosschainWhitelistRegistry`](contracts/CrosschainWhitelistRegistry.sol) | Per-chain worker promotions for resolvers, taking the resolver set from `WhitelistRegistry` instead of maintaining its own. |
| [`PowerPod`](contracts/PowerPod.sol) | Combines st1INCH farming and delegation with voting power, and is the token whose balances the whitelist threshold is measured against. |
| [`KycNFT`](contracts/KycNFT.sol) | The access token. An ERC-721 limited to one token per address, where minting and transfers are performed by the contract owner or by anyone presenting an EIP-712 signature from the owner. |
| [`ResolverMetadata`](contracts/helpers/ResolverMetadata.sol) | Lets a registered resolver publish the URL of the metadata shown for it in the 1inch dApp. |
| [`AaveV4CollateralSwap`](contracts/extensions/AaveV4CollateralSwap.sol) | Order extension that swaps one Aave V4 supply position into another on the same Spoke, with the taker paying first. See [Aave V4 collateral swaps](#aave-v4-collateral-swaps). |
| [`DeferredMakerAsset`](contracts/extensions/DeferredMakerAsset.sol) | Abstract base of `AaveV4CollateralSwap`: an extension that stands in as the order's maker asset and releases it only once the taker asset has arrived. |

Generated API documentation for each contract lives in [`docs/`](docs).

## Aave V4 collateral swaps

`AaveV4CollateralSwap` lets a user swap the collateral of an Aave V4 position through a Fusion order, for example WETH into wstETH, without repaying their debt first. The Spoke re-checks the health factor whenever collateral is withdrawn, so the new asset has to be in the position before the old one leaves. A regular fill moves the maker asset first; this extension makes the taker pay first:

1. The resolver fills the order through Router V6 as usual. In the pre-interaction, the extension validates the order and, on the first fill, applies the user's Aave V4 signatures.
2. The order's maker asset is the extension itself, so the Limit Order Protocol's maker-to-taker transfer only records where the old collateral has to go.
3. The resolver pays the new asset. The Settlement takes its fees, forwards the rest to the extension as its custom receiver, and then calls the extension as its chained post-interaction.
4. The extension supplies the new asset for the user through the Aave V4 GiverPositionManager. It then withdraws the old collateral through the TakerPositionManager to the resolver's fill target, and the Spoke checks the health factor with the new supply already counted.

Router V6 and the deployed Settlement are unchanged. Plain limit orders work as well, with the extension as the order's receiver and post-interaction instead of the Settlement. Resolvers fund the new asset from inventory, a flash loan or a purchase with their own funds, because the old collateral only reaches them at the end of the fill. [`FlashLoanResolverMock`](contracts/mocks/FlashLoanResolverMock.sol) shows a resolver that borrows it with a Morpho Blue flash loan.

### Order layout

| Field | Value |
| --- | --- |
| `makerAsset` | The extension. |
| `makerAssetSuffix` | `abi.encode(SwapParams)`, see [`IAaveV4CollateralSwap`](contracts/interfaces/IAaveV4CollateralSwap.sol). |
| `takerAsset` | The underlying of the buy reserve. |
| `makingAmount`, `takingAmount` | In the underlying of the sell reserve and of the buy reserve. |
| `receiver` | The Settlement, with the extension as its custom receiver, when the order pays fees. Otherwise the extension. |
| `preInteraction` | The extension, followed by `abi.encode(Permits)` when the order carries Aave V4 signatures. |
| `postInteraction` | The Settlement with the extension as its chained post-interaction, or the extension alone for a plain limit order. |
| `makerTraits` | Pre- and post-interaction calls on, no `unwrapWeth`, no `usePermit2`. Partial and multiple fills are allowed. |

`SwapParams` holds the Spoke, the sell and buy reserve ids, an optional minimum health factor after each fill, `maxDust` (see below) and two flags. Bit 0 renounces the withdraw allowance on the final fill. Bit 1 makes the fill revert unless the buy reserve counts as the user's collateral. Set bit 1 whenever the new position should be collateral: a resolver can make the signed collateral switch fail by forwarding too little gas, and without the flag the fill would still succeed.

`validateOrder(order, extension)` runs the checks a fill makes on the order and its swap parameters, so off-chain services can reject a malformed order before broadcasting it. [`test/helpers/aaveV4Utils.js`](test/helpers/aaveV4Utils.js) has reference encoders: `buildAaveV4CollateralSwapOrder`, `encodeSwapParams` and `signAaveV4Permits`.

### Signatures

Besides the order, a user signs up to three Aave V4 messages. Each is only needed when it is not already in place, and is applied on the first fill:

| Message | Verified by | Effect |
| --- | --- | --- |
| `SetUserPositionManagers` | Spoke | Approves the Giver, Taker and SignatureGateway position managers for the user. |
| `SetUsingAsCollateral` | SignatureGateway | Enables the buy reserve as collateral. |
| `WithdrawPermit` | TakerPositionManager | Lets the extension withdraw from the sell reserve. |

The extension rejects a message that grants anything else (`InvalidPermit`). It applies the messages in try/catch, so a message that a front-runner already submitted does not block the order. Aave V4 nonces are keyed: use a random key per message, so that open orders don't invalidate each other, and a deadline no earlier than the order's expiry.

Position manager approvals persist per Spoke. The withdraw allowance has two modes:

- **Max allowance (default).** It persists like a token approval to Router V6, so a returning user usually signs only the order. Every withdrawal is still bounded by a signed order.
- **Exact allowance.** Sign `makingAmount + maxDust` plus a few wei for rounding, and set bit 0 to renounce what is left on the final fill. A new `WithdrawPermit` replaces the allowance rather than adding to it, so a user should have only one open order per sell reserve in this mode.

### Partial fills and dust

Aave V4 rounds withdrawals in shares, so a partial fill can take a few wei more from the position than its making amount, and the supply keeps accruing interest while the order is open. To close a whole position, sign a `makingAmount` slightly below the supplied balance and set `maxDust` above the gap. If what is left after the final fill's making amount is at most `maxDust`, the final fill withdraws it too, within the allowance, and sends it to the user.

### Gas

Measured on forks, for whole Fusion fill transactions through a resolver contract:

| Fill | Ethereum | Avalanche |
| --- | --- | --- |
| First fill, applying all three signatures, with an integrator fee | 859,547 | 831,136 |
| Later fill, without signatures or fees | 533,743 | 505,758 |

The extension uses transient storage, so `hardhat.config.js` compiles it for Cancun on every chain.

`test/AaveV4CollateralSwap.js` covers the extension against mocks of the Aave V4 contracts. `yarn test:fork` runs [`test/fork/AaveV4CollateralSwap.fork.js`](test/fork/AaveV4CollateralSwap.fork.js) against the live Aave V4, Router V6 and Settlement contracts on Ethereum or Avalanche. Base is not covered: its Aave V4 collateral is tokenized equities that Base nodes implement natively, which a Hardhat fork cannot execute. Verify Base with simulations against a Base node and a small canary fill after deployment.

## Repository layout

```
contracts/      Solidity sources
  extensions/   order extensions for the Limit Order Protocol
  helpers/      auxiliary contracts
  interfaces/   external interfaces
  mocks/        contracts used only by the tests
test/           Hardhat tests, including gas measurements
  fork/         opt-in tests against live contracts on a fork
  helpers/      order-building helpers, also published in the npm package
deploy/         hardhat-deploy scripts, one per contract
scripts/        one-off operational scripts (KYC minting, ownership transfer, deployment dry runs)
config/         per-chain constants consumed by the deploy scripts
deployments/    hardhat-deploy artifacts per network, including addresses and ABIs
docs/           generated contract documentation
```

## Getting started

The project uses Hardhat 2 with Node.js 20 and Yarn, and compiles with solc 0.8.23 via IR.

```bash
yarn                     # install dependencies
yarn hardhat compile     # compile the contracts
yarn test                # run the test suite in parallel
yarn test:ci             # run it sequentially, as CI does
yarn test:fork           # Aave V4 fork tests: AAVE_V4_FORK_RPC=<rpc> AAVE_V4_FORK_CHAIN=ethereum|avalanche
yarn coverage            # solidity-coverage report
yarn lint                # eslint + solhint
yarn lint:fix            # autofix what can be autofixed
yarn docify              # regenerate docs/ from NatSpec
```

[CI](.github/workflows/test.yml) runs the linter, the test suite and the coverage report on every pull request.

To build on top of the contracts from another project, install the published package:

```bash
yarn add @1inch/limit-order-settlement
```

It ships the contract sources, the interfaces, and the order-building helpers in `test/helpers`.

## Deployments

Addresses and ABIs are committed under [`deployments/`](deployments) for every network below except the three most recent ones — Cronos, Monad and HyperEVM — whose artifacts have not landed in the repository yet.

### Settlement

Deployment goes through a CREATE3 deployer, so the address depends on the salt rather than on the chain, and the same address is reused across a whole rollout. The original rollout shares one address across fourteen networks, the recent Cronos, Monad and HyperEVM deployments share another, and zkSync Era stands alone because it does not support CREATE3.

Ethereum mainnet runs `Settlement`, the variant with the priority fee cap; every other chain runs `SimpleSettlement`.

| Network | Chain ID | Contract | Address |
| --- | --- | --- | --- |
| Ethereum | 1 | `Settlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://etherscan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Arbitrum One | 42161 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://arbiscan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Aurora | 1313161554 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://explorer.aurora.dev/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Avalanche | 43114 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://snowtrace.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Base | 8453 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://basescan.org/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| BNB Chain | 56 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://bscscan.com/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Cronos | 25 | `SimpleSettlement` | [0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F](https://cronoscan.com/address/0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F) |
| Fantom | 250 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://explorer.fantom.network/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Gnosis Chain | 100 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://gnosisscan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| HyperEVM | 999 | `SimpleSettlement` | [0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F](https://hyperevmscan.io/address/0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F) |
| Kaia (Klaytn) | 8217 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://kaiascan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Linea | 59144 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://lineascan.build/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Monad | 143 | `SimpleSettlement` | [0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F](https://monadscan.com/address/0x65497E56Cf49c51f1c1d54dc9005a7b38B98B30F) |
| Optimism | 10 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://optimistic.etherscan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Polygon | 137 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://polygonscan.com/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Sonic | 146 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://sonicscan.org/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| Unichain | 130 | `SimpleSettlement` | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://uniscan.xyz/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| zkSync Era | 324 | `SimpleSettlement` | [0x8261425Bf01CAf25259dAbE36FD05F430b38AEe0](https://explorer.zksync.io/address/0x8261425Bf01CAf25259dAbE36FD05F430b38AEe0) |

### Other contracts

`KycNFT`, the access token passed to the settlement constructor, follows the same pattern: `0xAccE550000863572B867E661647CD7D97b72C507` on every network recorded in `deployments/` ([mainnet](https://etherscan.io/address/0xAccE550000863572B867E661647CD7D97b72C507)), except zkSync Era, where it is [0x46B64318C4f764F6Fe81dFd1F26282A52E0f1680](https://explorer.zksync.io/address/0x46B64318C4f764F6Fe81dFd1F26282A52E0f1680).

The registries and the staking pod exist on Ethereum mainnet only:

| Contract | Address |
| --- | --- |
| WhitelistRegistry | [0xcb8308fcB7BC2f84ed1bEa2C016991D34de5cc77](https://etherscan.io/address/0xcb8308fcB7BC2f84ed1bEa2C016991D34de5cc77) |
| CrosschainWhitelistRegistry | [0xBe89346fE1cE1367f3d80C8522209A86511B1201](https://etherscan.io/address/0xBe89346fE1cE1367f3d80C8522209A86511B1201) |
| PowerPod | [0xAccfAc2339e16DC80c50d2fa81b5c2B049B4f947](https://etherscan.io/address/0xAccfAc2339e16DC80c50d2fa81b5c2B049B4f947) |
| ResolverMetadata | [0xBF4543819ECede56220bcB1e8C1BBa9Ef290a58a](https://etherscan.io/address/0xBF4543819ECede56220bcB1e8C1BBa9Ef290a58a) |

`AaveV4CollateralSwap` is not deployed yet. It is meant for Ethereum, Avalanche and Base, the chains where Aave V4 runs.

Deployments go through the [`Makefile`](Makefile), which validates the required parameters, records them in `config/constants.json` and then runs the matching `hardhat-deploy` script. Run `make help` for the full list of targets.

```bash
make deploy-settlement            # also: deploy-access-token, deploy-power-pod,
                                  # deploy-whitelist-registry, deploy-crosschain-whitelist,
                                  # deploy-resolver-metadata, deploy-aave-v4-collateral-swap
make get OPS_NETWORK=mainnet PARAMETER=OPS_SETTLEMENT_ADDRESS   # read an address back out of deployments/
```

Parameters are read from a `.env` file as `OPS_*` variables. `OPS_NETWORK` and `OPS_CHAIN_ID` are always required; each target validates its own additions, so `deploy-settlement`, for example, also needs `OPS_ROUTER_V6_ADDRESS`, `OPS_ACCESS_TOKEN_ADDRESS`, `OPS_WETH_ADDRESS` and `OPS_SETTLEMENT_OWNER_ADDRESS`. Contracts are deployed through a CREATE3 deployer so that the same address is used on every chain, which needs `OPS_CREATE3_DEPLOYER_ADDRESS` and a salt; zkSync Era does not support CREATE3 and falls back to a plain deployment.

`deploy-aave-v4-collateral-swap` takes the Router V6, Settlement, Aave V4 position manager and owner addresses for Ethereum, Avalanche and Base from `config/constants.json`. The matching `OPS_*` variables override them, and the script refuses to deploy if an address has no code on the target chain. It needs `OPS_AAVE_V4_COLLATERAL_SWAP_SALT`; use the same salt on every chain to get one address. Dry-run each deployment first with the same variables:

```bash
make dry-run-aave-v4-collateral-swap   # deploys to a local fork of OPS_NETWORK, read from <NETWORK>_RPC_URL
make deploy-aave-v4-collateral-swap
```

The dry run hands the CREATE3 deployer to a local account on the fork, deploys through it, and checks every constructor argument of the deployed contract against `config/constants.json`. Nothing is sent to the live network.

## Audits

Audit reports for the Fusion contracts are published in [1inch/1inch-audits](https://github.com/1inch/1inch-audits), under *Fusion Settlement V2*, *Fusion mode and Token-plugins*, and *Fees for LO and Fusion V1*.

## Security

Please do not report vulnerabilities through public GitHub issues or pull requests.

<!-- TODO: add the private disclosure channel (security contact or bug bounty program) before publishing. -->

More on how 1inch approaches security: [1inch.io/security](https://1inch.io/security/).

## Documentation

- [Fusion swap introduction](https://docs.1inch.io/docs/fusion-swap/introduction) — protocol documentation
- [1inch Developer Portal](https://portal.1inch.dev/documentation/apis/swap/fusion/introduction) — the API resolvers and integrators build against
- [Limit Order Protocol](https://github.com/1inch/limit-order-protocol) — the order format and fill mechanics Fusion extends

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and make sure `yarn lint` and `yarn test` pass before opening a PR.

## License

MIT, see [LICENSE.md](LICENSE.md).
