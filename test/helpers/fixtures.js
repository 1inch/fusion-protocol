const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');
const { ether, deployContract } = require('@1inch/solidity-utils');

async function getChainId() {
    return (await ethers.provider.getNetwork()).chainId;
}

async function deploySwapTokens() {
    const [account] = await ethers.getSigners();
    const dai = await deployContract('ERC20PermitMock', ['DAI', 'DAI', account, ether('1000')]);
    const weth = await deployContract('WrappedTokenMock', ['WETH', 'WETH']);
    const accessToken = await deployContract('TokenMock', ['NFT', 'NFT']);
    const lopv4 = await deployContract('LimitOrderProtocol', [weth]);

    const LimitOrderProtocolV3 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../artifacts-v1/LimitOrderProtocolV3.json'), 'utf8'));
    const ContractFactory = await ethers.getContractFactory(LimitOrderProtocolV3.abi, LimitOrderProtocolV3.bytecode);
    const lopv3 = await ContractFactory.deploy(weth);

    return { dai, weth, accessToken, lopv3, lopv4 };
}

async function initContractsForSettlement() {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const chainId = await getChainId();
    const [owner, alice, bob, charlie] = await ethers.getSigners();

    const { dai, weth, accessToken, lopv4 } = await deploySwapTokens();

    await dai.transfer(alice, ether('101'));
    await weth.deposit({ value: ether('1') });
    await weth.connect(alice).deposit({ value: ether('1') });

    const orderRegistrator = await deployContract('OrderRegistrator', [lopv4]);
    const settlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, owner, orderRegistrator]);

    const ResolverMock = await ethers.getContractFactory('ResolverMock');
    const resolver = await ResolverMock.deploy(settlement, lopv4);

    await dai.approve(lopv4, ether('101'));
    await dai.connect(alice).approve(lopv4, ether('101'));
    await weth.approve(lopv4, ether('1'));
    await weth.connect(alice).approve(lopv4, ether('1'));

    await resolver.approve(dai, lopv4);
    await resolver.approve(weth, lopv4);

    await accessToken.mint(resolver, 1);
    await accessToken.mint(owner, 1);

    return {
        contracts: { dai, weth, accessToken, lopv4, settlement, resolver, orderRegistrator },
        accounts: { owner, alice, bob, charlie },
        others: { chainId, abiCoder },
    };
}

module.exports = {
    initContractsForSettlement,
    deploySwapTokens,
    getChainId,
};
