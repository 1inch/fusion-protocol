const hre = require('hardhat');
const { ethers, network, getChainId, deployments } = hre;
const { resetHardhatNetworkFork } = require('@1inch/solidity-utils/hardhat-setup');
const constants = require('../config/constants');
const deployAaveV4CollateralSwap = require('../deploy/deploy-aave-v4-collateral-swap');

// Runs deploy/deploy-aave-v4-collateral-swap.js on a local fork of OPS_NETWORK (mainnet if unset or hardhat) and checks
// the deployed contract against config/constants.json. Nothing is sent to the live network:
//   FORK_CHAIN_ID=<chain id> OPS_NETWORK=<network> <NETWORK>_RPC_URL=<rpc> yarn hardhat run scripts/dry-run-aave-v4-collateral-swap.js
// `make dry-run-aave-v4-collateral-swap` takes the same variables as `make deploy-aave-v4-collateral-swap`.

const CREATE3_DEPLOYER_ABI = [
    'function owner() view returns (address)',
    'function transferOwnership(address newOwner)',
];

async function main() {
    if (network.name !== 'hardhat') {
        throw new Error('Run the dry run on the hardhat network');
    }
    const forkNetwork = [undefined, '', 'hardhat'].includes(process.env.OPS_NETWORK) ? 'mainnet' : process.env.OPS_NETWORK;
    const rpcVariable = `${forkNetwork.toUpperCase()}_RPC_URL`;
    if (!process.env[rpcVariable]) {
        throw new Error(`Set ${rpcVariable} to fork ${forkNetwork}`);
    }
    await resetHardhatNetworkFork(network, forkNetwork);

    const chainId = await getChainId();
    const { forkedNetwork } = await network.provider.send('hardhat_metadata');
    if (forkedNetwork.chainId.toString() !== chainId) {
        throw new Error(`${rpcVariable} serves chain ${forkedNetwork.chainId}: set FORK_CHAIN_ID=${forkedNetwork.chainId}`);
    }
    console.log(`Forked ${forkNetwork} (chain ${chainId}) at block ${forkedNetwork.forkBlockNumber}`);
    // Transactions use the 1 wei gas price from the hardhat config. Calls on the fork block itself would need the
    // chain's hardfork history, which Hardhat lacks for chains such as Base, so they run on a local block instead.
    await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
    await network.provider.send('evm_mine');

    // Only the owner of the CREATE3 deployer can deploy through it. Live deployments sign with the owner's key;
    // on the fork, the deployer is handed over to the local signer instead.
    const [signer] = await ethers.getSigners();
    const create3Deployer = await ethers.getContractAt(CREATE3_DEPLOYER_ABI, constants.CREATE3_DEPLOYERS[chainId]);
    const create3Owner = await create3Deployer.owner();
    await network.provider.send('hardhat_impersonateAccount', [create3Owner]);
    await network.provider.send('hardhat_setBalance', [create3Owner, ethers.toQuantity(ethers.parseEther('1'))]);
    await create3Deployer.connect(await ethers.getSigner(create3Owner)).transferOwnership(signer.address);

    await deployAaveV4CollateralSwap(hre);

    const deployment = await deployments.get('AaveV4CollateralSwap');
    const adapter = await ethers.getContractAt('AaveV4CollateralSwap', deployment.address);
    const expected = {
        LIMIT_ORDER_PROTOCOL: constants.ROUTER_V6_ADDRESS[chainId],
        SETTLEMENT: constants.SETTLEMENT_ADDRESS[chainId],
        GIVER_POSITION_MANAGER: constants.AAVE_V4_GIVER_POSITION_MANAGER[chainId],
        TAKER_POSITION_MANAGER: constants.AAVE_V4_TAKER_POSITION_MANAGER[chainId],
        SIGNATURE_GATEWAY: constants.AAVE_V4_SIGNATURE_GATEWAY[chainId],
        owner: constants.AAVE_V4_COLLATERAL_SWAP_OWNER[chainId],
    };
    for (const [getter, value] of Object.entries(expected)) {
        const actual = await adapter[getter]();
        if (actual !== ethers.getAddress(value)) {
            throw new Error(`${getter} is ${actual}, expected ${value}`);
        }
        console.log(`${getter.padEnd(22)} ${actual}`);
    }
    console.log(`AaveV4CollateralSwap at ${deployment.address}, deployment gas ${deployment.receipt.gasUsed}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
