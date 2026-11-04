const hre = require('hardhat');
const { ethers, network } = hre;
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { constants, time, expect, ether, trim0x, deployContract } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits, buildTakerTraits, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails, buildSettlementExtensions } = require('./helpers/fusionUtils');
const { buildTwapOrder, buildTwapSchedule } = require('./helpers/twapUtils');

const PARTS = 4;
const INTERVAL = 600;
const AUCTION_DURATION = 300;
const INITIAL_RATE_BUMP = 1000000n;
const RATE_BUMP_BASE = 10000000n;
const MAKING_AMOUNT = ether('100');
const TAKING_AMOUNT = ether('0.1');
const PART_MAKING_AMOUNT = MAKING_AMOUNT / BigInt(PARTS);
const PART_TAKING_AMOUNT = TAKING_AMOUNT / BigInt(PARTS);

// Each part's auction starts 10% above the order's limit price and decays linearly to it over AUCTION_DURATION.
const takingAmountAt = (parts, ratePercent) => PART_TAKING_AMOUNT * BigInt(parts) * BigInt(ratePercent) / 100n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

function expectedTakingAmount(makingAmount, elapsed, { duration, initialRateBump }) {
    let rateBump = 0n;
    if (elapsed <= 0) {
        rateBump = BigInt(initialRateBump);
    } else if (elapsed < duration) {
        rateBump = BigInt(duration - elapsed) * BigInt(initialRateBump) / BigInt(duration);
    }
    return ceilDiv(ceilDiv(TAKING_AMOUNT * makingAmount, MAKING_AMOUNT) * (RATE_BUMP_BASE + rateBump), RATE_BUMP_BASE);
}

describe('FusionTwap', function () {
    async function initContracts() {
        const data = await initContractsForSettlement();
        const { contracts: { lopv4, weth, resolver } } = data;
        const registrator = await deployContract('OrderRegistratorMock', [lopv4]);
        const twap = await deployContract('FusionTwap', [registrator]);
        await weth.transfer(resolver, ether('0.5'));
        return { ...data, contracts: { ...data.contracts, registrator, twap } };
    }

    function fillerFor({ contracts: { lopv4, resolver } }, order, signature, maker) {
        async function fillBy(isMakingAmount, amount, threshold, timestamp, overrides = {}) {
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
            return resolver.settleOrders(calldata, overrides);
        }

        return {
            fill: (makingAmount, maxTakingAmount, timestamp, overrides) => fillBy(true, makingAmount, maxTakingAmount, timestamp, overrides),
            fillByTakingAmount: (takingAmount, minMakingAmount, timestamp) => fillBy(false, takingAmount, minMakingAmount, timestamp),
        };
    }

    async function prepareTwap({
        data,
        maker,
        twap,
        settlement,
        anchored = false,
        parts = PARTS,
        interval = INTERVAL,
        auction = {},
        ...orderOptions
    } = {}) {
        data = data || await loadFixture(initContracts);
        const { contracts, accounts: { alice }, others: { chainId } } = data;

        const startTime = await time.latest() + 100;
        const schedule = { startTime, interval, parts, anchored };
        const auctionParams = { duration: AUCTION_DURATION, initialRateBump: INITIAL_RATE_BUMP, ...auction };
        const { details: auctionDetails } = await buildAuctionDetails({ startTime, ...auctionParams });
        const order = buildTwapOrder({
            twap: await (twap || contracts.twap).getAddress(),
            settlement: await (settlement || contracts.settlement).getAddress(),
            orderData: {
                maker: maker ? await maker.getAddress() : alice.address,
                makerAsset: await contracts.dai.getAddress(),
                takerAsset: await contracts.weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            },
            schedule,
            auctionDetails,
            ...orderOptions,
        });
        const signature = await signOrder(order, chainId, await contracts.lopv4.getAddress(), alice);

        return { ...data, order, schedule, auction: auctionParams, ...fillerFor(data, order, signature, maker) };
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

    it('sells parts missed in earlier intervals on the current auction', async function () {
        const { contracts: { dai, weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const makingAmount = PART_MAKING_AMOUNT * 3n;
        const takingAmount = takingAmountAt(3, 110);

        const tx = await fill(makingAmount, takingAmount, schedule.startTime + 2 * INTERVAL);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-makingAmount, makingAmount]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
    });

    it('sells the last part until the last interval ends, and nothing after', async function () {
        const { contracts: { dai, weth, resolver, twap }, accounts: { alice }, schedule, fill } = await prepareTwap();
        const end = schedule.startTime + PARTS * INTERVAL;
        const makingAmount = MAKING_AMOUNT / 2n;
        const takingAmount = TAKING_AMOUNT / 2n;

        const tx = await fill(makingAmount, takingAmount, end - 1);
        await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-makingAmount, makingAmount]);
        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);

        await expect(fill(PART_MAKING_AMOUNT, ether('1'), end)).to.be.revertedWithCustomError(twap, 'TwapEnded');
    });

    it('ends with its schedule even when the order never expires', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ makerTraits: buildMakerTraits() });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime + PARTS * INTERVAL + 3600))
            .to.be.revertedWithCustomError(twap, 'TwapEnded');
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

    it('refuses to price an order whose schedule is enforced by another contract', async function () {
        const data = await loadFixture(initContracts);
        const otherTwap = await deployContract('FusionTwap', [constants.ZERO_ADDRESS]);
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ data, scheduleTarget: await otherTwap.getAddress() });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapScheduleNotFound');
    });

    it('refuses a fill priced by an amount getter that bypasses it', async function () {
        const data = await loadFixture(initContracts);
        const { contracts: { dai, weth, lopv4, settlement, twap }, accounts: { alice }, others: { chainId } } = data;
        const startTime = await time.latest() + 100;
        const { details: auctionDetails } = await buildAuctionDetails({ startTime, duration: AUCTION_DURATION, initialRateBump: INITIAL_RATE_BUMP });
        const extensions = buildSettlementExtensions({
            feeTaker: await settlement.getAddress(),
            estimatedTakingAmount: TAKING_AMOUNT,
            getterExtraPrefix: auctionDetails,
            whitelistDiscount: 0,
            whitelistPostInteraction: ethers.solidityPacked(['uint32', 'uint8'], [startTime, 0]),
        });
        const order = buildOrder(
            {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
                makerTraits: buildMakerTraits(),
            },
            {
                makingAmountData: await twap.getAddress() + trim0x(extensions.makingAmountData),
                takingAmountData: extensions.takingAmountData,
                preInteraction: await twap.getAddress() + trim0x(buildTwapSchedule({ startTime, interval: INTERVAL, parts: PARTS })),
                postInteraction: extensions.postInteraction,
            },
        );
        const { fill } = fillerFor(data, order, await signOrder(order, chainId, await lopv4.getAddress(), alice));

        await expect(fill(PART_MAKING_AMOUNT, ether('1'), startTime)).to.be.revertedWithCustomError(twap, 'TwapScheduleNotFound');
    });

    it('refuses to price an order that cannot be filled more than once', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ makerTraits: buildMakerTraits({ allowMultipleFills: false }) });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapRequiresMultipleFills');
    });

    it('refuses to price an order without the settlement auction behind it', async function () {
        const { contracts: { twap }, schedule, fill } = await prepareTwap({ auctionDetails: '0x' });
        await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapInvalidAuctionDetails');
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

    describe('schedule anchored to the announcement', function () {
        it('cannot be filled before the order is announced', async function () {
            const { contracts: { twap }, schedule, fill } = await prepareTwap({ anchored: true });
            await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapNotAnnounced');
        });

        it('starts a late order at its announcement, with one part unlocked on a fresh auction', async function () {
            const { contracts: { dai, weth, resolver, registrator, twap }, accounts: { alice }, auction, order, schedule, fill } = await prepareTwap({ anchored: true });
            const announcedAt = schedule.startTime + PARTS * INTERVAL + 300;
            await time.setNextBlockTimestamp(announcedAt);
            await registrator.registerOrder(order);

            const takingAmount = expectedTakingAmount(PART_MAKING_AMOUNT, 1, auction);
            const tx = await fill(PART_MAKING_AMOUNT, takingAmount, announcedAt + 1);
            await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
            await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);

            await expect(fill(PART_MAKING_AMOUNT, ether('1'), announcedAt + 2))
                .to.be.revertedWithCustomError(twap, 'TwapAmountNotUnlocked').withArgs(PART_MAKING_AMOUNT * 2n, PART_MAKING_AMOUNT);
            await fill(PART_MAKING_AMOUNT * 2n, ether('1'), announcedAt + PARTS * INTERVAL - 1);
            await expect(fill(1n, ether('1'), announcedAt + PARTS * INTERVAL)).to.be.revertedWithCustomError(twap, 'TwapEnded');
        });

        it('keeps a later signed start when the order is announced early', async function () {
            const { contracts: { weth, resolver, registrator, twap }, accounts: { alice }, order, schedule, fill } = await prepareTwap({ anchored: true });
            await registrator.registerOrder(order);

            await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime - 1)).to.be.revertedWithCustomError(twap, 'TwapNotStarted');
            const takingAmount = takingAmountAt(1, 110);
            const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime);
            await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
        });

        it('cannot be anchored where no registrator is configured', async function () {
            const data = await loadFixture(initContracts);
            const twap = await deployContract('FusionTwap', [constants.ZERO_ADDRESS]);
            const { schedule, fill } = await prepareTwap({ data, twap, anchored: true });
            await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime)).to.be.revertedWithCustomError(twap, 'TwapNotAnnounced');
        });
    });

    describe('schedule validation', function () {
        const schedules = {
            'is too short': '0x0000000100000100',
            'starts at zero': buildTwapSchedule({ startTime: 0, interval: INTERVAL, parts: PARTS }),
            'has a zero interval': buildTwapSchedule({ startTime: 1, interval: 0, parts: PARTS }),
            'has no parts': buildTwapSchedule({ startTime: 1, interval: INTERVAL, parts: 0 }),
            'ends after 2106': buildTwapSchedule({ startTime: 2n ** 31n - 1n, interval: 2n ** 24n - 1n, parts: 200 }),
        };

        for (const [name, schedule] of Object.entries(schedules)) {
            it(`rejects a schedule that ${name}`, async function () {
                const { contracts: { twap }, order } = await prepareTwap();
                await expect(twap.preInteraction(order, order.extension, constants.ZERO_BYTES32, constants.ZERO_ADDRESS, 1, 1, MAKING_AMOUNT, schedule))
                    .to.be.revertedWithCustomError(twap, 'TwapInvalidSchedule');
            });
        }
    });

    describe('parity with the settlement', function () {
        before(function () {
            if (hre.__SOLIDITY_COVERAGE_RUNNING) { this.skip(); }
        });

        after(async function () {
            await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
        });

        it('applies the settlement gas bump on a part auction', async function () {
            const { contracts: { weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap({
                auction: { gasBumpEstimate: 10000, gasPriceEstimate: 1000 },
            });
            const baseFee = 15000000000n;
            const takingAmount = PART_TAKING_AMOUNT * 10850000n / RATE_BUMP_BASE;

            await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x' + baseFee.toString(16)]);
            const tx = await fill(PART_MAKING_AMOUNT, takingAmount, schedule.startTime + INTERVAL, { maxFeePerGas: baseFee * 2n, maxPriorityFeePerGas: 0n });
            await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
        });

        it('keeps the mainnet priority fee cap', async function () {
            const data = await loadFixture(initContracts);
            const { contracts: { lopv4, accessToken, weth, dai, resolver }, accounts: { owner, alice } } = data;
            const mainnetSettlement = await deployContract('Settlement', [lopv4, accessToken, weth, owner]);
            const { schedule, fill } = await prepareTwap({ data, settlement: mainnetSettlement });
            const baseFee = '0x1dcd65000';

            await network.provider.send('hardhat_setNextBlockBaseFeePerGas', [baseFee]);
            await expect(fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime, { maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 6000000000n }))
                .to.be.revertedWithCustomError(mainnetSettlement, 'InvalidPriorityFee');

            await network.provider.send('hardhat_setNextBlockBaseFeePerGas', [baseFee]);
            const tx = await fill(PART_MAKING_AMOUNT, ether('1'), schedule.startTime + 1, { maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 4000000000n });
            await expect(tx).to.changeTokenBalances(dai, [alice, resolver], [-PART_MAKING_AMOUNT, PART_MAKING_AMOUNT]);
        });
    });

    describe('random fill sequences', function () {
        function mulberry32(seed) {
            return function () {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        const randomAmount = (random, max) => BigInt(Math.floor(random() * 1e6)) * max / 1000000n;

        for (const seed of [1, 2, 3]) {
            it(`never fills beyond the schedule and always prices on the current part's auction (seed ${seed})`, async function () {
                const random = mulberry32(seed);
                const parts = 2 + Math.floor(random() * 7);
                const interval = 60 + Math.floor(random() * 840);
                const auction = { duration: 1 + Math.floor(random() * interval), initialRateBump: BigInt(Math.floor(random() * 2000000)) };
                const { contracts: { twap, weth, resolver }, accounts: { alice }, schedule, fill } = await prepareTwap({ parts, interval, auction });
                const end = schedule.startTime + parts * interval;

                let filled = 0n;
                for (let now = schedule.startTime; now < end && filled < MAKING_AMOUNT; now += 1 + Math.floor(random() * interval * 0.6)) {
                    const part = Math.floor((now - schedule.startTime) / interval);
                    const unlocked = MAKING_AMOUNT * BigInt(part + 1) / BigInt(parts);
                    const available = unlocked - filled;

                    if (unlocked < MAKING_AMOUNT && (available === 0n || random() < 0.3)) {
                        const amount = available + 1n + randomAmount(random, MAKING_AMOUNT - unlocked - 1n);
                        await expect(fill(amount, ether('1'), now))
                            .to.be.revertedWithCustomError(twap, 'TwapAmountNotUnlocked').withArgs(filled + amount, unlocked);
                    } else if (available > 0n) {
                        const amount = 1n + randomAmount(random, available - 1n);
                        const takingAmount = expectedTakingAmount(amount, now - schedule.startTime - part * interval, auction);
                        const tx = await fill(amount, takingAmount, now);
                        await expect(tx).to.changeTokenBalances(weth, [alice, resolver], [takingAmount, -takingAmount]);
                        filled += amount;
                    }
                }

                if (filled < MAKING_AMOUNT) {
                    await expect(fill(1n, ether('1'), end)).to.be.revertedWithCustomError(twap, 'TwapEnded');
                }
            });
        }
    });
});
