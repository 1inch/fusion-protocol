const hre = require('hardhat');
const { deployAndGetContractWithCreate3, deployAndGetContract } = require('@1inch/solidity-utils');
const constants = require('./constants');

const AT_NAME = 'Resolver Access Token';
const AT_SYMBOL = 'RES';
const AT_VERSION = '1';

module.exports = async ({ getNamedAccounts, deployments }) => {
    const networkName = hre.network.name;
    console.log(`running ${networkName} deploy script: kyc-nft`);
    const chainId = await hre.getChainId();
    console.log('network id ', chainId);
    
    if (chainId !== hre.config.networks[networkName].chainId.toString()) {
        console.log(`network chain id: ${hre.config.networks[networkName].chainId}, your chain id ${chainId}`);
        console.log('skipping wrong chain id deployment');
        return;
    }

    const constructorArgs = [
        AT_NAME,
        AT_SYMBOL,
        AT_VERSION,
        constants.ACCESS_TOKEN_OWNER[chainId],
    ];

    if (networkName.indexOf('zksync') !== -1) {
        // Deploy on zkSync-like networks without create3
        const { deployer } = await getNamedAccounts();
        await deployAndGetContract({
            contractName: 'KycNFT',
            constructorArgs,
            deployments,
            deployer,
        });
    } else {
        // Deploy with create3
        await deployAndGetContractWithCreate3({
            contractName: 'KycNFT',
            constructorArgs,
            create3Deployer: constants.CREATE3_DEPLOYERS[chainId],
            salt: constants.ACCESS_TOKEN_SALT[chainId],
            deployments,
            skipVerify: networkName === 'klaytn',
        });
    }
};

module.exports.skip = async () => true;
