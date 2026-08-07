const hre = require('hardhat');
const { deployAndGetContract } = require('@1inch/solidity-utils');
const constants = require('../config/constants');
const { getChainId } = hre;

module.exports = async ({ getNamedAccounts, deployments }) => {
    const networkName = hre.network.name;
    console.log(`running ${networkName} deploy script`);
    const chainId = await getChainId();
    console.log('network id ', chainId);

    if (
        networkName in hre.config.networks &&
        chainId !== hre.config.networks[networkName].chainId?.toString()
    ) {
        console.log(`network chain id: ${hre.config.networks[networkName].chainId}, your chain id ${chainId}`);
        console.log('skipping wrong chain id deployment');
        return;
    }

    // The OrderRegistrator with the announcedAt view (limit-order-protocol#435) is not deployed yet;
    // fill config/constants.json once it is.
    const orderRegistrator = constants.ORDER_REGISTRATOR_ADDRESS[chainId];
    if (!orderRegistrator) {
        throw new Error(`orderRegistratorAddress is not set for chain ${chainId} in config/constants.json`);
    }

    const { deployer } = await getNamedAccounts();

    await deployAndGetContract({
        contractName: 'FusionAnchoredAuction',
        constructorArgs: [orderRegistrator],
        deployments,
        deployer,
        skipVerify: process.env.OPS_SKIP_VERIFY === 'true',
    });
};

module.exports.skip = async () => true;
