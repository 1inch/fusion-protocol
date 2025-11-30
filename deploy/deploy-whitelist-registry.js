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

    const whitelist = await deployAndGetContract({
        contractName: 'WhitelistRegistry',
        constructorArgs: [constants.POWER_POD_ADDRESS[chainId], '1000'], // 1000 = 10% threshold
        deployments,
        deployer,
    });

    const tx = await whitelist.transferOwnership(constants.DAO_ADDRESS[chainId]);
    await tx.wait();
    console.log(`Ownership has been successfully transferred to ${constants.DAO_ADDRESS[chainId]}`);
};

module.exports.skip = async () => true;
