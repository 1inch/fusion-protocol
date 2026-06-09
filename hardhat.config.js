require('@matterlabs/hardhat-zksync-deploy');
require('@matterlabs/hardhat-zksync-solc');
require('@nomicfoundation/hardhat-chai-matchers');
require('solidity-coverage');
require('solidity-docgen');
require('hardhat-dependency-compiler');
require('hardhat-deploy');
require('hardhat-gas-reporter');
require('hardhat-tracer');
require('dotenv').config();

const { oneInchTemplates } = require('@1inch/solidity-utils/docgen');
const { Networks, getNetwork } = require('@1inch/solidity-utils/hardhat-setup');

if (getNetwork().indexOf('zksync') !== -1) {
    require('@matterlabs/hardhat-zksync-verify');
} else {
    require('@nomicfoundation/hardhat-verify');
}

const n = new Networks();
const { networks } = n.registerAll();
const etherscan = n.getEtherscanConfig(getNetwork());

networks.hardhat = Object.assign(networks.hardhat, {
    initialBaseFeePerGas: 1,
    gasPrice: 1,
});

const DEFAULT_COMPILER_SETTINGS = {
    version: '0.8.23',
    settings: {
        optimizer: {
            enabled: true,
            runs: 1000000,
        },
        evmVersion: networks[getNetwork()]?.hardfork || 'shanghai',
        viaIR: true,
    },
};

const LOW_OPTIMIZER_COMPILER_SETTINGS = JSON.parse(JSON.stringify(DEFAULT_COMPILER_SETTINGS));
LOW_OPTIMIZER_COMPILER_SETTINGS.settings.optimizer.runs = 200;

module.exports = {
    etherscan,
    tracer: {
        enableAllOpcodes: true,
    },
    solidity: {
        compilers: [DEFAULT_COMPILER_SETTINGS],
        overrides: {
            '@1inch/limit-order-protocol-contract/contracts/LimitOrderProtocol.sol': LOW_OPTIMIZER_COMPILER_SETTINGS,
            'contracts/hardhat-dependency-compiler/@1inch/limit-order-protocol-contract/contracts/LimitOrderProtocol.sol': LOW_OPTIMIZER_COMPILER_SETTINGS,
        },
    },
    networks,
    namedAccounts: {
        deployer: {
            default: 0,
        },
    },
    gasReporter: {
        enable: true,
    },
    dependencyCompiler: {
        paths: [
            '@1inch/solidity-utils/contracts/mocks/TokenMock.sol',
            '@1inch/solidity-utils/contracts/mocks/ERC20PermitMock.sol',
            '@1inch/st1inch/contracts/St1inch.sol',
            '@1inch/limit-order-protocol-contract/contracts/LimitOrderProtocol.sol',
            '@1inch/limit-order-protocol-contract/contracts/mocks/WrappedTokenMock.sol',
        ],
    },
    zksolc: {
        version: '1.4.1',
        compilerSource: 'binary',
        settings: {},
    },
    docgen: {
        outputDir: 'docs',
        templates: oneInchTemplates(),
        pages: 'files',
        exclude: ['mocks'],
    },
    deployOpts: {
        kycTokenSuffix: process.env.OPS_KYC_TOKEN_SUFFIX,
        deploymentMethod: process.env.OPS_DEPLOYMENT_METHOD,
    },
};
