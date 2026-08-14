const fs = require('fs');
const hre = require('hardhat');
const path = require('path');
const { ethers } = hre;
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { constants, time, expect, ether, trim0x, deployContract } = require('@1inch/solidity-utils');
const { deploySwapTokens, getChainId, initContractsForSettlement } = require('./helpers/fixtures');
const { buildAuctionDetails, buildCalldataForOrder, buildSettlementExtensions } = require('./helpers/fusionUtils');
const { buildOrder: buildOrderV1, buildSalt: buildSaltV1, signOrder: signOrderV1 } = require('./helpers/orderUtilsV1');
const { buildOrder, signOrder, buildTakerTraits, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');

const RESOLVERS_NUMBER = 10;

describe('MeasureGas', function () {
    before(async function () {
        if (hre.__SOLIDITY_COVERAGE_RUNNING) { this.skip(); }
    });

    async function initContracts() {
        const [owner, alice] = await ethers.getSigners();
        const chainId = await getChainId();
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const { dai, weth, accessToken, lopv3, lopv4 } = await deploySwapTokens();

        await dai.transfer(alice, ether('100'));
        await weth.deposit({ value: ether('1') });
        await weth.connect(alice).deposit({ value: ether('1') });

        const settlementExtension = await deployContract('Settlement', [lopv4, accessToken, weth, owner, ethers.ZeroAddress]);
        const SettlementV1 = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts-v1/SettlementV1.json'), 'utf8'));
        // const settlement = await deployContract(SettlementV1.abi, [lopv3.address, inch.address]);
        const ContractFactory = await ethers.getContractFactory(SettlementV1.abi, SettlementV1.bytecode);
        const settlement = await ContractFactory.deploy(lopv3, weth);

        const resolversV1 = [];
        const ResolverV1Mock = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts-v1/ResolverV1Mock.json'), 'utf8'));
        for (let i = 0; i < RESOLVERS_NUMBER; i++) {
            const ResolverMockFactory = await ethers.getContractFactory(ResolverV1Mock.abi, ResolverV1Mock.bytecode);
            resolversV1[i] = await ResolverMockFactory.deploy(settlement);
        }
        const ResolverMock = await ethers.getContractFactory('ResolverMock');
        const resolver = await ResolverMock.deploy(settlement, lopv4);
        await resolver.approve(dai, lopv4);
        await resolver.approve(weth, lopv4);

        return {
            contracts: { dai, weth, accessToken, lopv3, lopv4, settlement, settlementExtension, resolversV1, resolver },
            accounts: { owner, alice },
            others: { chainId, abiCoder },
        };
    }

    async function initContractsAndApproves() {
        const data = await initContracts();
        const { contracts: { dai, weth, lopv3, lopv4 }, accounts: { alice } } = data;
        for (const swap of [lopv3, lopv4]) {
            await dai.approve(swap, ether('100'));
            await dai.connect(alice).approve(swap, ether('100'));
            await weth.approve(swap, ether('1'));
            await weth.connect(alice).approve(swap, ether('1'));
        }
        return data;
    }

    describe('SettlementV1', function () {
        it('1 fill for 1 order', async function () {
            const { contracts: { dai, weth, lopv3, settlement, resolversV1 }, accounts: { owner, alice }, others: { chainId } } = await loadFixture(initContractsAndApproves);

            const makerAsset = await dai.getAddress();
            const takerAsset = await weth.getAddress();
            const makingAmount = ether('100');
            const takingAmount = ether('0.1');
            const order = await buildOrderV1(
                {
                    salt: buildSaltV1({
                        orderStartTime: await time.latest(),
                        initialStartRate: 0,
                        duration: time.duration.hours(1),
                    }),
                    makerAsset,
                    takerAsset,
                    makingAmount,
                    takingAmount,
                    from: alice.address,
                },
                {
                    whitelistedAddrs: [owner.address, ...(resolversV1.map(r => r.target))],
                    whitelistedCutOffs: [0, ...(resolversV1.map(r => 0))],
                    publicCutOff: time.duration.minutes(30),
                },
            );
            const signature = await signOrderV1(order, chainId, await lopv3.getAddress(), alice);

            const interaction =
                await settlement.getAddress() +
                '01' +
                trim0x(await resolversV1[0].getAddress()) +
                '0000000000000000000000000000000000000000000000000000000000000000' +
                '';
            await weth.transfer(resolversV1[0], takingAmount);

            const tx = await settlement.settleOrders(
                '0x' + lopv3.interface.encodeFunctionData('fillOrderTo', [
                    order,
                    signature,
                    interaction,
                    makingAmount,
                    0,
                    takingAmount,
                    await resolversV1[0].getAddress(),
                ]).substring(10),
            );
            console.log(`1 fill for 1 order gasUsed: ${(await tx.wait()).gasUsed}`);
            await expect(tx).to.changeTokenBalances(dai, [resolversV1[0], alice], [ether('100'), ether('-100')]);
            await expect(tx).to.changeTokenBalances(weth, [resolversV1[0], alice], [ether('-0.1'), ether('0.1')]);
        });

        it('1 fill for 5 orders in a batch', async function () {
            const { contracts: { dai, weth, lopv3, settlement, resolversV1 }, accounts: { alice, owner }, others: { chainId } } = await loadFixture(initContractsAndApproves);

            const resolverAddresses = resolversV1.map(r => r.target);
            const whitelistedCutOffsTmp = resolversV1.map(r => 0);

            // Build orders and compact signatures
            const orders = [];
            const signatures = [];
            for (let i = 0; i < 4; i++) {
                orders[i] = await buildOrderV1(
                    {
                        salt: buildSaltV1({
                            orderStartTime: await time.latest(),
                            initialStartRate: 0,
                            duration: time.duration.hours(1),
                        }),
                        makerAsset: await dai.getAddress(),
                        takerAsset: await weth.getAddress(),
                        makingAmount: ether((i + 1).toString()),
                        takingAmount: ether(((i + 1) / 100).toString()),
                        from: alice.address,
                    },
                    {
                        whitelistedAddrs: [owner.address, ...resolverAddresses],
                        whitelistedCutOffs: [0, ...whitelistedCutOffsTmp],
                        publicCutOff: time.duration.minutes(30),
                    },
                );
                signatures[i] = await signOrderV1(orders[i], chainId, await lopv3.getAddress(), alice);
            }
            orders[4] = await buildOrderV1(
                {
                    salt: buildSaltV1({
                        orderStartTime: await time.latest(),
                        initialStartRate: 0,
                        duration: time.duration.hours(1),
                    }),
                    makerAsset: await weth.getAddress(),
                    takerAsset: await dai.getAddress(),
                    makingAmount: ether('0.11'), // takingAmount/100 * 1.1
                    takingAmount: ether('1'), // (max_i - 1) * max_i / 2
                    from: owner.address,
                },
                {
                    whitelistedAddrs: [owner.address, ...resolverAddresses],
                    whitelistedCutOffs: [0, ...whitelistedCutOffsTmp],
                    publicCutOff: time.duration.minutes(30),
                },
            );
            signatures[4] = await signOrderV1(orders[4], chainId, await lopv3.getAddress(), owner);

            // Encode data for fillingg orders
            const fillOrdersToData = [];

            fillOrdersToData[5] = await settlement.getAddress() + '01' + trim0x(resolversV1[0].target) + '0000000000000000000000000000000000000000000000000000000000000000';
            fillOrdersToData[4] =
                await settlement.getAddress() +
                '00' +
                lopv3.interface
                    .encodeFunctionData('fillOrderTo', [
                        orders[4],
                        signatures[4],
                        fillOrdersToData[5],
                        ether('0.11'),
                        0,
                        ether('10'),
                        await resolversV1[0].getAddress(),
                    ])
                    .substring(10);
            for (let i = 3; i >= 1; i--) {
                fillOrdersToData[i] =
                    await settlement.getAddress() +
                    '00' +
                    lopv3.interface
                        .encodeFunctionData('fillOrderTo', [
                            orders[i],
                            signatures[i],
                            fillOrdersToData[i + 1],
                            ether((i + 1).toString()),
                            0,
                            ether(((i + 1) / 100).toString()),
                            await resolversV1[0].getAddress(),
                        ])
                        .substring(10);
            }

            const tx = await settlement.settleOrders(
                '0x' + lopv3.interface.encodeFunctionData('fillOrderTo', [
                    orders[0],
                    signatures[0],
                    fillOrdersToData[1],
                    ether('1'),
                    0,
                    ether('0.01'),
                    await resolversV1[0].getAddress(), // settlement.address,
                ]).substring(10),
            );
            console.log(`1 fill for 5 orders in a batch gasUsed: ${(await tx.wait()).gasUsed}`);
            await expect(tx).to.changeTokenBalances(weth, [owner, alice], [ether('-0.11'), ether('0.1')]);
            await expect(tx).to.changeTokenBalances(dai, [owner, alice, resolversV1[0]], [ether('1'), ether('-10'), ether('9')]);
        });
    });

    describe('Extension check', function () {
        it('post interaction', async function () {
            const { contracts: { dai, weth, accessToken }, accounts: { owner } } = await loadFixture(initContractsAndApproves);
            const makingAmount = ether('10');
            const takingAmount = ether('1');
            const settlementExtension = await deployContract('Settlement', [owner, weth, accessToken, weth, owner]);
            const auction = await buildAuctionDetails();
            const extensions = buildSettlementExtensions({
                feeTaker: await settlementExtension.getAddress(),
                estimatedTakingAmount: takingAmount,
                getterExtraPrefix: auction.details,
                whitelistPostInteraction: '0x0000000000',
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
                extensions,
            );

            await settlementExtension.postInteraction(order, '0x', constants.ZERO_BYTES32, owner.address, makingAmount, takingAmount, makingAmount, '0x' + extensions.postInteraction.substring(42));
        });

        it('making getter', async function () {
            const { contracts: { dai, weth, settlementExtension }, accounts: { owner } } = await loadFixture(initContractsAndApproves);
            const makingAmount = ether('10');
            const takingAmount = ether('1');
            const currentTime = await time.latest();
            const { details } = await buildAuctionDetails({
                startTime: currentTime - time.duration.minutes(5),
                initialRateBump: 900000,
                points: [[800000, 100], [700000, 100], [600000, 100], [500000, 100], [400000, 100]],
            });
            const extensions = buildSettlementExtensions({
                feeTaker: await settlementExtension.getAddress(),
                estimatedTakingAmount: takingAmount,
                getterExtraPrefix: details,
                whitelistPostInteraction: '0x0000000000',
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
                extensions,
            );

            await settlementExtension.getMakingAmount(order, '0x', constants.ZERO_BYTES32, constants.ZERO_ADDRESS, takingAmount, makingAmount, '0x' + extensions.makingAmountData.substring(42));
        });
    });

    describe('SettlementExtension', function () {
        it('extension 1 fill for 1 order', async function () {
            const {
                contracts: { dai, weth, lopv4, settlement },
                accounts: { alice, owner },
                others: { chainId },
            } = await loadFixture(initContractsForSettlement);
            const makingAmount = ether('100');
            const takingAmount = ether('0.1');
            const auction = await buildAuctionDetails();

            const orderData = {
                maker: alice.address,
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount,
                takingAmount,
                makerTraits: buildMakerTraits(),
            };

            const order = buildOrder(
                orderData,
                buildSettlementExtensions({
                    feeTaker: await settlement.getAddress(),
                    estimatedTakingAmount: takingAmount,
                    getterExtraPrefix: auction.details,
                    whitelistPostInteraction: '0x0000000000',
                }),
            );

            const { r, yParityAndS: vs } = ethers.Signature.from(await signOrder(order, chainId, await lopv4.getAddress(), alice));

            const takerTraits = buildTakerTraits({
                makingAmount: true,
                threshold: takingAmount,
                extension: order.extension,
            });

            await weth.approve(lopv4, takingAmount);

            const tx = await lopv4.fillOrderArgs(
                order,
                r,
                vs,
                makingAmount,
                takerTraits.traits,
                takerTraits.args,
            );

            console.log(`1 fill for 1 order gasUsed: ${(await tx.wait()).gasUsed}`);

            await expect(tx).to.changeTokenBalances(dai, [owner, alice], [makingAmount, -makingAmount]);
            await expect(tx).to.changeTokenBalances(weth, [owner, alice], [-takingAmount, takingAmount]);
        });

        it('extension 1 fill for 1 order via resolver with funds', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
            const {
                contracts: { dai, weth, resolver },
                accounts: { alice },
            } = setupData;

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
            });

            await weth.transfer(resolver, ether('0.1'));

            const tx = await resolver.settleOrders(fillOrderToData);

            console.log(`1 fill for 1 order via resolver with funds gasUsed: ${(await tx.wait()).gasUsed}`);
            await expect(tx).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
            await expect(tx).to.changeTokenBalances(weth, [resolver, alice], [ether('-0.1'), ether('0.1')]);
        });

        it('extension 1 fill for 1 order via resolver without funds', async function () {
            const dataFormFixture = await loadFixture(initContractsForSettlement);
            const auction = await buildAuctionDetails();
            const setupData = { ...dataFormFixture, auction };
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
                            ether('0.1'),
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
                threshold: ether('0.1'),
                additionalDataForSettlement: resolverArgs,
                isInnermostOrder: true,
            });

            await weth.approve(resolver, ether('0.1'));

            const tx = await resolver.settleOrders(fillOrderToData);

            console.log(`1 fill for 1 order via resolver without money gasUsed: ${(await tx.wait()).gasUsed}`);
            await expect(tx).to.changeTokenBalances(dai, [resolver, alice], [ether('100'), ether('-100')]);
            await expect(tx).to.changeTokenBalances(weth, [owner, alice], [ether('-0.1'), ether('0.1')]);
        });

        it('extension 1 fill for 1 order with surplus', async function () {
            const {
                contracts: { dai, weth, lopv4, settlement },
                accounts: { alice, bob, owner },
                others: { chainId },
            } = await loadFixture(initContractsForSettlement);
            const now = await time.latest();
            const makingAmount = ether('100');
            const takingAmount = ether('0.1');
            const auction = await buildAuctionDetails({ startTime: now, delay: 60, initialRateBump: 1000000n });
            const surplus = ether('0.01'); // maximum auction bump rate

            const orderData = {
                maker: alice.address,
                receiver: await settlement.getAddress(),
                makerAsset: await dai.getAddress(),
                takerAsset: await weth.getAddress(),
                makingAmount,
                takingAmount,
                makerTraits: buildMakerTraits(),
            };

            const order = buildOrder(
                orderData,
                buildSettlementExtensions({
                    feeTaker: await settlement.getAddress(),
                    protocolFeeRecipient: bob.address,
                    estimatedTakingAmount: takingAmount,
                    getterExtraPrefix: auction.details,
                    whitelistPostInteraction: '0x0000000000',
                    protocolSurplusFee: 50,
                }),
            );

            const { r, yParityAndS: vs } = ethers.Signature.from(await signOrder(order, chainId, await lopv4.getAddress(), alice));

            const takerTraits = buildTakerTraits({
                makingAmount: true,
                threshold: takingAmount + surplus,
                extension: order.extension,
            });

            await weth.approve(lopv4, takingAmount + surplus);

            const tx = await lopv4.fillOrderArgs(
                order,
                r,
                vs,
                makingAmount,
                takerTraits.traits,
                takerTraits.args,
            );

            console.log(`1 fill for 1 order (surplus) gasUsed: ${(await tx.wait()).gasUsed}`);

            await expect(tx).to.changeTokenBalances(dai, [owner, alice], [makingAmount, -makingAmount]);
            await expect(tx).to.changeTokenBalances(weth, [owner, alice], [-takingAmount - surplus, takingAmount + surplus / 2n]);
        });
    });
});
