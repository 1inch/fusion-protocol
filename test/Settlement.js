const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { time, expect, ether, trim0x, timeIncreaseTo, getPermit, getPermit2, compressPermit, permit2Contract, deployContract } = require('@1inch/solidity-utils');
const { buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails, buildCalldataForOrder } = require('./helpers/fusionUtils');

const ORDER_FEE = 100n;
const BACK_ORDER_FEE = 125n;
const FEE_BASE = 100000n;

describe('Settlement', function () {
    it('opposite direction recursive swap', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice },
        } = setupData;

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('100'),
            isInnermostOrder: true,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.1'),
            additionalDataForSettlement: fillOrderToData1,
        });

        const txn = await resolver.settleOrders(fillOrderToData0);
        await expect(txn).to.changeTokenBalances(dai, [owner, alice, resolver], [ether('-100'), ether('100'), ether('0')]);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice, resolver], [ether('0.1'), ether('-0.11'), ether('0.01')]);
    });

    it('settle orders with permits, permit', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, lopv4, resolver },
            accounts: { owner, alice },
            others: { chainId },
        } = setupData;

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('100'),
            isInnermostOrder: true,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.1'),
            additionalDataForSettlement: fillOrderToData1,
        });

        await weth.connect(alice).approve(lopv4, ether('0.11'));
        await dai.connect(owner).approve(lopv4, 0n); // remove direct approve
        const permit0 = compressPermit(await getPermit(owner, dai, '1', chainId, await lopv4.getAddress(), ether('100')));
        const packing = (1n << 248n) | 1n;
        const txn = await resolver.settleOrdersWithPermits(fillOrderToData0, packing,
            owner.address + trim0x(await dai.getAddress()) + trim0x(permit0));
        await expect(txn).to.changeTokenBalances(dai, [owner, alice, resolver], [ether('-100'), ether('100'), ether('0')]);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice, resolver], [ether('0.1'), ether('-0.11'), ether('0.01')]);
    });

    it('settle orders with permits, permit2', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, lopv4, resolver },
            accounts: { owner, alice },
            others: { chainId },
        } = setupData;

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits({ usePermit2: true }),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('100'),
            isInnermostOrder: true,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits({ usePermit2: true }),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.1'),
            additionalDataForSettlement: fillOrderToData1,
        });

        const permit2 = await permit2Contract();
        await dai.approve(permit2, ether('100'));
        await weth.connect(alice).approve(permit2, ether('0.11'));
        await dai.connect(owner).approve(lopv4, 0n); // remove direct approve
        await weth.connect(alice).approve(lopv4, 0n); // remove direct approve
        const permit0 = compressPermit(await getPermit2(owner, await dai.getAddress(), chainId, await lopv4.getAddress(), ether('100')));
        const permit1 = compressPermit(await getPermit2(alice, await weth.getAddress(), chainId, await lopv4.getAddress(), ether('0.11')));
        const packing = (2n << 248n) | 2n | 8n;
        const txn = await resolver.settleOrdersWithPermits(fillOrderToData0, packing,
            owner.address + trim0x(await dai.getAddress()) + trim0x(permit0) + trim0x(alice.address) + trim0x(await weth.getAddress()) + trim0x(permit1));
        await expect(txn).to.changeTokenBalances(dai, [owner, alice, resolver], [ether('-100'), ether('100'), ether('0')]);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice, resolver], [ether('0.1'), ether('-0.11'), ether('0.01')]);
    });

    it('opposite direction recursive swap with taking fee', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice, bob, charlie },
        } = setupData;

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('101'),
            isInnermostOrder: true,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
            integratorFee: 100,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100.1'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.11'),
            additionalDataForSettlement: fillOrderToData1,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
            integratorFee: 100,
        });

        const txn = await resolver.settleOrders(fillOrderToData0);
        await expect(txn).to.changeTokenBalances(dai, [owner, alice, bob, charlie], [ether('-100.1'), ether('100'), ether('0.05'), ether('0.05')]);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice, bob, charlie, resolver], [ether('0.1'), ether('-0.11'), ether('0.00005'), ether('0.00005'), ether('0.0099')]);
    });

    it('unidirectional recursive swap', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice },
            others: { abiCoder },
        } = setupData;

        const resolverArgs = abiCoder.encode(
            ['address[]', 'bytes[]'],
            [
                [await weth.getAddress()],
                [
                    weth.interface.encodeFunctionData('transferFrom', [
                        owner.address,
                        await resolver.getAddress(),
                        ether('0.025'),
                    ]),
                ],
            ],
        );

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('15'),
                takingAmount: ether('0.015'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('15'),
            additionalDataForSettlement: resolverArgs,
            isInnermostOrder: true,
            isMakingAmount: false,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('10'),
                takingAmount: ether('0.01'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('10'),
            additionalDataForSettlement: fillOrderToData1,
            isMakingAmount: false,
        });

        await weth.approve(resolver, ether('0.025'));

        const txn = await resolver.settleOrders(fillOrderToData0);
        await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('25'), ether('-25')]);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.025'), ether('0.025')]);
    });

    it('opposite direction recursive swap with resolverFee and integratorFee', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice, bob, charlie },
        } = setupData;

        const INTEGRATOR_FEE = 115n;
        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('101'),
            isInnermostOrder: true,
            resolverFee: BACK_ORDER_FEE,
            integratorFee: INTEGRATOR_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100.24'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.11'),
            additionalDataForSettlement: fillOrderToData1,
            resolverFee: ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const tx = await resolver.settleOrders(fillOrderToData0);

        await expect(tx).to.changeTokenBalances(dai, [owner, alice, bob, charlie], [ether('-100.24'), ether('100'), ether('0.115') / 2n, ether('0.125') + ether('0.115') / 2n]);
        await expect(tx).to.changeTokenBalances(weth, [owner, alice, bob, charlie, resolver], [ether('0.1'), ether('-0.11'), 0, ether('0.0001'), ether('0.0099')]);
    });

    it('opposite direction recursive swap with resolverFee and integratorFee and custom receiver', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice, bob, charlie },
        } = setupData;

        const [,,,, aliceReciever, ownerReciever] = await ethers.getSigners();

        const INTEGRATOR_FEE = 115n;
        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                receiver: aliceReciever.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('101'),
            isInnermostOrder: true,
            integratorFee: INTEGRATOR_FEE,
            resolverFee: BACK_ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                receiver: ownerReciever.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100.24'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.11'),
            additionalDataForSettlement: fillOrderToData1,
            resolverFee: ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const tx = await resolver.settleOrders(fillOrderToData0);

        await expect(tx).to.changeTokenBalances(dai, [owner, aliceReciever, bob, charlie], [ether('-100.24'), ether('100'), ether('0.115') / 2n, ether('0.125') + ether('0.115') / 2n]);
        await expect(tx).to.changeTokenBalances(weth, [alice, ownerReciever, bob, charlie, resolver], [ether('-0.11'), ether('0.1'), 0, ether('0.0001'), ether('0.0099')]);
    });

    it('opposite direction recursive swap with resolverFee and integratorFee and custom receiver and weth unwrapping', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice, bob, charlie },
        } = setupData;

        const [,,,, aliceReciever, ownerReciever] = await ethers.getSigners();

        const INTEGRATOR_FEE = 115n;
        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                receiver: aliceReciever.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.11'),
                takingAmount: ether('100'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('101'),
            isInnermostOrder: true,
            resolverFee: BACK_ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                receiver: ownerReciever.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100.125'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits({ unwrapWeth: true }),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.11'),
            additionalDataForSettlement: fillOrderToData1,
            integratorFee: INTEGRATOR_FEE,
            resolverFee: ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const tx = await resolver.settleOrders(fillOrderToData0);

        await expect(tx).to.changeTokenBalances(dai, [owner, aliceReciever, bob, charlie], [ether('-100.125'), ether('100'), 0, ether('0.125')]);
        await expect(tx).to.changeTokenBalances(weth, [alice, ownerReciever, bob, charlie, resolver], [ether('-0.11'), 0, 0, 0, ether('0.009785')]);
        await expect(tx).to.changeEtherBalances([alice, ownerReciever, bob, charlie], [0, ether('0.1'), ether('0.000115') / 2n, ether('0.0001') + ether('0.000115') / 2n]);
    });

    it('triple recursive swap', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice },
        } = setupData;

        const fillOrderToData2 = await buildCalldataForOrder({
            orderData: {
                maker: owner.address,
                makerAsset: await weth.getAddress(),
                takerAsset: await dai.getAddress(),
                makingAmount: ether('0.025'),
                takingAmount: ether('25'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: owner,
            setupData,
            threshold: ether('0.025'),
            isInnermostOrder: true,
            isMakingAmount: false,
        });

        const fillOrderToData1 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('15'),
                takingAmount: ether('0.015'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('15'),
            additionalDataForSettlement: fillOrderToData2,
            isMakingAmount: false,
        });

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('10'),
                takingAmount: ether('0.01'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('10'),
            additionalDataForSettlement: fillOrderToData1,
            isMakingAmount: false,
        });

        const txn = await resolver.settleOrders(fillOrderToData0);
        await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.025'), ether('0.025')]);
        await expect(txn).to.changeTokenBalances(dai, [owner, alice], [ether('25'), ether('-25')]);
    });

    describe('dutch auction params', function () {
        const prepareSingleOrder = async ({
            setupData,
            targetTakingAmount = 0n,
            estimatedTakingAmount = ether('0.1'),
            protocolSurplusFee = 0n,
            threshold = ether('100'),
            protocolFeeRecipient = setupData.accounts.alice.address,
        }) => {
            const {
                contracts: { dai, weth, resolver },
                accounts: { owner, alice },
                others: { abiCoder },
            } = setupData;

            const resolverCalldata = abiCoder.encode(
                ['address[]', 'bytes[]'],
                [
                    [await weth.getAddress()],
                    [
                        weth.interface.encodeFunctionData('transferFrom', [
                            owner.address,
                            await resolver.getAddress(),
                            targetTakingAmount,
                        ]),
                    ],
                ],
            );

            const fillOrderToData = await buildCalldataForOrder({
                orderData: {
                    maker: alice.address,
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: ether('100'),
                    takingAmount: ether('0.1'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: alice,
                setupData,
                threshold,
                additionalDataForSettlement: resolverCalldata,
                isInnermostOrder: true,
                isMakingAmount: false,
                fillingAmount: targetTakingAmount,
                estimatedTakingAmount,
                protocolSurplusFee,
                protocolFeeRecipient,
            });

            await weth.approve(resolver, targetTakingAmount);
            return fillOrderToData;
        };

        it('matching order at first second has maximal rate bump', async function () {
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
            };
            const {
                contracts: { dai, weth, resolver },
                accounts: { owner, alice },
            } = setupData;

            const fillOrderToData = await prepareSingleOrder({
                setupData,
                targetTakingAmount: ether('0.11'),
            });

            await time.setNextBlockTimestamp(setupData.auction.startTime);
            const txn = await resolver.settleOrders(fillOrderToData);
            await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
            await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.11'), ether('0.11')]);
        });

        describe('order with one bump point', async function () {
            it('matching order equal to bump point', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ points: [[900000, 240]] }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice },
                } = setupData;

                const fillOrderToData = await prepareSingleOrder({
                    targetTakingAmount: ether('0.109'),
                    setupData,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime + 240);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.109'), ether('0.109')]);
            });

            it('matching order before bump point', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ initialRateBump: 1000000n, points: [[900000, 240]] }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice },
                } = setupData;

                const fillOrderToData = await prepareSingleOrder({
                    targetTakingAmount: ether('0.1095'), // 1/2 * (takingAmount * 10%) + 1/2 * (takingAmount * 9%)
                    setupData,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime + 240 / 2);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.1095'), ether('0.1095')]);
            });

            it('matching order after bump point', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ points: [[900000, 240]] }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice },
                } = setupData;

                const fillOrderToData = await prepareSingleOrder({
                    targetTakingAmount: ether('0.106'),
                    setupData,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime + 760);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.106'), ether('0.106')]);
            });

            it('matching order between 2 bump point', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ points: [[500000, 240], [100000, 1240]] }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice },
                } = setupData;

                const fillOrderToData = await prepareSingleOrder({
                    targetTakingAmount: ether('0.103'),
                    setupData,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime + 860);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.103'), ether('0.103')]);
            });
        });

        it('set initial rate', async function () {
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 2000000n }),
            };
            const {
                contracts: { dai, weth, resolver },
                accounts: { owner, alice },
            } = setupData;

            const fillOrderToData = await prepareSingleOrder({
                setupData,
                targetTakingAmount: ether('0.12'),
            });

            await time.setNextBlockTimestamp(setupData.auction.startTime);
            const txn = await resolver.settleOrders(fillOrderToData);
            await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
            await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.12'), ether('0.12')]);
        });

        it('set auctionDuration', async function () {
            const now = await time.latest() + 10;
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails({ startTime: now - 450, duration: 900, initialRateBump: 1000000n }),
            };
            const {
                contracts: { dai, weth, resolver },
                accounts: { owner, alice },
            } = setupData;

            const fillOrderToData = await prepareSingleOrder({
                setupData,
                targetTakingAmount: ether('0.105'),
            });

            await time.setNextBlockTimestamp(now);
            const txn = await resolver.settleOrders(fillOrderToData);
            await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
            await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.105'), ether('0.105')]);
        });

        describe('registered auction start', function () {
            it('starts auction from registeredAt when it is later than signed start', async function () {
                const base = await loadFixture(initContractsForSettlement);
                const registrator = await deployContract('OrderRegistratorMock');
                const signedStart = await time.latest() - 1000; // auction would already be finished
                const setupData = {
                    ...base,
                    auction: await buildAuctionDetails({
                        startTime: signedStart,
                        duration: 900,
                        initialRateBump: 1000000n,
                        orderRegistrator: await registrator.getAddress(),
                    }),
                };
                const {
                    contracts: { dai, weth, lopv4, resolver },
                    accounts: { owner, alice },
                    others: { abiCoder },
                } = setupData;

                const resolverCalldata = abiCoder.encode(
                    ['address[]', 'bytes[]'],
                    [
                        [await weth.getAddress()],
                        [
                            weth.interface.encodeFunctionData('transferFrom', [
                                owner.address,
                                await resolver.getAddress(),
                                ether('0.11'),
                            ]),
                        ],
                    ],
                );

                const { calldata: fillOrderToData, order } = await buildCalldataForOrder({
                    orderData: {
                        maker: alice.address,
                        makerAsset: await dai.getAddress(),
                        takerAsset: await weth.getAddress(),
                        makingAmount: ether('100'),
                        takingAmount: ether('0.1'),
                        makerTraits: buildMakerTraits(),
                    },
                    orderSigner: alice,
                    setupData,
                    threshold: ether('100'),
                    additionalDataForSettlement: resolverCalldata,
                    isInnermostOrder: true,
                    isMakingAmount: false,
                    fillingAmount: ether('0.11'),
                    returnOrder: true,
                });

                const orderHash = await lopv4.hashOrder(order);
                const registeredAt = await time.latest() + 10;
                await registrator.setRegisteredAt(orderHash, registeredAt);

                await weth.approve(resolver, ether('0.11'));
                await time.setNextBlockTimestamp(registeredAt);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.11'), ether('0.11')]);
            });

            it('keeps signed start when registeredAt is earlier', async function () {
                const base = await loadFixture(initContractsForSettlement);
                const registrator = await deployContract('OrderRegistratorMock');
                const signedStart = await time.latest() + 100;
                const setupData = {
                    ...base,
                    auction: await buildAuctionDetails({
                        startTime: signedStart,
                        delay: 0,
                        duration: 900,
                        initialRateBump: 1000000n,
                        orderRegistrator: await registrator.getAddress(),
                    }),
                };
                const {
                    contracts: { dai, weth, lopv4, resolver },
                    accounts: { owner, alice },
                    others: { abiCoder },
                } = setupData;

                const resolverCalldata = abiCoder.encode(
                    ['address[]', 'bytes[]'],
                    [
                        [await weth.getAddress()],
                        [
                            weth.interface.encodeFunctionData('transferFrom', [
                                owner.address,
                                await resolver.getAddress(),
                                ether('0.11'),
                            ]),
                        ],
                    ],
                );

                const { calldata: fillOrderToData, order } = await buildCalldataForOrder({
                    orderData: {
                        maker: alice.address,
                        makerAsset: await dai.getAddress(),
                        takerAsset: await weth.getAddress(),
                        makingAmount: ether('100'),
                        takingAmount: ether('0.1'),
                        makerTraits: buildMakerTraits(),
                    },
                    orderSigner: alice,
                    setupData,
                    threshold: ether('100'),
                    additionalDataForSettlement: resolverCalldata,
                    isInnermostOrder: true,
                    isMakingAmount: false,
                    fillingAmount: ether('0.11'),
                    returnOrder: true,
                });

                const orderHash = await lopv4.hashOrder(order);
                await registrator.setRegisteredAt(orderHash, signedStart - 50);

                await weth.approve(resolver, ether('0.11'));
                await time.setNextBlockTimestamp(signedStart);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.11'), ether('0.11')]);
            });

            it('uses signed start when order is not registered', async function () {
                const base = await loadFixture(initContractsForSettlement);
                const registrator = await deployContract('OrderRegistratorMock');
                const setupData = {
                    ...base,
                    auction: await buildAuctionDetails({
                        startTime: await time.latest() + 10,
                        delay: 60,
                        initialRateBump: 1000000n,
                        orderRegistrator: await registrator.getAddress(),
                    }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice },
                } = setupData;

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: ether('0.11'),
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice], [ether('-0.11'), ether('0.11')]);
            });
        });

        describe('checking surplus', async function () {
            it('should get surplus', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice, bob },
                } = setupData;

                const estimatedTakingAmount = ether('0.1');
                const surplus = ether('0.01');

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: estimatedTakingAmount + surplus,
                    estimatedTakingAmount,
                    protocolSurplusFee: 50,
                    protocolFeeRecipient: bob.address,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice, bob], [
                    -estimatedTakingAmount - surplus,
                    estimatedTakingAmount + surplus / 2n,
                    surplus / 2n,
                ]);
            });

            it('should get surplus for partial fill', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice, bob },
                } = setupData;

                const estimatedTakingAmount = ether('0.1');
                const surplus = ether('0.005');

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: estimatedTakingAmount / 2n + surplus,
                    estimatedTakingAmount,
                    threshold: ether('50'), //
                    protocolSurplusFee: 50,
                    protocolFeeRecipient: bob.address,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('50'), ether('-50')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice, bob], [
                    -estimatedTakingAmount / 2n - surplus,
                    estimatedTakingAmount / 2n + surplus / 2n,
                    surplus / 2n,
                ]);
            });

            it('should get surplus = 0, if estimatedTakingAmount < actualAmount', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
                };
                const {
                    contracts: { dai, weth, resolver },
                    accounts: { owner, alice, bob },
                } = setupData;

                const estimatedTakingAmount = ether('0.11');

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: estimatedTakingAmount,
                    estimatedTakingAmount,
                    protocolSurplusFee: 50,
                    protocolFeeRecipient: bob.address,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                const txn = await resolver.settleOrders(fillOrderToData);
                await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
                await expect(txn).to.changeTokenBalances(weth, [owner, alice, bob], [-estimatedTakingAmount, estimatedTakingAmount, ether('0')]);
            });

            it('should failed if protocolSurplusFee > 100', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
                };
                const {
                    contracts: { resolver, settlement },
                    accounts: { bob },
                } = setupData;

                const estimatedTakingAmount = ether('0.1');
                const surplus = ether('0.01');

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: estimatedTakingAmount + surplus,
                    estimatedTakingAmount,
                    protocolSurplusFee: 101,
                    protocolFeeRecipient: bob.address,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'InvalidProtocolSurplusFee');
            });

            it('should failed if estimatedTakingAmount < order.takingAmount', async function () {
                const setupData = {
                    ...await loadFixture(initContractsForSettlement),
                    auction: await buildAuctionDetails({ startTime: await time.latest() + 10, delay: 60, initialRateBump: 1000000n }),
                };
                const {
                    contracts: { resolver, settlement },
                    accounts: { bob },
                } = setupData;

                const estimatedTakingAmount = ether('0.1');
                const surplus = ether('0.01');

                const fillOrderToData = await prepareSingleOrder({
                    setupData,
                    targetTakingAmount: estimatedTakingAmount + surplus,
                    estimatedTakingAmount: estimatedTakingAmount - 1n,
                    protocolSurplusFee: 50,
                    protocolFeeRecipient: bob.address,
                });

                await time.setNextBlockTimestamp(setupData.auction.startTime);
                await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'InvalidEstimatedTakingAmount');
            });
        });
    });

    it('partial fill with taking fee', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { owner, alice, bob, charlie },
            others: { abiCoder },
        } = setupData;

        const partialModifier = 40n;
        const points = 100n;

        const resolverArgs = abiCoder.encode(
            ['address[]', 'bytes[]'],
            [
                [await weth.getAddress()],
                [
                    weth.interface.encodeFunctionData('transferFrom', [
                        owner.address,
                        await resolver.getAddress(),
                        ether('0.01') * partialModifier / points * (ORDER_FEE + FEE_BASE) / FEE_BASE,
                    ]),
                ],
            ],
        );

        const fillOrderToData0 = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('10'),
                takingAmount: ether('0.01'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('0.011') * partialModifier / points,
            additionalDataForSettlement: resolverArgs,
            isInnermostOrder: true,
            fillingAmount: ether('10') * partialModifier / points,
            resolverFee: ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        await weth.approve(resolver, ether('0.01'));

        const txn = await resolver.settleOrders(fillOrderToData0);
        await expect(txn).to.changeTokenBalances(dai, [resolver, alice], [ether('10') * partialModifier / points, ether('-10') * partialModifier / points]);
        await expect(txn).to.changeTokenBalances(
            weth,
            [owner, alice, bob, charlie],
            [
                ether('-0.01') * partialModifier / points * (ORDER_FEE + FEE_BASE) / FEE_BASE,
                ether('0.01') * partialModifier / points,
                0,
                ether('0.01') * partialModifier / points * ORDER_FEE / FEE_BASE,
            ],
        );
    });

    it('should not pay resolver fee when whitelisted address and it has accessToken', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { alice },
        } = setupData;

        weth.transfer(resolver, ether('0.1'));

        const fillOrderToData = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('0.1'),
            isInnermostOrder: true,
            resolverFee: ORDER_FEE,
            whitelistResolvers: ['0x' + resolver.target.substring(22)],
        });

        const txn = await resolver.settleOrders(fillOrderToData);
        await expect(txn).to.changeTokenBalances(dai, [alice, resolver], [ether('-100'), ether('100')]);
        await expect(txn).to.changeTokenBalances(weth, [alice, resolver], [ether('0.1'), ether('-0.1')]);
    });

    it('should not pay resolver fee when whitelisted address and it has not accessToken', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, accessToken, resolver },
            accounts: { alice },
        } = setupData;

        weth.transfer(resolver, ether('0.1'));

        const fillOrderToData = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('0.1'),
            isInnermostOrder: true,
            resolverFee: ORDER_FEE,
            whitelistResolvers: ['0x' + resolver.target.substring(22)],
        });

        await accessToken.burn(resolver, 1);

        const txn = await resolver.settleOrders(fillOrderToData);
        await expect(txn).to.changeTokenBalances(dai, [alice, resolver], [ether('-100'), ether('100')]);
        await expect(txn).to.changeTokenBalances(weth, [alice, resolver], [ether('0.1'), ether('-0.1')]);
    });

    it('should pay resolver fee when non-whitelisted address and it has accessToken', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, resolver },
            accounts: { alice, bob, charlie },
        } = setupData;

        weth.transfer(resolver, ether('0.1001'));

        const fillOrderToData = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('0.11'),
            isInnermostOrder: true,
            resolverFee: ORDER_FEE,
            integratorFeeRecipient: bob.address,
            protocolFeeRecipient: charlie.address,
        });

        const txn = await resolver.settleOrders(fillOrderToData);
        await expect(txn).to.changeTokenBalances(dai, [alice, resolver], [ether('-100'), ether('100')]);
        await expect(txn).to.changeTokenBalances(weth, [alice, resolver, bob, charlie], [ether('0.1'), ether('-0.1001'), 0, ether('0.0001')]);
    });

    it('should revert when non-whitelisted address and it has not accessToken', async function () {
        const setupData = {
            ...await loadFixture(initContractsForSettlement),
            auction: await buildAuctionDetails(),
        };
        const {
            contracts: { dai, weth, accessToken, resolver, settlement },
            accounts: { alice },
        } = setupData;

        weth.transfer(resolver, ether('0.1001'));

        const fillOrderToData = await buildCalldataForOrder({
            orderData: {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
                makerTraits: buildMakerTraits(),
            },
            orderSigner: alice,
            setupData,
            threshold: ether('0.11'),
            isInnermostOrder: true,
            resolverFee: ORDER_FEE,
        });

        await accessToken.burn(resolver, 1);
        await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'OnlyWhitelistOrAccessToken');
    });

    describe('whitelist lock period', async function () {
        it('should change only after whitelistedCutOff without accessToken', async function () {
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails({ startTime: await time.latest() + time.duration.hours('3') }),
            };
            const {
                contracts: { dai, weth, accessToken, resolver, settlement },
                accounts: { owner, alice },
            } = setupData;

            const fillOrderToData1 = await buildCalldataForOrder({
                orderData: {
                    maker: alice.address,
                    makerAsset: await weth.getAddress(),
                    takerAsset: await dai.getAddress(),
                    makingAmount: ether('0.1'),
                    takingAmount: ether('100'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: alice,
                setupData,
                threshold: ether('100'),
                isInnermostOrder: true,
                whitelistResolvers: ['0x' + resolver.target.substring(22)],
            });

            const fillOrderToData0 = await buildCalldataForOrder({
                orderData: {
                    maker: owner.address,
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: ether('100'),
                    takingAmount: ether('0.1'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: owner,
                setupData,
                threshold: ether('0.1'),
                additionalDataForSettlement: fillOrderToData1,
                whitelistResolvers: ['0x' + resolver.target.substring(22)],
            });

            await expect(resolver.settleOrders(fillOrderToData0)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await timeIncreaseTo(setupData.auction.startTime + 1);

            await accessToken.burn(resolver, 1);

            await resolver.settleOrders(fillOrderToData0);
        });

        it('should change only after whitelistedCutOff with accessToken', async function () {
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails({ startTime: await time.latest() + time.duration.hours('3') }),
            };
            const {
                contracts: { dai, weth, resolver, settlement },
                accounts: { owner, alice },
            } = setupData;

            const fillOrderToData1 = await buildCalldataForOrder({
                orderData: {
                    maker: alice.address,
                    makerAsset: await weth.getAddress(),
                    takerAsset: await dai.getAddress(),
                    makingAmount: ether('0.1'),
                    takingAmount: ether('100'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: alice,
                setupData,
                threshold: ether('100'),
                isInnermostOrder: true,
            });

            const fillOrderToData0 = await buildCalldataForOrder({
                orderData: {
                    maker: owner.address,
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: ether('100'),
                    takingAmount: ether('0.1'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: owner,
                setupData,
                threshold: ether('0.1'),
                additionalDataForSettlement: fillOrderToData1,
            });

            await expect(resolver.settleOrders(fillOrderToData0)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');

            await timeIncreaseTo(setupData.auction.startTime + 1);

            await resolver.settleOrders(fillOrderToData0);
        });
    });

    describe('custom postInteraction', async function () {
        it('should call custom extension', async function () {
            const setupData = {
                ...await loadFixture(initContractsForSettlement),
                auction: await buildAuctionDetails(),
            };
            const {
                contracts: { dai, weth, resolver },
                accounts: { owner, alice },
            } = setupData;

            const customExtension = await deployContract('CustomExtension');
            const customPostInteractionData = '0x1234567890';
            const fillOrderToData1 = await buildCalldataForOrder({
                orderData: {
                    maker: alice.address,
                    makerAsset: await weth.getAddress(),
                    takerAsset: await dai.getAddress(),
                    makingAmount: ether('0.11'),
                    takingAmount: ether('100'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: alice,
                setupData,
                threshold: ether('100'),
                isInnermostOrder: true,
                customPostInteraction: await customExtension.getAddress() + trim0x(customPostInteractionData),
            });

            const fillOrderToData0 = await buildCalldataForOrder({
                orderData: {
                    maker: owner.address,
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: ether('100'),
                    takingAmount: ether('0.1'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: owner,
                setupData,
                threshold: ether('0.1'),
                additionalDataForSettlement: fillOrderToData1,
            });

            await expect(resolver.settleOrders(fillOrderToData0))
                .to.emit(customExtension, 'CustomPostInteractionData')
                .withArgs(customPostInteractionData);
        });
    });
});
