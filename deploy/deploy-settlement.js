const hre = require('hardhat');
const { deployAndGetContractWithCreate3, deployAndGetContract } = require('@1inch/solidity-utils');
const constants = require('../config/constants');
const { getChainId, ethers } = hre;

module.exports = async ({ getNamedAccounts, deployments, config }) => {
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

    let DEPLOYMENT_METHOD = config.deployOpts?.deploymentMethod || 'create3';
    if (networkName.indexOf('zksync') !== -1) { // create3 is not supported for zksync
        DEPLOYMENT_METHOD = 'create';
    }

    const constructorArgs = [
        constants.ROUTER_V6_ADDRESS[chainId],
        constants.ACCESS_TOKEN_ADDRESS[chainId],
        constants.WETH[chainId],
        constants.SETTLEMENT_OWNER_ADDRESS[chainId],
    ];

    const deploymentName = 'SimpleSettlement';
    const contractName = 'SimpleSettlement';

    if (DEPLOYMENT_METHOD === 'create3') {
        let salt = constants.SETTLEMENT_SALT[chainId];
        salt = salt?.startsWith('0x') ? salt : ethers.keccak256(ethers.toUtf8Bytes(salt));

        console.log(`Using salt: ${salt}`);

        // Deploy with create3
        await deployAndGetContractWithCreate3({
            contractName,
            deploymentName,
            constructorArgs,
            create3Deployer: constants.CREATE3_DEPLOYERS[chainId],
            salt,
            deployments,
            skipVerify: process.env.OPS_SKIP_VERIFY === 'true',
        });
    } else {
        // Deploy on zkSync-like networks without create3
        const { deployer } = await getNamedAccounts();
        await deployAndGetContract({
            contractName,
            deploymentName,
            constructorArgs,
            deployments,
            deployer,
            skipVerify: process.env.OPS_SKIP_VERIFY === 'true',
        });
    }
};

module.exports.skip = async () => true;
