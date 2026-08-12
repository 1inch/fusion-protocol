const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { expect, ether, constants } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails, buildCalldataForOrder } = require('./helpers/fusionUtils');

describe('WhitelistChecker', function () {
    describe('should not work with non-whitelisted address without accessToken', function () {
        it('whitelist check in postInteraction method', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
            const {
                contracts: { dai, weth, accessToken, resolver, settlement },
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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
            });

            await accessToken.burn(resolver, 1);
            await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'OnlyWhitelistOrAccessToken');
        });

        it('only resolver can use takerInteraction method', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
            const {
                contracts: { dai, weth, resolver, settlement, lopv4 },
                accounts: { alice },
            } = setupData;

            // Deploy another resolver
            const ResolverMock = await ethers.getContractFactory('ResolverMock');
            const fakeResolver = await ResolverMock.deploy(settlement, lopv4);

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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
            });

            // try to make txn from fakeResolver
            await expect(fakeResolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(resolver, 'NotTaker');
        });

        it('only LOP can use takerInteraction method', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const {
                contracts: { dai, weth, resolver, lopv4 },
                accounts: { alice },
            } = dataFormFixture;

            const order = buildOrder({
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('0.1'),
            });
            const orderHash = await lopv4.hashOrder(order);

            await expect(resolver.takerInteraction(order, '0x', orderHash, alice.address, '0', '0', '0', '0x'))
                .to.be.revertedWithCustomError(resolver, 'OnlyLOP');
        });
    });

    describe('should work with whitelisted address without accessToken', function () {
        it('whitelist check in settleOrders method', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
                whitelistResolvers: ['0x' + resolver.target.substring(22)],
            });

            await accessToken.burn(resolver, 1);
            const txn = await resolver.settleOrders(fillOrderToData);
            await expect(txn).to.changeTokenBalances(dai, [alice, resolver], [ether('-100'), ether('100')]);
            await expect(txn).to.changeTokenBalances(weth, [alice, resolver], [ether('0.1'), ether('-0.1')]);
        });

        it('fill before auctionStartTime', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
            const {
                contracts: { dai, weth, accessToken, resolver, settlement },
                accounts: { alice },
            } = setupData;
            setupData.auction.startTime = '0x7fffffff'; // far future, without the top bit that now means an anchored order

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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
                whitelistResolvers: ['0x' + resolver.target.substring(22)],
            });

            await accessToken.burn(resolver, 1);
            await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');
        });
    });

    describe('should work with non-whitelisted address with accessToken', function () {
        it('whitelist check in settleOrders method', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
                whitelistData: '0x' + constants.ZERO_ADDRESS.substring(22),
            });

            const txn = await resolver.settleOrders(fillOrderToData);
            await expect(txn).to.changeTokenBalances(dai, [alice, resolver], [ether('-100'), ether('100')]);
            await expect(txn).to.changeTokenBalances(weth, [alice, resolver], [ether('0.1'), ether('-0.1')]);
        });

        it('fill before auctionStartTime', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
            const {
                contracts: { dai, weth, resolver, settlement },
                accounts: { alice },
            } = setupData;
            setupData.auction.startTime = '0x7fffffff'; // far future, without the top bit that now means an anchored order

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
                minReturn: ether('0.1'),
                isInnermostOrder: true,
            });

            await expect(resolver.settleOrders(fillOrderToData)).to.be.revertedWithCustomError(settlement, 'AllowedTimeViolation');
        });
    });
});
