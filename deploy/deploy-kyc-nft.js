const { getChainId, network } = require('hardhat');
const { deployAndGetContractWithCreate3, deployAndGetContract } = require('@1inch/solidity-utils');

const constructorArgs = [
    'Resolver Access Token', // name
    'RES', // symbol
    '1', // version
    '0x56E44874F624EbDE6efCc783eFD685f0FBDC6dcF', // owner
];
const create3Deployer = '0xD935a2bb926019E0ed6fb31fbD5b1Bbb7c05bf65';
const salt = '0xfd0450e10366502b67f46a6037db5b90d1cad2d4a744b961f7986bf35f4d35d7';

module.exports = async ({ getNamedAccounts, deployments }) => {
    console.log('running deploy script: kyc-nft');
    console.log('network id ', await getChainId());

    if (network.name.indexOf('zksync') !== -1) {
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
            create3Deployer,
            salt,
            deployments,
            skipVerify: network.name === 'klaytn',
        });
    }
};

module.exports.skip = async () => true;
