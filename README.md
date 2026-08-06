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

Generated API documentation for each contract lives in [`docs/`](docs).

## Repository layout

```
contracts/      Solidity sources
  helpers/      auxiliary contracts
  interfaces/   external interfaces
  mocks/        contracts used only by the tests
test/           Hardhat tests, including gas measurements
  helpers/      order-building helpers, also published in the npm package
deploy/         hardhat-deploy scripts, one per contract
scripts/        one-off operational scripts (KYC minting, ownership transfer)
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

Addresses and ABIs for every network are committed under [`deployments/`](deployments), currently covering Ethereum mainnet, Arbitrum, Aurora, Avalanche, Base, BNB Chain, Fantom, Gnosis Chain, Klaytn, Linea, Optimism, Polygon, Sonic, Unichain and zkSync Era.

Mainnet, as recorded in [`deployments/mainnet`](deployments/mainnet):

| Contract | Address |
| --- | --- |
| Settlement | [0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5](https://etherscan.io/address/0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5) |
| WhitelistRegistry | [0xcb8308fcB7BC2f84ed1bEa2C016991D34de5cc77](https://etherscan.io/address/0xcb8308fcB7BC2f84ed1bEa2C016991D34de5cc77) |
| CrosschainWhitelistRegistry | [0xBe89346fE1cE1367f3d80C8522209A86511B1201](https://etherscan.io/address/0xBe89346fE1cE1367f3d80C8522209A86511B1201) |
| PowerPod | [0xAccfAc2339e16DC80c50d2fa81b5c2B049B4f947](https://etherscan.io/address/0xAccfAc2339e16DC80c50d2fa81b5c2B049B4f947) |
| KycNFT | [0xAccE550000863572B867E661647CD7D97b72C507](https://etherscan.io/address/0xAccE550000863572B867E661647CD7D97b72C507) |
| ResolverMetadata | [0xBF4543819ECede56220bcB1e8C1BBa9Ef290a58a](https://etherscan.io/address/0xBF4543819ECede56220bcB1e8C1BBa9Ef290a58a) |

Deployments go through the [`Makefile`](Makefile), which validates the required parameters, records them in `config/constants.json` and then runs the matching `hardhat-deploy` script. Run `make help` for the full list of targets.

```bash
make deploy-settlement            # also: deploy-access-token, deploy-power-pod,
                                  # deploy-whitelist-registry, deploy-crosschain-whitelist,
                                  # deploy-resolver-metadata
make get OPS_NETWORK=mainnet PARAMETER=OPS_SETTLEMENT_ADDRESS   # read an address back out of deployments/
```

Parameters are read from a `.env` file as `OPS_*` variables. `OPS_NETWORK` and `OPS_CHAIN_ID` are always required; each target validates its own additions, so `deploy-settlement`, for example, also needs `OPS_ROUTER_V6_ADDRESS`, `OPS_ACCESS_TOKEN_ADDRESS`, `OPS_WETH_ADDRESS` and `OPS_SETTLEMENT_OWNER_ADDRESS`. Contracts are deployed through a CREATE3 deployer so that the same address is used on every chain, which needs `OPS_CREATE3_DEPLOYER_ADDRESS` and a salt; zkSync Era does not support CREATE3 and falls back to a plain deployment.

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
