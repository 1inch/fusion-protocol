# AGENTS.md

## Cursor Cloud specific instructions

This repo (`@1inch/limit-order-settlement`, the 1inch Fusion settlement contracts) is a
Hardhat 2 + Solidity 0.8.23 project. There is no long-running "app" or GUI — the
"application" is the contract suite plus its Hardhat test/deploy tooling. Standard
commands live in `README.md` and `package.json` (`yarn hardhat compile`, `yarn test`,
`yarn test:ci`, `yarn lint`, `yarn coverage`, `yarn docify`); prefer those.

### Toolchain / Node version (non-obvious)
- The project targets **Node.js 20** with **Yarn Classic (1.x)**. Node 20 is installed via
  `nvm` and set as the nvm `default`, and Yarn 1.22.x is installed into that Node. A login/
  interactive `bash` (e.g. `bash -lc '...'`) sources `~/.bashrc` → nvm and resolves Node 20 +
  `yarn` automatically. The update script already runs `yarn install` under Node 20.
- Gotcha: the exec-daemon's default non-login shell puts `/exec-daemon/node` (Node 22) first
  on `PATH` and has **no `yarn`**. If a raw command reports `yarn: command not found` or the
  wrong Node version, run `nvm use 20` (or use a login shell) first. Do not "fix" this by
  reinstalling — Node 20 + Yarn are already present via nvm.

### Running / testing (non-obvious)
- `yarn hardhat node` auto-runs the `hardhat-deploy` scripts in `deploy/`, which **fail on a
  fresh local chain** (they expect a CREATE3 deployer contract and `OPS_*` env vars meant for
  real networks). To run a clean local JSON-RPC node use `yarn hardhat node --no-deploy`, then
  interact with `yarn hardhat run --network localhost <script.js>`.
- `yarn test` runs with `--parallel`; the gas reporter is skipped in that mode. Use
  `yarn test:ci` (sequential, as CI does) to get gas numbers.
- The `Network '<name>' not registered` lines printed during compile/test are **informational**
  (no RPC URLs configured in the environment), not errors.
- Deployments go through the `Makefile` and require `OPS_*` variables in `.env` plus real
  network RPC access; none of that is needed for local development, compiling, or testing.

### Known repo state
- `yarn lint` currently reports pre-existing `space-before-function-paren` eslint errors in
  `scripts/mint-kyc.js` and `scripts/transfer-ownership.js`. These are existing code issues,
  not an environment problem — the lint toolchain itself works.
