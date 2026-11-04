const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { constants, time, expect, ether, deployContract } = require('@1inch/solidity-utils');
const { buildMakerTraits, buildTakerTraits, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails } = require('./helpers/fusionUtils');
const { buildTwapOrder, buildTwapSchedule } = require('./helpers/twapUtils');

const PARTS = 4;
const INTERVAL = 600;
const AUCTION_DURATION = 300;
const MAKING_AMOUNT = ether('100');
const TAKING_AMOUNT = ether('0.1');
const PART_MAKING_AMOUNT = MAKING_AMOUNT / BigInt(PARTS);
const PART_TAKING_AMOUNT = TAKING_AMOUNT / BigInt(PARTS);

// Each part's auction starts 10% above the order's limit price and decays linearly to it over AUCTION_DURATION.
const takingAmountAt = (parts, ratePercent) => PART_TAKING_AMOUNT * BigInt(parts) * BigInt(ratePercent) / 100n;

describe('FusionTwap', function () {
    async function initContracts() {
        const data = await initContractsForSettlement();
        const { contracts: { weth, resolver } } = data;
        const twap = await deployContract('FusionTwap');
        await weth.transfer(resolver, ether('0.5'));
        return { ...data, contracts: { ...data.contracts, twap } };
    }

    async function prepareTwap({ data, maker, maxPartsPerFill = 0, ...orderOptions } = {}) {
        data = data || await loadFixture(initContracts);
        const { contracts: { dai, weth, lopv4, settlement, resolver, twap }, accounts: { alice }, others: { chainId } } = data;

        const startTime = await time.latest() + 100;
        const schedule = { startTime, interval: INTERVAL, parts: PARTS, maxPartsPerFill };
        const { details: auctionDetails } = await buildAuctionDetails({ startTime, duration: AUCTION_DURATION, initialRateBump: 1000000 });
        const order = buildTwapOrder({
            twap: await twap.getAddress(),
            settlement: await settlement.getAddress(),
            orderData: {
                maker: maker ? await maker.getAddress() : alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            },
            schedule,
            auctionDetails,
            ...orderOptions,
        });
        const signature = await signOrder(order, chainId, await lopv4.getAddress(), alice);

        async function fillBy(isMakingAmount, amount, threshold, timestamp) {
            const takerTraits = buildTakerTraits({
                makingAmount: isMakingAmount,
                threshold,
                extension: order.extension,
                interaction: await resolver.getAddress() + '01',
                target: await resolver.getAddress(),
            });
            const { r, yParityAndS: vs } = ethers.Signature.from(signature);
            const calldata = maker
                ? lopv4.interface.encodeFunctionData('fillContractOrderArgs', [order, signature, amount, takerTraits.traits, takerTraits.args])
                : lopv4.interface.encodeFunctionData('fillOrderArgs', [order, r, vs, amount, takerTraits.traits, takerTraits.args]);
            await time.setNextBlockTimestamp(timestamp);
            return resolver.settleOrders(calldata);
        }

        const fill = (makingAmount, maxTakingAmount, timestamp) => fillBy(true, makingAmount, maxTakingAmount, timestamp);
        const fillByTakingAmount = (takingAmount, minMakingAmount, timestamp) => fillBy(false, takingAmount, minMakingAmount, timestamp);

        return { ...data, order, schedule, fill, fillByTakingAmount };
    }

    it('cannot be filled before the first part starts', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap();
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime - 1)).to.be.revertedWithCustomError(twap, 'TwapNotStarted');
    });

    it('sells the first part at the top of a fresh auction', async function () {
        const { contracts: { dai, weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const takingAmount = takingAmountAt(1, 110);

        const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
    });

    it('rejects a fill beyond the parts unlocked so far', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap();

        await expect(fill(PART_MAKING_AMOUNT * 2n, ether('1'), schedule.startTime))
            .to.be.revertedWithCustomError(twap, 'TwapAmountNotUnlocked').withArgs(PART_MAKING_AMOUNT * 2n, PART_MAKING_AMOUNT);

        await fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime + 1);
        await expect(fill(1n, ether('1'), schedule.startTime + INTERVAL - 1))
            .to.be.revertedWithCustomError(twap, 'TwapAmountNotUnlocked').withArgs(PART_MAKING_AMOUNT + 1n, PART_MAKING_AMOUNT);
    });

    it('restarts the auction for every part', async function () {
        const { contracts: { dai, weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const fills = [
            { part: 0, elapsed: AUCTION_DURATION / 2, ratePercent: 105 },
            { part: 1, elapsed: AUCTION_DURATION / 2, ratePercent: 105 },
            { part: 2, elapsed: AUCTION_DURATION, ratePercent: 100 },
            { part: 3, elapsed: 0, ratePercent: 110 },
        ];

        for (const { part, elapsed, ratePercent } of fills) {
            const takingAmount = takingAmountAt(1, ratePercent);
            const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime + part * INTERVAL + elapsed);
            await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
            await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
        }
    });

    it('prices fills by taking amount on the same auction', async function () {
        const { contracts: { dai, weth, resolver }, accounts: { alice }, schedule, fillByTakingAmount } = await prepareTwap();
        const takingAmount = takingAmountAt(1, 105);

        const tx = await fillByTakingAmount(takingAmount, PART_MAKING_AMOUNT, schedule.startTime + INTERVAL + AUCTION_DURATION / 2);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
    });

    it('sells parts missed in earlier intervals on a later auction', async function () {
        const { contracts: { dai, weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const makingAmount = PART_MAKING_AMOUNT * 3n;
        const takingAmount = takingAmountAt(3, 110);

        const tx = await fill(makingAmount, takingAmount, schedule.startTime + 2 * INTERVAL);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-makingAmount, makingAmount]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
    });

    it('limits how many parts a single fill may take', async function () {
        const { contracts: { dai, twap }, accounts: { alice }, schedule, fill } = await prepareTwap({ maxPartsPerFill: 1 });
        const partStart = schedule.startTime + 2 * INTERVAL;

        await expect(fill(PART_MAKING_AMOUNT * 2n, ether('1'), partStart))
            .to.be.revertedWithCustomError(twap, 'TwapFillTooLarge').withArgs(PART_MAKING_AMOUNT * 2n, PART_MAKING_AMOUNT);

        for (let i = 1; i <= 3; i++) {
            const tx = await fill(PART_MAKING_AMOUNT, ether('1'), partStart + i);
            await expect(tx).to.changeTokenBalance(dai, alice, -PART_MAKING_AMOUNT);
        }
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), partStart + 4))
            .to.be.revertedWithCustomError(twap, 'TwapAmountNotUnlocked').withArgs(MAKING_AMOUNT, PART_MAKING_AMOUNT * 3n);
    });

    it('sells what is left at the limit price after the last auction, until the order expires', async function () {
        const { contracts: { dai, weth, lopv4, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const end = schedule.startTime + PARTS * INTERVAL;
        const makingAmount = MAKING_AMOUNT / 2n;
        const takingAmount = TAKING_AMOUNT / 2n;

        const tx = await fill(makingAmount, takingAmount, end - 1);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-makingAmount, makingAmount]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);

        await expect(fill(PART_MAKING_AMOUNT, ether('1'), end + 1)).to.be.revertedWithCustomError(lopv4, 'OrderExpired');
    });

    it('charges the settlement fees on every part', async function () {
        const [,, bob, charlie] = await ethers.getSigners();
        const { contracts: { weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap({
            integratorFee: 115,
            resolverFee: 100,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });
        const makerAmount = takingAmountAt(1, 110);
        const takingAmount = makerAmount * 100215n / 100000n;
        const integratorFeeAmount = makerAmount * 115n / 100000n / 2n;
        const protocolFeeAmount = makerAmount * 100n / 100000n + integratorFeeAmount;

        const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime);
        await expect(tx).to.changeTokenBalances(
            weth,
            [resolver, alice, bob, charlie],
            [-takingAmount, makerAmount, integratorFeeAmount, protocolFeeAmount],
        );
    });

    it('keeps the settlement access rules', async function () {
        const { contracts: { accessToken, resolver, settlement }, schedule, fill } = await prepareTwap();
        await accessToken.burn(resolver, 1);

        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(settlement, 'OnlyWhitelistOrAccessToken');
    });

    it('lets a whitelisted resolver fill without the access token', async function () {
        const data = await loadFixture(initContracts);
        const { contracts: { accessToken, dai, resolver }, accounts: { alice } } = data;
        await accessToken.burn(resolver, 1);
        const { schedule, fill } = await prepareTwap({ data, whitelistResolvers: ['0x' + resolver.target.substring(22)] });

        const tx = await fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
    });

    it('refuses to price an order whose pre-interaction does not enforce the schedule', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ scheduleTarget: null });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapScheduleNotFound');
    });

    it('refuses to price an order that cannot be filled more than once', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ makerTraits: buildMakerTraits({ allowMultipleFills: false }) });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapRequiresMultipleFills');
    });

    it('refuses to price an order whose schedule is enforced by another contract', async function () {
        const data = await loadFixture(initContracts);
        const otherTwap = await deployContract('FusionTwap');
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ data, scheduleTarget: await otherTwap.getAddress() });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapScheduleNotFound');
    });

    it('refuses to price an order without the settlement auction behind it', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ auctionDetails: '0x' });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapInvalidAuctionDetails');
    });

    describe('schedule validation', function () {
        const schedules = {
            'is too short': '0x000000010000010004',
            'has a zero interval': buildTwapSchedule({ startTime: 1, interval: 0, parts: 4 }),
            'has no parts': buildTwapSchedule({ startTime: 1, interval: 600, parts: 0 }),
            'ends after 2106': buildTwapSchedule({ startTime: 2n ** 32n - 1000n, interval: 600, parts: 4 }),
        };

        for (const [name, schedule] of Object.entries(schedules)) {
            it(`rejects a schedule that ${name}`, async function () {
                const { contracts: { twap }, order } = await prepareTwap();
                await expect(twap.preInteraction(order, '0x', constants.ZERO_BYTES32, constants.ZERO_ADDRESS, 1, 1, MAKING_AMOUNT, schedule))
                    .to.be.revertedWithCustomError(twap, 'TwapInvalidSchedule');
            });
        }
    });

    it('lets the maker cancel the rest of the TWAP', async function () {
        const { contracts: { lopv4 }, accounts: { alice }, order, schedule, fill } = await prepareTwap();
        await fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime);

        await lopv4.connect(alice).cancelOrder(order.makerTraits, await lopv4.hashOrder(order));
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime + INTERVAL)).to.be.revertedWithCustomError(lopv4, 'InvalidatedOrder');
    });

    it('runs a whole TWAP from a contract maker that signed once', async function () {
        const data = await loadFixture(initContracts);
        const { contracts: { dai, weth, lopv4, resolver }, accounts: { alice } } = data;
        const maker = await deployContract('ContractMakerMock', [alice.address]);
        await dai.connect(alice).transfer(maker, MAKING_AMOUNT);
        await maker.connect(alice).approve(dai, lopv4);
        const { schedule, fill } = await prepareTwap({ data, maker });

        for (let part = 0; part < PARTS; part++) {
            const takingAmount = takingAmountAt(1, 110);
            const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime + part * INTERVAL);
            await expect(tx).to.changeTokenBalances(dai, [maker, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
            await expect(tx).to.changeTokenBalances(weth, [maker, resolver], [takingAmount, -takingAmount]);
        }
    });
});
