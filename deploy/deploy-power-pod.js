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

    const { deployer } = await getNamedAccounts();

    await deployAndGetContract({
        contractName: 'PowerPod',
        constructorArgs: ['Delegated st1INCH', 'dst1INCH', constants.ST1INCH_ADDR[chainId]],
        deployments,
        deployer,
        skipVerify: process.env.OPS_SKIP_VERIFY === 'true',
    });
};

module.exports.skip = async () => true;
