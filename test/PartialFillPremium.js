const hre = require('hardhat');
const { ethers } = hre;
const { expect, ether, deployContract } = require('@1inch/solidity-utils');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { buildOrder, buildTakerTraits, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { deploySwapTokens, getChainId } = require('./helpers/fixtures');
const { buildSettlementExtensions } = require('./helpers/fusionUtils');
const {
    BASE_POINTS,
    NO_FEE_DATA,
    ceilDiv,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    takingAmountFor,
    makingAmountFor,
} = require('./helpers/anchoredAuction');

const HALF_PERCENT = 50_000n; // 0.5% in 1e7

describe('PartialFillPremium', function () {
    let maker, taker;

    before(async function () {
        [maker, taker] = await ethers.getSigners();
    });

    async function deployContractsAndInit() {
        const { dai, weth, accessToken, lopv4 } = await deploySwapTokens();
        const chainId = await getChainId();

        await dai.approve(lopv4, ether('1000'));
        await weth.connect(taker).deposit({ value: ether('1') });
        await weth.connect(taker).approve(lopv4, ether('1'));
        await accessToken.mint(taker, 1);

        const registrator = await deployContract('OrderRegistratorMock', [lopv4]);
        const settlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, maker, registrator]);

        return { dai, weth, lopv4, chainId, registrator, settlement };
    }

    const MAKING_AMOUNT = ether('100');
    const TAKING_AMOUNT = ether('0.1');

    async function buildPremiumOrder({ dai, weth, settlement, auctionDetails, exclusivity = buildAnchoredExclusivity({}) }) {
        return buildOrder(
            {
                maker: maker.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            },
            buildSettlementExtensions({
                feeTaker: await settlement.getAddress(),
                estimatedTakingAmount: TAKING_AMOUNT,
                getterExtraPrefix: auctionDetails,
                protocolFeeRecipient: maker.address,
                resolverFee: 0,
                whitelistDiscount: 50,
                whitelist: '0x00',
                whitelistPostInteraction: exclusivity,
            }),
        );
    }

    async function signature(order, chainId, lopv4) {
        return ethers.Signature.from(await signOrder(order, chainId, await lopv4.getAddress(), maker));
    }

    function fill(lopv4, order, sig, amount, { byMakingAmount = true, overrides = {} } = {}) {
        const takerTraits = buildTakerTraits({ makingAmount: byMakingAmount, extension: order.extension });
        return lopv4.connect(taker).fillOrderArgs(order, sig.r, sig.yParityAndS, amount, takerTraits.traits, takerTraits.args, overrides);
    }

    /** The blob a settlement getter is called with directly: the auction followed by empty fee data. */
    function getterExtraData(params) {
        return ethers.solidityPacked(['bytes', 'bytes'], [buildAnchoredAuctionDetails(params), NO_FEE_DATA]);
    }

    // Premium each decile of the remainder pays, 1/10 … 10/10; deliberately convex, as a depth-based quote is.
    const MATRIX = [400_000, 250_000, 160_000, 105_000, 70_000, 45_000, 26_000, 12_000, 4_000, 0];
    const FILL_PREMIUMS = {
        initial: 500_000, // 5% for a vanishing fill
        points: MATRIX.slice(0, 9).map((premium) => ({ premium, shareDelta: 1000 })),
    };

    after(async function () {
        await hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
    });

    async function deployMatrixOrder(extra = {}) {
        const contracts = await loadFixture(deployContractsAndInit);
        const { dai, weth, lopv4, chainId, settlement } = contracts;
        const startTime = await time.latest() + 10;
        const params = { startTime, duration: 100, initialRateBump: Number(HALF_PERCENT), fillPremiums: FILL_PREMIUMS, ...extra };
        const order = await buildPremiumOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
        const sig = await signature(order, chainId, lopv4);
        return { ...contracts, order, sig, params, afterAuction: startTime + 200 };
    }

    describe('pricing by fill share', function () {
        it('prices every decile exactly at its matrix row', async function () {
            const { lopv4, settlement, order, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await hre.network.provider.send('evm_mine');

            const orderHash = await lopv4.hashOrder(order);
            const extraData = getterExtraData(params);
            for (let decile = 1; decile <= 10; decile++) {
                const makingAmount = MAKING_AMOUNT * BigInt(decile) / 10n;
                const taking = await settlement.getTakingAmount(order, order.extension, orderHash, taker.address, makingAmount, MAKING_AMOUNT, extraData);
                const expectedBump = BigInt(MATRIX[decile - 1]);
                expect(taking).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * BigInt(decile), 10n) * (BASE_POINTS + expectedBump), BASE_POINTS));
            }
        });

        it('prices successive fills by their share of what remains', async function () {
            const { weth, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            // Each fill is priced by its share of what remains, not by where it lands on the original amount.
            let fillTime = afterAuction;
            let remaining = MAKING_AMOUNT;
            for (let i = 0; i < 3; i++) {
                await time.setNextBlockTimestamp(fillTime);
                const expected = takingAmountFor(order, params, fillTime, MAKING_AMOUNT / 10n, remaining);
                const share = (MAKING_AMOUNT / 10n) * 10000n / remaining;
                const interpolated = (share - 1000n) * BigInt(MATRIX[1]) + (2000n - share) * BigInt(MATRIX[0]);
                const premium = i === 0 ? BigInt(MATRIX[0]) : interpolated / 1000n;
                expect(expected).to.equal(ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + premium), BASE_POINTS));
                await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 10n))
                    .to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
                remaining -= MAKING_AMOUNT / 10n;
                fillTime++;
            }
        });

        it('charges a late small fill by its share of the remainder, not its place on the original', async function () {
            const { weth, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            // With 80% filled, 10% of the original is half of the remainder: the 5/10 row, not the 9/10 one.
            await time.setNextBlockTimestamp(afterAuction);
            await fill(lopv4, order, sig, MAKING_AMOUNT * 8n / 10n);

            const fillTime = afterAuction + 1;
            await time.setNextBlockTimestamp(fillTime);
            const remaining = MAKING_AMOUNT * 2n / 10n;
            const expected = takingAmountFor(order, params, fillTime, MAKING_AMOUNT / 10n, remaining);
            expect(expected).to.equal(ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + BigInt(MATRIX[4])), BASE_POINTS));
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 10n))
                .to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('interpolates between matrix rows instead of stepping', async function () {
            const { weth, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            const makingAmount = MAKING_AMOUNT * 15n / 100n; // halfway between the 1/10 and 2/10 rows
            const fillTx = fill(lopv4, order, sig, makingAmount);

            const expected = takingAmountFor(order, params, afterAuction, makingAmount, MAKING_AMOUNT);
            const midRowBump = BigInt(MATRIX[0] + MATRIX[1]) / 2n;
            expect(expected).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * 15n, 100n) * (BASE_POINTS + midRowBump), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('interpolates past the last row toward zero at completion', async function () {
            const { lopv4, settlement, order, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await hre.network.provider.send('evm_mine');

            // 95% lands on the implied final segment, halfway between the 9/10 row and zero.
            const makingAmount = MAKING_AMOUNT * 95n / 100n;
            const taking = await settlement.getTakingAmount(
                order, order.extension, await lopv4.hashOrder(order), taker.address, makingAmount, MAKING_AMOUNT, getterExtraData(params),
            );
            const halfLastRow = BigInt(MATRIX[8]) / 2n;
            expect(taking).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * 95n, 100n) * (BASE_POINTS + halfLastRow), BASE_POINTS));
        });

        it('adds the matrix premium on top of the running time curve', async function () {
            const { weth, lopv4, order, sig, params } = await deployMatrixOrder();

            // The 3/10 row rides on top of the half-decayed time curve.
            const fillTime = params.startTime + 50;
            await time.setNextBlockTimestamp(fillTime);
            const makingAmount = MAKING_AMOUNT * 3n / 10n;
            const fillTx = fill(lopv4, order, sig, makingAmount);

            const expected = takingAmountFor(order, params, fillTime, makingAmount, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * 3n, 10n) * (BASE_POINTS + HALF_PERCENT / 2n + BigInt(MATRIX[2])), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('sweeps the remainder at the plain curve price', async function () {
            const { weth, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 5n);

            // Whatever its absolute size, taking everything that is left costs no premium at all.
            const fillTime = afterAuction + 10;
            await time.setNextBlockTimestamp(fillTime);
            const remainder = MAKING_AMOUNT * 2n / 5n;
            const expected = takingAmountFor(order, params, fillTime, remainder, remainder);
            expect(expected).to.equal(ceilDiv(TAKING_AMOUNT * 2n, 5n));
            await expect(fill(lopv4, order, sig, remainder)).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('prices a fill by taking amount through the conservative estimate', async function () {
            const { dai, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            const fillTime = afterAuction;
            await time.setNextBlockTimestamp(fillTime);
            const takingAmount = TAKING_AMOUNT / 10n;
            const expected = makingAmountFor(order, params, fillTime, takingAmount, MAKING_AMOUNT);
            await expect(fill(lopv4, order, sig, takingAmount, { byMakingAmount: false }))
                .to.changeTokenBalances(dai, [taker, maker], [expected, -expected]);
        });

        it('offsets the gas bump from the matrix premium', async function () {
            const { dai, weth, lopv4, chainId, settlement } = await loadFixture(deployContractsAndInit);

            const startTime = await time.latest() + 10;
            const baseFee = 1000000000n; // 1 gwei, exactly the estimate below
            const params = {
                startTime,
                duration: 100,
                initialRateBump: Number(HALF_PERCENT),
                fillPremiums: FILL_PREMIUMS,
                gasBumpEstimate: Number(HALF_PERCENT * 4n), // 2%
                gasPriceEstimate: 1000,
            };
            const order = await buildPremiumOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);

            // After the auction the first decile carries the 4% row, and the 2% gas bump comes off it.
            await hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x' + baseFee.toString(16)]);
            await time.setNextBlockTimestamp(startTime + 200);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT / 10n, { overrides: { gasPrice: baseFee * 2n } });

            const expected = ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + BigInt(MATRIX[0]) - HALF_PERCENT * 4n), BASE_POINTS);
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('never lets any split of the order undercut a single sweep', async function () {
            const { lopv4, settlement, order, params, afterAuction } = await deployMatrixOrder();
            const singleRow = await deployMatrixOrder({ fillPremiums: { initial: Number(HALF_PERCENT), points: [] } });

            await time.setNextBlockTimestamp(afterAuction + 1000);
            await hre.network.provider.send('evm_mine');

            // For both curve shapes, no random partition may cost less in total than one full sweep.
            let seed = 0xdead4351n;
            const nextRand = (bound) => {
                seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
                return seed % bound;
            };

            for (const { o, p } of [{ o: order, p: params }, { o: singleRow.order, p: singleRow.params }]) {
                const orderHash = await lopv4.hashOrder(o);
                const extraData = getterExtraData(p);
                const sweep = await settlement.getTakingAmount(o, o.extension, orderHash, taker.address, MAKING_AMOUNT, MAKING_AMOUNT, extraData);

                for (let trial = 0; trial < 8; trial++) {
                    const chunks = [];
                    let remaining = MAKING_AMOUNT;
                    const parts = 2n + nextRand(4n);
                    for (let i = 1n; i < parts; i++) {
                        const chunk = 1n + nextRand(remaining - (parts - i));
                        chunks.push(chunk);
                        remaining -= chunk;
                    }
                    chunks.push(remaining);

                    let total = 0n;
                    let left = MAKING_AMOUNT;
                    for (const chunk of chunks) {
                        total += await settlement.getTakingAmount(o, o.extension, orderHash, taker.address, chunk, left, extraData);
                        left -= chunk;
                    }
                    expect(total, `partition ${chunks.join('+')}`).to.be.greaterThanOrEqual(sweep);
                }
            }
        });
    });

    describe('curve validation', function () {
        it('rejects a matrix whose premium rises along the ladder', async function () {
            // A rising stretch would make splitting a fill cheaper than its sum, so pricing off it reverts.
            const humpPremiums = {
                initial: 100_000,
                points: [
                    { premium: 400_000, shareDelta: 3000 },
                    { premium: 50_000, shareDelta: 4000 },
                ],
            };
            const { lopv4, settlement, order, sig, afterAuction } = await deployMatrixOrder({ fillPremiums: humpPremiums });

            await time.setNextBlockTimestamp(afterAuction);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 10n))
                .to.be.revertedWithCustomError(settlement, 'NonMonotonicFillCurve');

            // The making-amount direction walks the same curve and refuses it the same way.
            await expect(fill(lopv4, order, sig, TAKING_AMOUNT / 10n, { byMakingAmount: false }))
                .to.be.revertedWithCustomError(settlement, 'NonMonotonicFillCurve');
        });

        it('rejects a rising first row before any interior point is read', async function () {
            // A first row above the initial premium is caught on the walk's very first comparison.
            const risingPremiums = { initial: 50_000, points: [{ premium: 100_000, shareDelta: 5000 }] };
            const { lopv4, settlement, order, sig, afterAuction } = await deployMatrixOrder({ fillPremiums: risingPremiums });

            await time.setNextBlockTimestamp(afterAuction);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 10n))
                .to.be.revertedWithCustomError(settlement, 'NonMonotonicFillCurve');
        });

        it('validates only the prefix a fill is actually priced on', async function () {
            // Enforcement is lazy: a fill priced on the legal prefix passes despite a broken tail.
            const brokenTail = {
                initial: 300_000,
                points: [
                    { premium: 200_000, shareDelta: 3000 },
                    { premium: 400_000, shareDelta: 4000 }, // illegal, but only for fills that reach it
                ],
            };
            const { weth, lopv4, settlement, order, sig, params, afterAuction } = await deployMatrixOrder({ fillPremiums: brokenTail });

            await time.setNextBlockTimestamp(afterAuction);
            const firstAmount = MAKING_AMOUNT * 2n / 10n;
            const first = takingAmountFor(order, params, afterAuction, firstAmount, MAKING_AMOUNT);
            await expect(fill(lopv4, order, sig, firstAmount)).to.changeTokenBalances(weth, [taker, maker], [-first, first]);

            // Reaching past the legal prefix hits the rising row and reverts.
            await time.setNextBlockTimestamp(afterAuction + 10);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 10n))
                .to.be.revertedWithCustomError(settlement, 'NonMonotonicFillCurve');

            // Completing the order short-circuits to the plain auction price without walking the curve.
            const fillTime = afterAuction + 20;
            await time.setNextBlockTimestamp(fillTime);
            const rest = MAKING_AMOUNT - firstAmount;
            const completing = takingAmountFor(order, params, fillTime, rest, rest);
            await expect(fill(lopv4, order, sig, rest)).to.changeTokenBalances(weth, [taker, maker], [-completing, completing]);
        });
    });

    describe('composition with the rest of the encoding', function () {
        it('keeps the time curve points readable alongside a fill curve', async function () {
            const { dai, weth, lopv4, chainId, settlement } = await loadFixture(deployContractsAndInit);

            // With both curves present, the fill curve sits directly behind the time points.
            const startTime = await time.latest() + 10;
            const params = {
                startTime,
                duration: 100,
                initialRateBump: Number(HALF_PERCENT * 2n),
                points: [{ coefficient: Number(HALF_PERCENT), delay: 50 }],
                fillPremiums: FILL_PREMIUMS,
            };
            const order = await buildPremiumOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);

            const fillTime = startTime + 50; // exactly the single point, where the curve is at 0.5%
            await time.setNextBlockTimestamp(fillTime);
            const makingAmount = MAKING_AMOUNT / 10n;
            const expected = takingAmountFor(order, params, fillTime, makingAmount, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + HALF_PERCENT + BigInt(MATRIX[0])), BASE_POINTS));
            await expect(fill(lopv4, order, sig, makingAmount)).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('prices an anchored auction by fill share too', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const params = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true, fillPremiums: FILL_PREMIUMS };
            const order = await buildPremiumOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);
            await registrator.registerOrder(order);
            const announcedAt = await time.latest();

            // Halfway through the auction the announcement carries the start, and the fill share the price.
            const fillTime = announcedAt + 50;
            await time.setNextBlockTimestamp(fillTime);
            const makingAmount = MAKING_AMOUNT / 10n;
            const expected = takingAmountFor(order, { ...params, startTime: announcedAt }, fillTime, makingAmount, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + HALF_PERCENT / 2n + BigInt(MATRIX[0])), BASE_POINTS));
            await expect(fill(lopv4, order, sig, makingAmount)).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('leaves an order without a fill curve on the legacy bytes', async function () {
            const { dai, weth, lopv4, settlement } = await loadFixture(deployContractsAndInit);

            const params = { startTime: await time.latest() + 10, duration: 100, initialRateBump: Number(HALF_PERCENT) };
            expect(buildAnchoredAuctionDetails(params)).to.equal(buildAnchoredAuctionDetails({ ...params, fillPremiums: undefined }));

            // And the price it quotes ignores the fill size entirely.
            const order = await buildPremiumOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
            const orderHash = await lopv4.hashOrder(order);
            const extraData = getterExtraData(params);
            const args = [order, order.extension, orderHash, taker.address];
            expect(await settlement.getTakingAmount(...args, MAKING_AMOUNT / 10n, MAKING_AMOUNT, extraData))
                .to.equal(await settlement.getTakingAmount(...args, MAKING_AMOUNT / 10n, MAKING_AMOUNT / 10n, extraData));
        });
    });
});
