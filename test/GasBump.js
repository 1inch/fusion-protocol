const { expect, deployContract, time, ether, constants } = require('@1inch/solidity-utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { buildOrder, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails } = require('./helpers/fusionUtils');

describe('GasBump', function () {
    async function prepare() {
        const { contracts: { dai, weth }, accounts: { owner } } = await initContractsForSettlement();
        const settlementExtension = await deployContract('Settlement', [owner, weth]);
        const currentTime = (await time.latest()) - time.duration.minutes(1);
        const { details: auctionDetails } = await buildAuctionDetails({
            gasBumpEstimate: 10000, // 0.1% of taking amount
            gasPriceEstimate: 1000, // 1 gwei
            startTime: currentTime,
            initialRateBump: 1000000,
            points: [[500000, 60]],
        });

        const order = buildOrder({
            maker: owner.address,
            makerAsset: await dai.getAddress(),
            takerAsset: await weth.getAddress(),
            makingAmount: ether('10'),
            takingAmount: ether('1'),
            makerTraits: buildMakerTraits(),
        });

        return { order, owner, auctionDetails, settlementExtension };
    }

    function callGetTakingAmount(settlementExtension, order, owner, auctionDetails, gasPrice) {
        return settlementExtension.getTakingAmount(
            order, '0x', constants.ZERO_BYTES32, owner.address, ether('10'), ether('10'), auctionDetails,
            { gasPrice },
        );
    }

    it('0 gwei = no gas fee', async function () {
        const { order, owner, auctionDetails, settlementExtension } = await loadFixture(prepare);
        const takingAmount = await callGetTakingAmount(settlementExtension, order, owner, auctionDetails, 0);
        expect(takingAmount).to.be.equal(ether('1.05'));
    });

    it('0.1 gwei = 0.001% gas fee', async function () {
        const { order, owner, auctionDetails, settlementExtension } = await loadFixture(prepare);
        const takingAmount = await callGetTakingAmount(settlementExtension, order, owner, auctionDetails, 1e8);
        expect(takingAmount).to.be.equal(ether('1.0499'));
    });

    it('15 gwei = 0.15% gas fee', async function () {
        const { order, owner, auctionDetails, settlementExtension } = await loadFixture(prepare);
        const takingAmount = await callGetTakingAmount(settlementExtension, order, owner, auctionDetails, 15e9);
        expect(takingAmount).to.be.equal(ether('1.035'));
    });

    it('100 gwei = 1% gas fee, should be capped with takingAmount', async function () {
        const { order, owner, auctionDetails, settlementExtension } = await loadFixture(prepare);
        const takingAmount = await callGetTakingAmount(settlementExtension, order, owner, auctionDetails, 100e9);
        expect(takingAmount).to.be.equal(ether('1'));
    });
});
