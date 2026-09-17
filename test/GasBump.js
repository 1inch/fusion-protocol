const { time, ether, constants } = require('@1inch/solidity-utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { buildOrder, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails, buildSettlementExtensions } = require('./helpers/fusionUtils');
const hre = require('hardhat');
const { network, ethers } = hre;

describe('GasBump', function () {
    before(async function () {
        if (hre.__SOLIDITY_COVERAGE_RUNNING) { this.skip(); }
    });

    after(async function () {
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
    });

    async function prepare() {
        const { contracts: { dai, weth, accessToken, orderRegistrator }, accounts: { owner } } = await initContractsForSettlement();
        const makingAmount = ether('10');
        const takingAmount = ether('1');
        const GasBumpChecker = await ethers.getContractFactory('GasBumpChecker');
        const checker = await GasBumpChecker.deploy(accessToken, weth, owner, orderRegistrator);
        const currentTime = (await time.latest()) - time.duration.minutes(1) + 1;
        const { details: auctionDetails } = await buildAuctionDetails({
            gasBumpEstimate: 10000, // 0.1% of taking amount
            gasPriceEstimate: 1000, // 1 gwei
            startTime: currentTime,
            initialRateBump: 1000000,
            points: [[500000, 60]],
        });

        const extensions = buildSettlementExtensions({
            feeTaker: await checker.getAddress(),
            estimatedTakingAmount: takingAmount,
            getterExtraPrefix: auctionDetails,
        });

        const order = buildOrder(
            {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount,
                takingAmount,
                makerTraits: buildMakerTraits(),
            },
        );

        return { order, owner, extensions, checker };
    }

    async function testGetTakingAmount(checker, order, extensions, basefee, result) {
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x' + basefee.toString(16)]);
        await checker.testGetTakingAmount.send(
            order, '0x', constants.ZERO_BYTES32, constants.ZERO_ADDRESS, ether('10'), ether('10'), '0x' + extensions.takingAmountData.substring(42), result, { gasPrice: basefee },
        );
    }

    it('0 gwei = no gas fee', async function () {
        const { order, extensions, checker } = await loadFixture(prepare);
        await testGetTakingAmount(checker, order, extensions, 0, ether('1.05'));
    });

    it('0.1 gwei = 0.01% gas fee', async function () {
        const { order, extensions, checker } = await loadFixture(prepare);
        await testGetTakingAmount(checker, order, extensions, 1e8, ether('1.0499'));
    });

    it('15 gwei = 1.5% gas fee', async function () {
        const { order, extensions, checker } = await loadFixture(prepare);
        await testGetTakingAmount(checker, order, extensions, 15e9, ether('1.035'));
    });

    it('100 gwei = 10% gas fee, should be capped with takingAmount', async function () {
        const { order, extensions, checker } = await loadFixture(prepare);
        await testGetTakingAmount(checker, order, extensions, 100e9, ether('1'));
    });
});
