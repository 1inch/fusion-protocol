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
    takingAmountFor,
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
