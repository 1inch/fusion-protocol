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
    buildLegacyAuctionDetails,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    fillPremiumAt,
    takingAmountFor,
    makingAmountFor,
} = require('./helpers/anchoredAuction');

const HALF_PERCENT = 50_000n; // 0.5% in 1e7

describe('FusionAnchoredAuction', function () {
    let maker, taker, otherResolver;

    before(async function () {
        [maker, taker, otherResolver] = await ethers.getSigners();
    });

    async function deployContractsAndInit() {
        const { dai, weth, accessToken, lopv4 } = await deploySwapTokens();
        const chainId = await getChainId();

        await dai.approve(lopv4, ether('1000'));
        await weth.connect(taker).deposit({ value: ether('1') });
        await weth.connect(taker).approve(lopv4, ether('1'));
        await weth.connect(otherResolver).deposit({ value: ether('1') });
        await weth.connect(otherResolver).approve(lopv4, ether('1'));
        await accessToken.mint(taker, 1);

        const registrator = await deployContract('OrderRegistratorMock', [lopv4]);
        const auction = await deployContract('FusionAnchoredAuction', [registrator]);
        const settlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, maker]);

        return { dai, weth, accessToken, lopv4, chainId, registrator, auction, settlement };
    }

    const MAKING_AMOUNT = ether('100');
    const TAKING_AMOUNT = ether('0.1');

    /** An order priced solely by the auction contract, with no settlement layer in front of it. */
    async function buildAuctionOrder({ dai, weth, auction, auctionDetails, exclusivity, receiver }) {
        const auctionAddress = await auction.getAddress();
        return buildOrder(
            {
                maker: maker.address,
                receiver,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            },
            {
                makingAmountData: ethers.solidityPacked(['address', 'bytes'], [auctionAddress, auctionDetails]),
                takingAmountData: ethers.solidityPacked(['address', 'bytes'], [auctionAddress, auctionDetails]),
                postInteraction: exclusivity === undefined
                    ? '0x'
                    : ethers.solidityPacked(['address', 'bytes'], [auctionAddress, exclusivity]),
            },
        );
    }

    async function signature(order, chainId, lopv4) {
        return ethers.Signature.from(await signOrder(order, chainId, await lopv4.getAddress(), maker));
    }

    async function announce(registrator, order) {
        await registrator.registerOrder(order);
        return await time.latest();
    }

    function fill(lopv4, order, sig, amount, { byMakingAmount = true, from = taker, overrides = {} } = {}) {
        const takerTraits = buildTakerTraits({ makingAmount: byMakingAmount, extension: order.extension });
        return lopv4.connect(from).fillOrderArgs(order, sig.r, sig.yParityAndS, amount, takerTraits.traits, takerTraits.args, overrides);
    }

    describe('announcement-anchored auction', function () {
        const anchoredParams = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true };

        it('reverts when the order was never announced', async function () {
            const { dai, weth, lopv4, chainId, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'OrderNotAnnounced');
        });

        it('starts the auction at the announcement however stale the built start time is', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            // A build-time start of 0 is long past; the announcement is what the auction runs from.
            const announcedAt = await announce(registrator, order);
            const resolved = { ...anchoredParams, startTime: announcedAt };

            const fillTime = resolved.startTime + 50;
            await time.setNextBlockTimestamp(fillTime);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT);

            const expected = takingAmountFor(order, resolved, fillTime, MAKING_AMOUNT, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv(TAKING_AMOUNT * (BASE_POINTS + HALF_PERCENT / 2n), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('keeps a build-time start that is later than the announcement', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const startTime = await time.latest() + 1000;
            const params = { ...anchoredParams, startTime };
            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);

            const announcedAt = await announce(registrator, order);
            expect(announcedAt).to.be.lessThan(startTime);

            // Anchoring may only move the start later, so the auction has not begun yet.
            const fillTime = announcedAt + 20;
            await time.setNextBlockTimestamp(fillTime);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT);

            const expected = takingAmountFor(order, params, fillTime, MAKING_AMOUNT, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv(TAKING_AMOUNT * (BASE_POINTS + HALF_PERCENT), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('prices a fill announced in the same block at the top of the curve', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            // The maker announces and a resolver fills in the same block; the fill sees the announcement
            // written earlier in the block and prices at the very start of the curve.
            await hre.network.provider.send('evm_setAutomine', [false]);
            let announceTx, fillTx;
            try {
                announceTx = await registrator.registerOrder(order, { gasLimit: 300000 });
                const takerTraits = buildTakerTraits({ makingAmount: true, extension: order.extension });
                fillTx = await lopv4.connect(taker).fillOrderArgs(
                    order, sig.r, sig.yParityAndS, MAKING_AMOUNT, takerTraits.traits, takerTraits.args, { gasLimit: 500000 },
                );
            } finally {
                await hre.network.provider.send('evm_setAutomine', [true]);
                await hre.network.provider.send('evm_mine');
            }

            const announceReceipt = await announceTx.wait();
            const fillReceipt = await fillTx.wait();
            expect(announceReceipt.blockNumber).to.equal(fillReceipt.blockNumber);

            const expected = ceilDiv(TAKING_AMOUNT * (BASE_POINTS + HALF_PERCENT), BASE_POINTS);
            expect(await weth.balanceOf(maker)).to.equal(expected);
            expect(await dai.balanceOf(taker)).to.equal(MAKING_AMOUNT);
            expect(await registrator.announcedAt(await lopv4.hashOrder(order))).to.equal(await time.latest());
        });

        it('handles every optional field at once, in both fill directions', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const params = {
                startTime: 0,
                duration: 100,
                initialRateBump: Number(HALF_PERCENT),
                anchored: true,
                fillPremiums: { initial: Number(HALF_PERCENT), points: [] },
            };
            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(params),
                // The fill-by deadline rides in the post-interaction blob: an anchored exclusivity with
                // an empty whitelist is exactly "a deadline without exclusivity".
                exclusivity: buildAnchoredExclusivity({ allowedTimeDelay: 0, announcementDeadlineDelay: 160, whitelist: [] }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);
            const resolved = { ...params, startTime: announcedAt };

            // A fill by making amount halfway through the anchored auction, its curve premium on top.
            const firstFillTime = announcedAt + 50;
            await time.setNextBlockTimestamp(firstFillTime);
            const firstExpected = takingAmountFor(order, resolved, firstFillTime, MAKING_AMOUNT / 2n, MAKING_AMOUNT);
            expect(firstExpected).to.equal(ceilDiv((TAKING_AMOUNT / 2n) * (BASE_POINTS + HALF_PERCENT), BASE_POINTS));
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n)).to.changeTokenBalances(weth, [taker, maker], [-firstExpected, firstExpected]);

            // A fill by taking amount after the auction, priced through the conservative estimate.
            const secondFillTime = announcedAt + 120;
            await time.setNextBlockTimestamp(secondFillTime);
            const takingAmount = TAKING_AMOUNT / 10n;
            const secondExpected = makingAmountFor(order, resolved, secondFillTime, takingAmount, MAKING_AMOUNT / 2n);
            await expect(fill(lopv4, order, sig, takingAmount, { byMakingAmount: false }))
                .to.changeTokenBalances(dai, [taker, maker], [secondExpected, -secondExpected]);

            // And past the anchored deadline nothing fills at all.
            await time.setNextBlockTimestamp(announcedAt + 160 + 1);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 10n)).to.be.revertedWithCustomError(auction, 'AuctionExpired');
        });

        it('gives a slow announcement the same curve a prompt one gets', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            // Announce hours after the order was built, as a multisig collecting signatures would.
            await time.increase(6 * 60 * 60);
            const announcedAt = await announce(registrator, order);

            const fillTime = announcedAt + 1;
            await time.setNextBlockTimestamp(fillTime);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT);

            // One second into the anchored curve — essentially the top, rather than the floor price an
            // unanchored order would have decayed to hours ago.
            const expected = takingAmountFor(order, { ...anchoredParams, startTime: announcedAt }, fillTime, MAKING_AMOUNT, MAKING_AMOUNT);
            expect(expected).to.be.greaterThan(ceilDiv(TAKING_AMOUNT * (BASE_POINTS + HALF_PERCENT * 9n / 10n), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });
    });

    describe('announcement-anchored resolver exclusivity', function () {
        const auctionParams = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true };

        it('holds the exclusive window open relative to the announcement', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 30,
                    whitelist: [{ address: taker.address }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 29);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('makes a resolver outside the whitelist wait out every window', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 10,
                    whitelist: [{ address: taker.address, delta: 20 }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 25);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT, { from: otherResolver }))
                .to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT, { from: otherResolver }))
                .to.changeTokenBalances(dai, [otherResolver, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('keeps a built allowed time that is later than the anchored one', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const allowedTime = await time.latest() + 100;
            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTime,
                    allowedTimeDelay: 5,
                    whitelist: [{ address: taker.address }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);
            expect(announcedAt + 5).to.be.lessThan(allowedTime);

            // Anchoring may only move the window later, mirroring the auction start's max() semantics.
            await time.setNextBlockTimestamp(allowedTime - 1);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(allowedTime);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('staggers two whitelisted resolvers by their deltas', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 10,
                    whitelist: [
                        { address: taker.address, delta: 20 },
                        { address: otherResolver.address },
                    ],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            // The second resolver is whitelisted but its window opens a delta after the first one's.
            await time.setNextBlockTimestamp(announcedAt + 15);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n, { from: otherResolver }))
                .to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 16);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n))
                .to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n, { from: otherResolver }))
                .to.changeTokenBalances(dai, [otherResolver, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);
        });

        it('gates everyone by the anchored time when the whitelist is empty', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({ allowedTimeDelay: 30, whitelist: [] }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 29);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('stops fills once the announcement deadline has passed', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 0,
                    announcementDeadlineDelay: 120,
                    whitelist: [{ address: taker.address }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            // On the deadline itself the order still fills — the cutoff is strictly after it.
            await time.setNextBlockTimestamp(announcedAt + 120);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n))
                .to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);

            await time.setNextBlockTimestamp(announcedAt + 121);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n)).to.be.revertedWithCustomError(auction, 'AuctionExpired');
        });

        it('rejects a deadline that is not anchored', async function () {
            const { dai, weth, lopv4, chainId, auction } = await loadFixture(deployContractsAndInit);

            // The deadline is measured from the announcement, so without the anchored bit there is
            // nothing to measure it from — the combination fails closed instead of silently no-oping.
            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails({ startTime: 0, duration: 100, initialRateBump: 0 }),
                exclusivity: buildAnchoredExclusivity({
                    announcementDeadlineDelay: 120,
                    whitelist: [{ address: taker.address }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);

            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'InvalidFlagCombination');
        });

        it('passes the fill on to the next post-interaction', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction } = await loadFixture(deployContractsAndInit);

            const customExtension = await deployContract('CustomExtension');

            const order = await buildAuctionOrder({
                dai,
                weth,
                auction,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: ethers.solidityPacked(
                    ['bytes', 'address', 'bytes'],
                    [
                        buildAnchoredExclusivity({ allowedTimeDelay: 0, whitelist: [{ address: taker.address }] }),
                        await customExtension.getAddress(),
                        '0xdeadbeef',
                    ],
                ),
            });
            const sig = await signature(order, chainId, lopv4);
            await announce(registrator, order);

            await expect(fill(lopv4, order, sig, MAKING_AMOUNT))
                .to.emit(customExtension, 'CustomPostInteractionData')
                .withArgs('0xdeadbeef');
        });
    });

    describe('fill-priced by a matrix of rates', function () {
        // The quote's matrix for 1/10 … 10/10 of the amount, expressed as the premium each size pays over
        // the rate for the full amount. Deliberately convex, the shape a depth-based quote produces and the
        // linear rule cannot: small sizes are worth far more per unit than mid sizes.
        const MATRIX = [400_000, 250_000, 160_000, 105_000, 70_000, 45_000, 26_000, 12_000, 4_000, 0];
        const FILL_PREMIUMS = {
            initial: 500_000, // 5% for a vanishing fill
            // Nine points at each decile up to 9/10; the implied final point is zero premium at a full sweep.
            points: MATRIX.slice(0, 9).map((premium) => ({ premium, shareDelta: 1000 })),
        };

        after(async function () {
            await hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);
        });

        async function deployMatrixOrder(extra = {}) {
            const contracts = await loadFixture(deployContractsAndInit);
            const { dai, weth, lopv4, chainId, auction } = contracts;
            const startTime = await time.latest() + 10;
            const params = { startTime, duration: 100, initialRateBump: Number(HALF_PERCENT), fillPremiums: FILL_PREMIUMS, ...extra };
            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);
            return { ...contracts, order, sig, params, afterAuction: startTime + 200 };
        }

        it('prices every decile exactly at its matrix row', async function () {
            const { lopv4, auction, order, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await hre.network.provider.send('evm_mine');

            const orderHash = await lopv4.hashOrder(order);
            const extraData = buildAnchoredAuctionDetails(params);
            for (let decile = 1; decile <= 10; decile++) {
                const makingAmount = MAKING_AMOUNT * BigInt(decile) / 10n;
                const taking = await auction.getTakingAmount(order, order.extension, orderHash, taker.address, makingAmount, MAKING_AMOUNT, extraData);
                const expectedBump = BigInt(MATRIX[decile - 1]);
                expect(taking).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * BigInt(decile), 10n) * (BASE_POINTS + expectedBump), BASE_POINTS));
            }
        });

        it('prices successive fills by their share of what remains', async function () {
            const { weth, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            // Every fill sees the remainder as a fresh ladder: the first tenth is a 10% slice of a whole
            // order, the next tenth is a 10/90 slice of what is left, and so on — each priced by its own
            // share of the remainder rather than by where it lands on the original amount.
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

            // With 80% already filled, a fill of 10% of the original order is half of what remains, so it
            // prices at the 5/10 row — not at the nearly-free 9/10 row its cumulative end would land on.
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
            const { lopv4, auction, order, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await hre.network.provider.send('evm_mine');

            // The last explicit row sits at 9/10; a fill ending at 95% lands on the implied final segment,
            // halfway between that row and the zero premium of completion.
            const makingAmount = MAKING_AMOUNT * 95n / 100n;
            const taking = await auction.getTakingAmount(
                order, order.extension, await lopv4.hashOrder(order), taker.address, makingAmount, MAKING_AMOUNT, buildAnchoredAuctionDetails(params),
            );
            const halfLastRow = BigInt(MATRIX[8]) / 2n;
            expect(taking).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * 95n, 100n) * (BASE_POINTS + halfLastRow), BASE_POINTS));
        });

        it('offsets the gas bump from the matrix premium', async function () {
            const contracts = await loadFixture(deployContractsAndInit);
            const { dai, weth, lopv4, chainId, auction } = contracts;

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
            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(params) });
            const sig = await signature(order, chainId, lopv4);

            // After the auction the first decile carries the 4% row, and the 2% gas bump comes off it.
            await hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x' + baseFee.toString(16)]);
            await time.setNextBlockTimestamp(startTime + 200);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT / 10n, { overrides: { gasPrice: baseFee * 2n } });

            const expected = ceilDiv((TAKING_AMOUNT / 10n) * (BASE_POINTS + BigInt(MATRIX[0]) - HALF_PERCENT * 4n), BASE_POINTS);
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('never lets any split of the order undercut a single sweep', async function () {
            const { lopv4, auction, order, params, afterAuction } = await deployMatrixOrder();
            const singleRow = await deployMatrixOrder({ fillPremiums: { initial: Number(HALF_PERCENT), points: [] } });

            await time.setNextBlockTimestamp(afterAuction + 1000);
            await hre.network.provider.send('evm_mine');

            // A seeded sweep over random partitions, priced through the contract's own view methods: for
            // both curve shapes, no way of slicing the order may cost less in total than one full sweep.
            let seed = 0xdead4351n;
            const nextRand = (bound) => {
                seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
                return seed % bound;
            };

            for (const { o, p } of [{ o: order, p: params }, { o: singleRow.order, p: singleRow.params }]) {
                const orderHash = await lopv4.hashOrder(o);
                const extraData = buildAnchoredAuctionDetails(p);
                const sweep = await auction.getTakingAmount(o, o.extension, orderHash, taker.address, MAKING_AMOUNT, MAKING_AMOUNT, extraData);

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
                        total += await auction.getTakingAmount(o, o.extension, orderHash, taker.address, chunk, left, extraData);
                        left -= chunk;
                    }
                    expect(total, `partition ${chunks.join('+')}`).to.be.greaterThanOrEqual(sweep);
                }
            }
        });

        it('adds the matrix premium on top of the running time curve', async function () {
            const { weth, lopv4, order, sig, params } = await deployMatrixOrder();

            // Halfway through the auction the time curve still carries half the initial bump, and the
            // 3/10-sized fill pays its matrix row on top of it.
            const fillTime = params.startTime + 50;
            await time.setNextBlockTimestamp(fillTime);
            const makingAmount = MAKING_AMOUNT * 3n / 10n;
            const fillTx = fill(lopv4, order, sig, makingAmount);

            const expected = takingAmountFor(order, params, fillTime, makingAmount, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv(ceilDiv(TAKING_AMOUNT * 3n, 10n) * (BASE_POINTS + HALF_PERCENT / 2n + BigInt(MATRIX[2])), BASE_POINTS));
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('sweeps the remainder at the plain curve price', async function () {
            const { weth, lopv4, order, sig, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            await fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 5n);

            // Whatever its absolute size, taking everything that is left costs no premium at all.
            await time.setNextBlockTimestamp(afterAuction + 10);
            const remainder = MAKING_AMOUNT * 2n / 5n;
            await expect(fill(lopv4, order, sig, remainder)).to.changeTokenBalances(
                weth, [taker, maker], [-TAKING_AMOUNT * 2n / 5n, TAKING_AMOUNT * 2n / 5n],
            );
        });

        it('prices a fill by taking amount no better than an exact solution would', async function () {
            const { dai, lopv4, order, sig, params, afterAuction } = await deployMatrixOrder();

            await time.setNextBlockTimestamp(afterAuction);
            const takingAmount = TAKING_AMOUNT / 4n;
            const fillTx = fill(lopv4, order, sig, takingAmount, { byMakingAmount: false });

            const expected = makingAmountFor(order, params, afterAuction, takingAmount, MAKING_AMOUNT);
            await expect(fillTx).to.changeTokenBalances(dai, [taker, maker], [expected, -expected]);

            const exact = (() => {
                let amount = expected;
                for (let i = 0; i < 64; i++) {
                    const rateBump = amount >= MAKING_AMOUNT ? 0n : fillPremiumAt(amount, MAKING_AMOUNT, FILL_PREMIUMS);
                    amount = (order.makingAmount * takingAmount / order.takingAmount) * BASE_POINTS / (BASE_POINTS + rateBump);
                }
                return amount;
            })();
            expect(expected).to.be.lessThanOrEqual(exact);
        });

        it('works alongside anchoring', async function () {
            const { weth, lopv4, registrator, order, sig, params } = await deployMatrixOrder({
                startTime: 0,
                anchored: true,
            });

            const announcedAt = await announce(registrator, order);
            const resolved = { ...params, startTime: announcedAt };

            const fillTime = announcedAt + 120; // past the anchored auction
            await time.setNextBlockTimestamp(fillTime);
            const makingAmount = MAKING_AMOUNT / 2n;
            const expected = takingAmountFor(order, resolved, fillTime, makingAmount, MAKING_AMOUNT);
            expect(expected).to.equal(ceilDiv((TAKING_AMOUNT / 2n) * (BASE_POINTS + BigInt(MATRIX[4])), BASE_POINTS));
            await expect(fill(lopv4, order, sig, makingAmount)).to.changeTokenBalances(weth, [taker, maker], [-expected, expected]);
        });

        it('rejects a matrix whose premium rises along the ladder', async function () {
            // A hump-shaped matrix: mid-sized fills pay the most. It is encodable, but a rising stretch
            // makes two fills cheaper than their sum — a taker would be paid to split — so pricing off
            // such a curve reverts instead.
            const humpPremiums = {
                initial: 100_000,
                points: [
                    { premium: 400_000, shareDelta: 3000 },
                    { premium: 50_000, shareDelta: 4000 },
                ],
            };
            const { lopv4, auction, order, sig, afterAuction } = await deployMatrixOrder({ fillPremiums: humpPremiums });

            await time.setNextBlockTimestamp(afterAuction);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 10n))
                .to.be.revertedWithCustomError(auction, 'NonMonotonicFillCurve');

            // The taking-amount direction walks the same curve and refuses it the same way.
            await expect(fill(lopv4, order, sig, TAKING_AMOUNT / 10n, { byMakingAmount: false }))
                .to.be.revertedWithCustomError(auction, 'NonMonotonicFillCurve');
        });

        it('rejects a rising first row before any interior point is read', async function () {
            // The initial premium is the curve's whole prefix for a vanishing fill, so a first row above
            // it is caught on the very first comparison of the walk.
            const risingPremiums = { initial: 50_000, points: [{ premium: 100_000, shareDelta: 5000 }] };
            const { lopv4, auction, order, sig, afterAuction } = await deployMatrixOrder({ fillPremiums: risingPremiums });

            await time.setNextBlockTimestamp(afterAuction);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 10n))
                .to.be.revertedWithCustomError(auction, 'NonMonotonicFillCurve');
        });

        it('validates only the prefix a fill is actually priced on', async function () {
            // Enforcement is lazy — one comparison per visited point — so a fill priced entirely on the
            // legal early rows goes through even when a later stretch of the curve is broken, and the
            // completing fill never reads the curve at all.
            const brokenTail = {
                initial: 300_000,
                points: [
                    { premium: 200_000, shareDelta: 3000 },
                    { premium: 400_000, shareDelta: 4000 }, // illegal, but only for fills that reach it
                ],
            };
            const { weth, lopv4, auction, order, sig, params, afterAuction } = await deployMatrixOrder({ fillPremiums: brokenTail });

            await time.setNextBlockTimestamp(afterAuction);
            const firstAmount = MAKING_AMOUNT * 2n / 10n;
            const first = takingAmountFor(order, params, afterAuction, firstAmount, MAKING_AMOUNT);
            await expect(fill(lopv4, order, sig, firstAmount)).to.changeTokenBalances(weth, [taker, maker], [-first, first]);

            // Reaching past the legal prefix hits the rising row and reverts.
            await time.setNextBlockTimestamp(afterAuction + 10);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT * 3n / 10n))
                .to.be.revertedWithCustomError(auction, 'NonMonotonicFillCurve');

            // Completing the order short-circuits to the plain auction price without walking the curve.
            await time.setNextBlockTimestamp(afterAuction + 20);
            const rest = MAKING_AMOUNT - firstAmount;
            const completing = takingAmountFor(order, params, afterAuction + 20, rest, rest);
            await expect(fill(lopv4, order, sig, rest)).to.changeTokenBalances(weth, [taker, maker], [-completing, completing]);
        });
    });

    describe('composition with SimpleSettlement', function () {
        it('prices the anchored auction chained behind the settlement, exclusivity intact', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction, settlement } = await loadFixture(deployContractsAndInit);

            const resolverFee = 1000n; // 1% in 1e5
            const auctionParams = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true };
            const auctionTail = ethers.solidityPacked(
                ['address', 'bytes'],
                [await auction.getAddress(), buildAnchoredAuctionDetails(auctionParams)],
            );
            const exclusivityTail = ethers.solidityPacked(
                ['address', 'bytes'],
                [await auction.getAddress(), buildAnchoredExclusivity({ allowedTimeDelay: 30, whitelist: [{ address: taker.address }] })],
            );

            const order = buildOrder(
                {
                    maker: maker.address,
                    receiver: await settlement.getAddress(),
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: MAKING_AMOUNT,
                    takingAmount: TAKING_AMOUNT,
                },
                buildSettlementExtensions({
                    feeTaker: await settlement.getAddress(),
                    estimatedTakingAmount: TAKING_AMOUNT,
                    // A curve that cannot move: no initial bump and no duration, so the settlement multiplies
                    // by one and the chained auction is the only thing pricing the order.
                    getterExtraPrefix: buildLegacyAuctionDetails(),
                    protocolFeeRecipient: otherResolver.address,
                    resolverFee,
                    whitelistDiscount: 100,
                    whitelist: '0x01' + taker.address.slice(-20),
                    // The settlement's own whitelist is left open, so exclusivity is the chained contract's to enforce.
                    whitelistPostInteraction: ethers.solidityPacked(
                        ['uint32', 'uint8', 'uint80', 'uint16'],
                        [0, 1, BigInt(taker.address) & ((1n << 80n) - 1n), 0],
                    ),
                    customMakingGetter: auctionTail,
                    customTakingGetter: auctionTail,
                    customPostInteraction: exclusivityTail,
                }),
            );
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            // The exclusivity chained behind the settlement still bites, though the settlement let the taker in.
            await time.setNextBlockTimestamp(announcedAt + 20);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(auction, 'AllowedTimeViolation');

            const fillTime = announcedAt + 60;
            await time.setNextBlockTimestamp(fillTime);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT / 2n);

            // The price is the anchored curve with the resolver fee on top, and nothing else.
            const auctionPrice = takingAmountFor(
                order,
                { ...auctionParams, startTime: announcedAt },
                fillTime,
                MAKING_AMOUNT / 2n,
                MAKING_AMOUNT,
            );
            const withFee = ceilDiv(auctionPrice * (100000n + resolverFee), 100000n);
            const feeAmount = withFee - ceilDiv(withFee * 100000n, 100000n + resolverFee);
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker, otherResolver], [-withFee, withFee - feeAmount, feeAmount]);
            await expect(fillTx).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);
        });

        it('enforces the announcement deadline through a chained settlement', async function () {
            const { dai, weth, lopv4, chainId, registrator, auction, settlement } = await loadFixture(deployContractsAndInit);

            const auctionParams = { startTime: 0, duration: 100, initialRateBump: 0, anchored: true };
            const auctionTail = ethers.solidityPacked(
                ['address', 'bytes'],
                [await auction.getAddress(), buildAnchoredAuctionDetails(auctionParams)],
            );
            const exclusivityTail = ethers.solidityPacked(
                ['address', 'bytes'],
                [
                    await auction.getAddress(),
                    buildAnchoredExclusivity({
                        allowedTimeDelay: 0,
                        announcementDeadlineDelay: 200,
                        whitelist: [{ address: taker.address }],
                    }),
                ],
            );

            const order = buildOrder(
                {
                    maker: maker.address,
                    receiver: await settlement.getAddress(),
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: MAKING_AMOUNT,
                    takingAmount: TAKING_AMOUNT,
                },
                buildSettlementExtensions({
                    feeTaker: await settlement.getAddress(),
                    estimatedTakingAmount: TAKING_AMOUNT,
                    getterExtraPrefix: buildLegacyAuctionDetails(),
                    whitelistDiscount: 100,
                    whitelist: '0x01' + taker.address.slice(-20),
                    whitelistPostInteraction: ethers.solidityPacked(
                        ['uint32', 'uint8', 'uint80', 'uint16'],
                        [0, 1, BigInt(taker.address) & ((1n << 80n) - 1n), 0],
                    ),
                    customMakingGetter: auctionTail,
                    customTakingGetter: auctionTail,
                    customPostInteraction: exclusivityTail,
                }),
            );
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            // The deadline chained behind the settlement holds even though the settlement let the taker in.
            await time.setNextBlockTimestamp(announcedAt + 200);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n))
                .to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);

            await time.setNextBlockTimestamp(announcedAt + 201);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n))
                .to.be.revertedWithCustomError(auction, 'AuctionExpired');
        });
    });

    describe('parity with the deployed settlement auction', function () {
        it('prices an unanchored auction exactly as the settlement contract does', async function () {
            const { dai, weth, lopv4, auction, settlement } = await loadFixture(deployContractsAndInit);

            const params = {
                gasBumpEstimate: 100000,
                gasPriceEstimate: 1000,
                startTime: await time.latest() + 100,
                duration: 200,
                initialRateBump: Number(HALF_PERCENT),
                points: [
                    { coefficient: Number(HALF_PERCENT * 4n / 5n), delay: 30 },
                    { coefficient: Number(HALF_PERCENT * 2n / 5n), delay: 30 },
                ],
            };
            const order = await buildAuctionOrder({ dai, weth, auction, auctionDetails: buildAnchoredAuctionDetails(params) });
            const orderHash = await lopv4.hashOrder(order);
            const settlementExtraData = ethers.solidityPacked(['bytes', 'bytes'], [buildLegacyAuctionDetails(params), NO_FEE_DATA]);
            const anchoredExtraData = buildAnchoredAuctionDetails(params);

            // Before the auction, at each of its points, between them, and after it has finished.
            for (const offset of [-10, 0, 15, 30, 45, 60, 120, 199, 200, 500]) {
                await time.setNextBlockTimestamp(params.startTime + offset);
                await hre.network.provider.send('evm_mine');

                for (const amount of [MAKING_AMOUNT, MAKING_AMOUNT / 3n]) {
                    const args = [order, order.extension, orderHash, taker.address, amount, MAKING_AMOUNT];
                    expect(await auction.getTakingAmount(...args, anchoredExtraData))
                        .to.equal(await settlement.getTakingAmount(...args, settlementExtraData));
                    expect(await auction.getMakingAmount(...args, anchoredExtraData))
                        .to.equal(await settlement.getMakingAmount(...args, settlementExtraData));
                }
            }
        });
    });
});
