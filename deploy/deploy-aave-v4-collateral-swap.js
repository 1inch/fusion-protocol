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

    // Constructor arguments in order, keyed by their config/constants.json entry. They are immutable once deployed.
    const params = {
        routerV6Address: constants.ROUTER_V6_ADDRESS[chainId],
        settlementAddress: constants.SETTLEMENT_ADDRESS[chainId],
        aaveV4GiverPositionManager: constants.AAVE_V4_GIVER_POSITION_MANAGER[chainId],
        aaveV4TakerPositionManager: constants.AAVE_V4_TAKER_POSITION_MANAGER[chainId],
        aaveV4SignatureGateway: constants.AAVE_V4_SIGNATURE_GATEWAY[chainId],
        aaveV4CollateralSwapOwner: constants.AAVE_V4_COLLATERAL_SWAP_OWNER[chainId],
    };
    for (const [key, address] of Object.entries(params)) {
        if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
            throw new Error(`${key} is not set for chain ${chainId} in config/constants.json`);
        }
        if (key !== 'aaveV4CollateralSwapOwner' && await ethers.provider.getCode(address) === '0x') {
            throw new Error(`${key} ${address} has no code on chain ${chainId}`);
        }
    }
    const constructorArgs = Object.values(params);

    const deploymentName = 'AaveV4CollateralSwap';
    const contractName = 'AaveV4CollateralSwap';

    if (DEPLOYMENT_METHOD === 'create3') {
        let salt = constants.AAVE_V4_COLLATERAL_SWAP_SALT[chainId];
        if (!salt) {
            throw new Error(`aaveV4CollateralSwapSalt is not set for chain ${chainId} in config/constants.json`);
        }
        salt = salt.startsWith('0x') ? salt : ethers.keccak256(ethers.toUtf8Bytes(salt));

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
