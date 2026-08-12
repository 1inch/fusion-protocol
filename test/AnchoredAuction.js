const hre = require('hardhat');
const { ethers } = hre;
const { constants, expect, ether, deployContract } = require('@1inch/solidity-utils');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { buildOrder, buildTakerTraits, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { deploySwapTokens, getChainId } = require('./helpers/fixtures');
const { buildSettlementExtensions } = require('./helpers/fusionUtils');
const {
    BASE_POINTS,
    NO_FEE_DATA,
    ceilDiv,
    auctionBumpAt,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    takingAmountFor,
} = require('./helpers/anchoredAuction');

const HALF_PERCENT = 50_000n; // 0.5% in 1e7

describe('AnchoredAuction', function () {
    let maker, taker, otherResolver, charlie;

    before(async function () {
        [maker, taker, otherResolver, charlie] = await ethers.getSigners();
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
        await accessToken.mint(otherResolver, 1);

        const registrator = await deployContract('OrderRegistratorMock', [lopv4]);
        const settlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, maker, registrator]);
        // A settlement deployed on a chain that has no registrator yet.
        const bareSettlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, maker, constants.ZERO_ADDRESS]);

        return { dai, weth, accessToken, lopv4, chainId, registrator, settlement, bareSettlement };
    }

    const MAKING_AMOUNT = ether('100');
    const TAKING_AMOUNT = ether('0.1');

    /** An order priced by the settlement itself: every extension slot points at it. */
    async function buildAnchoredOrder({
        dai,
        weth,
        settlement,
        auctionDetails,
        exclusivity = buildAnchoredExclusivity({}),
        receiver,
        resolverFee = 0,
        whitelistDiscount = 50,
        whitelist = '0x00',
        protocolFeeRecipient,
        makerReceiver,
        customPostInteraction = '0x',
    }) {
        return buildOrder(
            {
                maker: maker.address,
                receiver,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            },
            buildSettlementExtensions({
                feeTaker: await settlement.getAddress(),
                estimatedTakingAmount: TAKING_AMOUNT,
                getterExtraPrefix: auctionDetails,
                protocolFeeRecipient: protocolFeeRecipient ?? maker.address,
                makerReceiver,
                resolverFee,
                whitelistDiscount,
                whitelist,
                whitelistPostInteraction: exclusivity,
                customPostInteraction,
            }),
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
            const { dai, weth, lopv4, chainId, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'OrderNotAnnounced');
        });

        it('fails closed when no registrator is configured', async function () {
            const { dai, weth, lopv4, chainId, registrator, bareSettlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({ dai, weth, settlement: bareSettlement, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
            const sig = await signature(order, chainId, lopv4);

            // Even an announced order cannot anchor to a registrator the settlement does not have.
            await announce(registrator, order);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(bareSettlement, 'OrderNotAnnounced');
        });

        it('starts the auction at the announcement however stale the built start time is', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
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
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const startTime = await time.latest() + 1000;
            const params = { ...anchoredParams, startTime };
            const order = await buildAnchoredOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(params) });
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
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
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
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({ dai, weth, settlement, auctionDetails: buildAnchoredAuctionDetails(anchoredParams) });
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

    describe('announcement-anchored exclusivity', function () {
        const auctionParams = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true };

        it('holds the exclusive window open relative to the announcement', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 30,
                    whitelist: [{ address: taker.address }],
                }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 29);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('makes a resolver outside the whitelist wait out every window', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
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
                .to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT, { from: otherResolver }))
                .to.changeTokenBalances(dai, [otherResolver, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('keeps a built allowed time that is later than the anchored one', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const allowedTime = await time.latest() + 100;
            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
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
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(allowedTime);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('staggers two whitelisted resolvers by their deltas', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
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
                .to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 16);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n))
                .to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n, { from: otherResolver }))
                .to.changeTokenBalances(dai, [otherResolver, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);
        });

        it('gates everyone by the anchored time when the whitelist is empty', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({ allowedTimeDelay: 30, whitelist: [] }),
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 29);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT, -MAKING_AMOUNT]);
        });

        it('stops fills once the announcement deadline has passed', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
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
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT / 2n)).to.be.revertedWithCustomError(settlement, 'AuctionExpired');
        });

        it('passes the fill on to the next post-interaction', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const customExtension = await deployContract('CustomExtension');

            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({ allowedTimeDelay: 0, whitelist: [{ address: taker.address }] }),
                customPostInteraction: ethers.solidityPacked(['address', 'bytes'], [await customExtension.getAddress(), '0xdeadbeef']),
            });
            const sig = await signature(order, chainId, lopv4);
            await announce(registrator, order);

            await expect(fill(lopv4, order, sig, MAKING_AMOUNT))
                .to.emit(customExtension, 'CustomPostInteractionData')
                .withArgs('0xdeadbeef');
        });

        it('enforces the anchored window behind a custom receiver', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            // A custom receiver shifts FeeTaker's post-interaction layout by 20 bytes; the anchored
            // walk must still find the whitelist blob behind it.
            const resolverFee = 1000n; // 1% in 1e5
            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
                auctionDetails: buildAnchoredAuctionDetails({ startTime: 0, duration: 100, initialRateBump: 0, anchored: true }),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 30,
                    whitelist: [{ address: taker.address }],
                }),
                receiver: await settlement.getAddress(),
                makerReceiver: charlie.address,
                resolverFee,
                whitelistDiscount: 100,
                whitelist: '0x01' + taker.address.slice(-20),
                protocolFeeRecipient: otherResolver.address,
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            await time.setNextBlockTimestamp(announcedAt + 29);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await time.setNextBlockTimestamp(announcedAt + 30);
            const withFee = ceilDiv(TAKING_AMOUNT * (100000n + resolverFee), 100000n);
            const feeAmount = withFee * resolverFee / (100000n + resolverFee);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT))
                .to.changeTokenBalances(weth, [taker, charlie, otherResolver], [-withFee, withFee - feeAmount, feeAmount]);
        });
    });

    describe('fees on the anchored curve', function () {
        it('prices the anchored auction with the resolver fee on top, exclusivity intact', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const resolverFee = 1000n; // 1% in 1e5
            const auctionParams = { startTime: 0, duration: 100, initialRateBump: Number(HALF_PERCENT), anchored: true };
            const order = await buildAnchoredOrder({
                dai,
                weth,
                settlement,
                auctionDetails: buildAnchoredAuctionDetails(auctionParams),
                exclusivity: buildAnchoredExclusivity({
                    allowedTimeDelay: 30,
                    whitelist: [{ address: taker.address }],
                }),
                receiver: await settlement.getAddress(),
                resolverFee,
                whitelistDiscount: 100,
                whitelist: '0x01' + taker.address.slice(-20),
                protocolFeeRecipient: otherResolver.address,
            });
            const sig = await signature(order, chainId, lopv4);
            const announcedAt = await announce(registrator, order);

            // The exclusivity window still bites even though the taker is whitelisted for fees.
            await time.setNextBlockTimestamp(announcedAt + 20);
            await expect(fill(lopv4, order, sig, MAKING_AMOUNT)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            const fillTime = announcedAt + 60;
            await time.setNextBlockTimestamp(fillTime);
            const fillTx = fill(lopv4, order, sig, MAKING_AMOUNT / 2n);

            // The price is the fee applied to the base ratio, then the anchored curve on top of it.
            const bump = auctionBumpAt(fillTime, { ...auctionParams, startTime: announcedAt });
            const unbumpedWithFee = ceilDiv(ceilDiv(TAKING_AMOUNT * (MAKING_AMOUNT / 2n), MAKING_AMOUNT) * (100000n + resolverFee), 100000n);
            const takingAmount = ceilDiv(unbumpedWithFee * (BASE_POINTS + bump), BASE_POINTS);
            const feeAmount = takingAmount * resolverFee / (100000n + resolverFee);
            await expect(fillTx).to.changeTokenBalances(weth, [taker, maker, otherResolver], [-takingAmount, takingAmount - feeAmount, feeAmount]);
            await expect(fillTx).to.changeTokenBalances(dai, [taker, maker], [MAKING_AMOUNT / 2n, -MAKING_AMOUNT / 2n]);
        });
    });

    describe('gas', function () {
        it('reports the anchored fill overhead against a legacy fill', async function () {
            const { dai, weth, lopv4, chainId, registrator, settlement } = await loadFixture(deployContractsAndInit);

            const params = { duration: 100, initialRateBump: Number(HALF_PERCENT) };

            async function measure({ auctionDetails, exclusivity, anchored, makingAmount = ether('10') }) {
                const order = buildOrder(
                    {
                        maker: maker.address,
                        makerAsset: await dai.getAddress(),
                        takerAsset: await weth.getAddress(),
                        makingAmount,
                        takingAmount: TAKING_AMOUNT * makingAmount / MAKING_AMOUNT,
                    },
                    buildSettlementExtensions({
                        feeTaker: await settlement.getAddress(),
                        estimatedTakingAmount: TAKING_AMOUNT * makingAmount / MAKING_AMOUNT,
                        getterExtraPrefix: auctionDetails,
                        whitelistPostInteraction: exclusivity,
                    }),
                );
                const sig = await signature(order, chainId, lopv4);
                if (anchored) {
                    await announce(registrator, order);
                }
                const receipt = await (await fill(lopv4, order, sig, makingAmount)).wait();
                return receipt.gasUsed;
            }

            // Warm-up fill: pays the zero-to-nonzero balance writes so the measured fills all
            // write already-touched balance slots and differ only by settlement logic.
            await measure({
                auctionDetails: buildAnchoredAuctionDetails({ ...params, startTime: await time.latest() }),
                exclusivity: buildAnchoredExclusivity({}),
                makingAmount: ether('1'),
            });

            const legacy = await measure({
                auctionDetails: buildAnchoredAuctionDetails({ ...params, startTime: await time.latest() }),
                exclusivity: buildAnchoredExclusivity({}),
            });
            const anchored = await measure({
                auctionDetails: buildAnchoredAuctionDetails({ ...params, anchored: true }),
                exclusivity: buildAnchoredExclusivity({ allowedTimeDelay: 0 }),
                anchored: true,
            });

            console.log(`        legacy encoding fill:        ${legacy} gas`);
            console.log(`        anchored, announcement read: ${anchored} gas (+${anchored - legacy})`);

            // The anchored fill pays for the registrator call, not for an extension hop.
            expect(anchored - legacy).to.be.lessThan(10000n);
        });
    });

    describe('parity with the legacy encoding', function () {
        it('prices an anchored order announced before its built start exactly as the legacy blob', async function () {
            const { dai, weth, lopv4, registrator, settlement } = await loadFixture(deployContractsAndInit);

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
            const order = buildOrder({
                maker: maker.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: MAKING_AMOUNT,
                takingAmount: TAKING_AMOUNT,
            });
            const orderHash = await lopv4.hashOrder(order);
            const legacyExtraData = ethers.solidityPacked(['bytes', 'bytes'], [buildAnchoredAuctionDetails(params), NO_FEE_DATA]);
            const anchoredExtraData = ethers.solidityPacked(['bytes', 'bytes'], [buildAnchoredAuctionDetails({ ...params, anchored: true }), NO_FEE_DATA]);

            // Announced before the built start, the anchored auction keeps the built start — its curve
            // must be the legacy one at every point of the timeline.
            await registrator.registerOrder(order);
            expect(await time.latest()).to.be.lessThan(params.startTime);

            // Before the auction, at each of its points, between them, and after it has finished.
            for (const offset of [-10, 0, 15, 30, 45, 60, 120, 199, 200, 500]) {
                await time.setNextBlockTimestamp(params.startTime + offset);
                await hre.network.provider.send('evm_mine');

                for (const amount of [MAKING_AMOUNT, MAKING_AMOUNT / 3n]) {
                    const args = [order, order.extension, orderHash, taker.address, amount, MAKING_AMOUNT];
                    expect(await settlement.getTakingAmount(...args, anchoredExtraData))
                        .to.equal(await settlement.getTakingAmount(...args, legacyExtraData));
                    expect(await settlement.getMakingAmount(...args, anchoredExtraData))
                        .to.equal(await settlement.getMakingAmount(...args, legacyExtraData));
                }
            }
        });
    });
});
