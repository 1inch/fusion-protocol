const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, impersonateAccount, setBalance } = require('@nomicfoundation/hardhat-network-helpers');
const { ether, deployContract, time, trim0x } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits, buildTakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { deploySwapTokens, getChainId } = require('./helpers/fixtures');
const { buildAuctionDetails, buildCalldataForOrder, buildSettlementExtensions } = require('./helpers/fusionUtils');
const {
    SwapFlags,
    encodeSwapParams,
    encodePermits,
    signAaveV4Permits,
    buildAaveV4CollateralSwapOrder,
    signOrderFor,
} = require('./helpers/aaveV4Utils');

const SELL_RESERVE = 0n;
const BUY_RESERVE = 1n;
const OTHER_RESERVE = 2n;
const TRANSFERLESS_RESERVE = 3n;

// Settlement post-interaction built by @1inch/fusion-sdk 2.4.16 FusionExtension with fees, a custom receiver,
// a two-resolver whitelist, surplus params and a chained post-interaction. The two placeholders are replaced in the test.
const SDK_SETTLEMENT_PLACEHOLDER = '5e771e5e771e5e771e5e771e5e771e5e771e5e77';
const SDK_ADAPTER_PLACEHOLDER = 'ada97e4ada97e4ada97e4ada97e4ada97e4ada97';
const SDK_POST_INTERACTION =
    '0x5e771e5e771e5e771e5e771e5e771e5e771e5e770111111111111111111111111111111111111111112222222222222222222222222222' +
    '222222222222ada97e4ada97e4ada97e4ada97e4ada97e4ada9700fa320064326aea4ce00233333333333333333333000044444444444444' +
    '444444001e000000000000000000000000000000000000000000000006b14e9f7e4f5a500032ada97e4ada97e4ada97e4ada97e4ada97e4a' +
    'da97';

describe('AaveV4CollateralSwap', function () {
    async function initContracts() {
        const chainId = await getChainId();
        const [owner, alice, bob, carol, integrator, protocol] = await ethers.getSigners();
        const { dai, weth, accessToken, lopv4 } = await deploySwapTokens();
        const settlement = await deployContract('SimpleSettlement', [lopv4, accessToken, weth, owner]);
        const resolver = await deployContract('ResolverMock', [settlement, lopv4]);

        const sellToken = await deployContract('TokenMock', ['Sell', 'SELL']);
        const buyToken = await deployContract('TokenMock', ['Buy', 'BUY']);
        const otherToken = await deployContract('TokenMock', ['Other', 'OTHER']);
        const transferlessToken = await deployContract('TransferlessTokenMock');

        const spoke = await deployContract('AaveV4SpokeMock');
        const giver = await deployContract('AaveV4GiverPositionManagerMock');
        const taker = await deployContract('AaveV4TakerPositionManagerMock');
        const gateway = await deployContract('AaveV4SignatureGatewayMock');
        for (const positionManager of [giver, taker, gateway]) {
            await spoke.setPositionManagerActive(positionManager, true);
        }
        for (const token of [sellToken, buyToken, otherToken, transferlessToken]) {
            await spoke.addReserve(token, ether('1'), 8000);
        }

        const adapter = await deployContract('AaveV4CollateralSwap', [lopv4, settlement, giver, taker, gateway, owner]);

        await buyToken.mint(resolver, ether('1000'));
        await resolver.approve(buyToken, lopv4);
        await resolver.approve(transferlessToken, lopv4);

        // Regular Fusion order for nesting: bob sells DAI for WETH
        await dai.transfer(bob, ether('10'));
        await dai.connect(bob).approve(lopv4, ether('10'));
        await weth.deposit({ value: ether('1') });
        await weth.transfer(resolver, ether('1'));
        await resolver.approve(weth, lopv4);

        const auction = await buildAuctionDetails();

        return {
            contracts: { dai, weth, lopv4, settlement, resolver, sellToken, buyToken, otherToken, transferlessToken, spoke, giver, taker, gateway, adapter },
            accounts: { owner, alice, bob, carol, integrator, protocol },
            others: { chainId, auction },
        };
    }

    // 100 SELL as collateral against a debt worth 60: health factor 100 * 0.8 / 60 = 1.33
    async function openPosition(ctx, user, { supply = ether('100'), debt = ether('60') } = {}) {
        const { sellToken, spoke } = ctx.contracts;
        await sellToken.mint(user, supply);
        await sellToken.connect(user).approve(spoke, supply);
        await spoke.connect(user).supply(SELL_RESERVE, supply, user);
        await spoke.connect(user).setUsingAsCollateral(SELL_RESERVE, true, user);
        await spoke.setDebt(user, debt);
    }

    async function signPermits(ctx, signer, overrides = {}) {
        const { spoke, giver, taker, gateway, adapter } = ctx.contracts;
        return signAaveV4Permits({
            signer,
            chainId: ctx.others.chainId,
            spoke: await spoke.getAddress(),
            giver: await giver.getAddress(),
            taker: await taker.getAddress(),
            signatureGateway: await gateway.getAddress(),
            adapter: await adapter.getAddress(),
            sellReserveId: SELL_RESERVE,
            buyReserveId: BUY_RESERVE,
            deadline: BigInt(await time.latest()) + 3600n,
            ...overrides,
        });
    }

    async function swapParams(ctx, overrides = {}) {
        return {
            spoke: await ctx.contracts.spoke.getAddress(),
            sellReserveId: SELL_RESERVE,
            buyReserveId: BUY_RESERVE,
            flags: SwapFlags.RequireCollateral,
            ...overrides,
        };
    }

    // Calldata for ResolverMock.settleOrders that fills a Fusion collateral swap order of `maker`
    async function fusionSwapCalldata(ctx, {
        maker,
        permits,
        makingAmount = ether('100'),
        takingAmount = ether('99'),
        fillingAmount = makingAmount,
        params = {},
        integratorFee = 0,
        takerAsset,
        receiver,
        makerTraits = buildMakerTraits(),
        preInteraction,
        customPostInteraction,
        fillTarget,
        isInnermostOrder = true,
        additionalDataForSettlement = '0x',
    }) {
        const { lopv4, settlement, resolver, buyToken, adapter } = ctx.contracts;
        const adapterAddress = await adapter.getAddress();
        const encodedPermits = permits ?? (await signPermits(ctx, maker)).encoded;
        return buildCalldataForOrder({
            orderData: {
                maker: maker.address,
                receiver: receiver ?? adapterAddress,
                makerAsset: adapterAddress,
                takerAsset: takerAsset ?? await buyToken.getAddress(),
                makingAmount,
                takingAmount,
                makerTraits,
            },
            orderSigner: maker,
            setupData: { contracts: { lopv4, settlement, resolver }, others: { chainId: ctx.others.chainId }, auction: ctx.others.auction },
            threshold: takingAmount * 2n,
            fillingAmount,
            isInnermostOrder,
            additionalDataForSettlement,
            integratorFee,
            integratorFeeRecipient: ctx.accounts.integrator.address,
            protocolFeeRecipient: ctx.accounts.protocol.address,
            whitelistResolvers: ['0x' + (await resolver.getAddress()).substring(22)],
            customPostInteraction: customPostInteraction ?? adapterAddress,
            makerAssetSuffix: encodeSwapParams(await swapParams(ctx, params)),
            preInteraction: preInteraction ?? adapterAddress + trim0x(encodedPermits),
            fillTarget,
        });
    }

    async function fusionWhitelist(ctx) {
        const resolverTail = '0x' + (await ctx.contracts.resolver.getAddress()).substring(22);
        return {
            whitelist: ethers.solidityPacked(['uint8', 'bytes10'], [1, resolverTail]),
            whitelistPostInteraction: ethers.solidityPacked(['uint32', 'uint8', 'bytes10', 'uint16'], [ctx.others.auction.startTime, 1, resolverTail, 0]),
        };
    }

    async function settle(ctx, calldata) {
        return ctx.contracts.resolver.settleOrders(calldata);
    }

    async function expectAdapterEmpty(ctx) {
        const { adapter, sellToken, buyToken, otherToken } = ctx.contracts;
        for (const token of [sellToken, buyToken, otherToken]) {
            expect(await token.balanceOf(adapter)).to.equal(0n);
        }
    }

    async function initWithPosition() {
        const ctx = await initContracts();
        await openPosition(ctx, ctx.accounts.alice);
        return ctx;
    }

    describe('fills', function () {
        it('swaps the whole collateral in one Fusion fill with fees', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, spoke, sellToken, buyToken, resolver, lopv4 } = ctx.contracts;
            const { alice, integrator, protocol } = ctx.accounts;
            const resolverBuyBefore = await buyToken.balanceOf(resolver);

            const calldata = await fusionSwapCalldata(ctx, { maker: alice, integratorFee: 1000 });
            const orderHash = await lopv4.hashOrder(lopv4.interface.decodeFunctionData('fillOrderArgs', calldata).order.toObject());

            await expect(settle(ctx, calldata))
                .to.emit(adapter, 'CollateralSwap')
                .withArgs(orderHash, alice.address, await spoke.getAddress(), SELL_RESERVE, BUY_RESERVE, ether('100'), ether('99'), await resolver.getAddress());

            const fees = await buyToken.balanceOf(integrator) + await buyToken.balanceOf(protocol);
            expect(fees).to.be.gt(0n);
            expect(resolverBuyBefore - await buyToken.balanceOf(resolver)).to.equal(ether('99') + fees);
            expect(await sellToken.balanceOf(resolver)).to.equal(ether('100'));
            expect(await spoke.getUserSuppliedAssets(SELL_RESERVE, alice)).to.equal(0n);
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
            expect((await spoke.getUserReserveStatus(BUY_RESERVE, alice))[0]).to.equal(true);
            expect(await spoke.healthFactor(alice)).to.equal(ether('99') * 8000n / 10000n * ether('1') / ether('60'));
            await expectAdapterEmpty(ctx);
        });

        it('swaps without fees, with the adapter as order receiver', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken, resolver } = ctx.contracts;
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice }));
            expect(await sellToken.balanceOf(resolver)).to.equal(ether('100'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, ctx.accounts.alice)).to.equal(ether('99'));
            await expectAdapterEmpty(ctx);
        });

        it('swaps the whole position over two partial fills and sweeps the rounding leftover to the maker', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken, resolver } = ctx.contracts;
            const { alice } = ctx.accounts;
            // A buffer below the supplied 100 absorbs share rounding of partial withdrawals; maxDust returns what is left
            const makingAmount = ether('100') - 10n;
            const { encoded: permits } = await signPermits(ctx, alice);
            const order = { maker: alice, permits, makingAmount, params: { maxDust: 100n } };

            await settle(ctx, await fusionSwapCalldata(ctx, { ...order, fillingAmount: ether('40') }));
            expect(await sellToken.balanceOf(resolver)).to.equal(ether('40'));
            expect(await spoke.healthFactor(alice)).to.be.gt(ether('1'));

            await settle(ctx, await fusionSwapCalldata(ctx, { ...order, fillingAmount: makingAmount - ether('40') }));
            expect(await sellToken.balanceOf(resolver)).to.equal(makingAmount);
            expect(await sellToken.balanceOf(alice)).to.equal(9n);
            expect(await spoke.getUserSuppliedAssets(SELL_RESERVE, alice)).to.equal(0n);
            await expectAdapterEmpty(ctx);
        });

        it('reverts the final partial fill when the position fell short through rounding', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice);
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('40') }));
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('60') })))
                .to.be.revertedWithCustomError(ctx.contracts.adapter, 'InsufficientWithdrawal')
                .withArgs(ether('60') - 1n, ether('60'));
        });

        it('fills two collateral swap orders nested in one transaction', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken, resolver } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            await openPosition(ctx, bob, { supply: ether('50'), debt: ether('30') });

            const inner = await fusionSwapCalldata(ctx, { maker: bob, makingAmount: ether('50'), takingAmount: ether('49') });
            const outer = await fusionSwapCalldata(ctx, { maker: alice, isInnermostOrder: false, additionalDataForSettlement: inner });
            await settle(ctx, outer);

            expect(await sellToken.balanceOf(resolver)).to.equal(ether('150'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, bob)).to.equal(ether('49'));
            await expectAdapterEmpty(ctx);
        });

        it('fills a collateral swap order nested with a regular Fusion order', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { dai, weth, lopv4, settlement, resolver, spoke } = ctx.contracts;
            const { alice, bob } = ctx.accounts;

            const regular = await buildCalldataForOrder({
                orderData: {
                    maker: bob.address,
                    makerAsset: await dai.getAddress(),
                    takerAsset: await weth.getAddress(),
                    makingAmount: ether('10'),
                    takingAmount: ether('0.01'),
                    makerTraits: buildMakerTraits(),
                },
                orderSigner: bob,
                setupData: { contracts: { lopv4, settlement, resolver }, others: { chainId: ctx.others.chainId }, auction: ctx.others.auction },
                threshold: ether('0.01'),
                isInnermostOrder: true,
                whitelistResolvers: ['0x' + (await resolver.getAddress()).substring(22)],
            });
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, isInnermostOrder: false, additionalDataForSettlement: regular }));

            expect(await dai.balanceOf(resolver)).to.equal(ether('10'));
            expect(await weth.balanceOf(bob)).to.equal(ether('0.01'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
            await expectAdapterEmpty(ctx);
        });

        it('fills a plain limit order with the adapter as its own post-interaction', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { lopv4, settlement, resolver, adapter, buyToken, spoke, sellToken } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice);

            const order = buildAaveV4CollateralSwapOrder({
                maker: alice.address,
                adapter: await adapter.getAddress(),
                settlement: await settlement.getAddress(),
                takerAsset: await buyToken.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('99'),
                swapParams: await swapParams(ctx),
                permits,
            });
            const { r, yParityAndS: vs } = ethers.Signature.from(await signOrderFor(lopv4, order, alice));
            const takerTraits = buildTakerTraits({ makingAmount: true, threshold: ether('99'), extension: order.extension, target: await resolver.getAddress() });
            await settle(ctx, lopv4.interface.encodeFunctionData('fillOrderArgs', [order, r, vs, ether('100'), takerTraits.traits, takerTraits.args]));

            expect(await sellToken.balanceOf(resolver)).to.equal(ether('100'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
            await expectAdapterEmpty(ctx);
        });

        it('fills an order of an EIP-1271 smart wallet', async function () {
            const ctx = await loadFixture(initContracts);
            const { lopv4, settlement, resolver, adapter, buyToken, spoke, sellToken } = ctx.contracts;
            const { carol, integrator, protocol } = ctx.accounts;
            const wallet = await deployContract('SmartWalletMock', [carol]);
            const walletAddress = await wallet.getAddress();

            await sellToken.mint(wallet, ether('100'));
            await wallet.connect(carol).execute(sellToken, sellToken.interface.encodeFunctionData('approve', [await spoke.getAddress(), ether('100')]));
            await wallet.connect(carol).execute(spoke, spoke.interface.encodeFunctionData('supply', [SELL_RESERVE, ether('100'), walletAddress]));
            await wallet.connect(carol).execute(spoke, spoke.interface.encodeFunctionData('setUsingAsCollateral', [SELL_RESERVE, true, walletAddress]));
            await spoke.setDebt(wallet, ether('60'));

            const { encoded: permits } = await signPermits(ctx, carol, { owner: walletAddress });
            const order = buildAaveV4CollateralSwapOrder({
                maker: walletAddress,
                adapter: await adapter.getAddress(),
                settlement: await settlement.getAddress(),
                takerAsset: await buyToken.getAddress(),
                makingAmount: ether('100'),
                takingAmount: ether('99'),
                swapParams: await swapParams(ctx),
                permits,
                settlementExtension: {
                    estimatedTakingAmount: ether('99'),
                    getterExtraPrefix: ctx.others.auction.details,
                    integratorFeeRecipient: integrator.address,
                    protocolFeeRecipient: protocol.address,
                    integratorFee: 1000,
                    ...(await fusionWhitelist(ctx)),
                },
            });
            const signature = await signOrderFor(lopv4, order, carol);
            const takerTraits = buildTakerTraits({ makingAmount: true, threshold: ether('200'), extension: order.extension, target: await resolver.getAddress() });
            await settle(ctx, lopv4.interface.encodeFunctionData('fillContractOrderArgs', [order, signature, ether('100'), takerTraits.traits, takerTraits.args]));

            expect(await sellToken.balanceOf(resolver)).to.equal(ether('100'));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, wallet)).to.equal(ether('99'));
            await expectAdapterEmpty(ctx);
        });
    });

    describe('final fill options', function () {
        it('withdraws a leftover within maxDust and sends it to the maker', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken, resolver } = ctx.contracts;
            const { alice } = ctx.accounts;
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, makingAmount: ether('100') - 5n, params: { maxDust: 10n } }));
            expect(await sellToken.balanceOf(resolver)).to.equal(ether('100') - 5n);
            expect(await sellToken.balanceOf(alice)).to.equal(5n);
            expect(await spoke.getUserSuppliedAssets(SELL_RESERVE, alice)).to.equal(0n);
        });

        it('leaves a leftover above maxDust in the position', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken } = ctx.contracts;
            const { alice } = ctx.accounts;
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, makingAmount: ether('100') - 100n, params: { maxDust: 10n } }));
            expect(await sellToken.balanceOf(alice)).to.equal(0n);
            expect(await spoke.getUserSuppliedAssets(SELL_RESERVE, alice)).to.equal(99n);
        });

        it('caps the dust sweep at the withdraw allowance', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, sellToken } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice, { withdrawAmount: ether('100') - 3n });
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, makingAmount: ether('100') - 5n, params: { maxDust: 10n } }));
            expect(await sellToken.balanceOf(alice)).to.equal(2n);
            expect(await spoke.getUserSuppliedAssets(SELL_RESERVE, alice)).to.equal(2n);
        });

        it('renounces an exact withdraw allowance on the final fill when asked to', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { taker, spoke, adapter } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice, { withdrawAmount: ether('100') + 10n });
            await settle(ctx, await fusionSwapCalldata(ctx, {
                maker: alice,
                permits,
                params: { flags: SwapFlags.RequireCollateral | SwapFlags.RenounceAllowance },
            }));
            expect(await taker.withdrawAllowance(spoke, SELL_RESERVE, alice, adapter)).to.equal(0n);
        });

        it('keeps the max withdraw allowance by default', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { taker, spoke, adapter } = ctx.contracts;
            await settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice }));
            expect(await taker.withdrawAllowance(spoke, SELL_RESERVE, ctx.accounts.alice, adapter)).to.equal(ethers.MaxUint256);
        });
    });

    describe('permits', function () {
        it('are applied on the first fill only', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, gateway, taker } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice);

            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('40') }));
            const counts = [await spoke.signedCalls(), await gateway.signedCalls(), await taker.signedCalls()];
            expect(counts).to.deep.equal([1n, 1n, 1n]);

            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('20') }));
            expect([await spoke.signedCalls(), await gateway.signedCalls(), await taker.signedCalls()]).to.deep.equal(counts);
        });

        it('do not block the order when a front-runner used them first', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, gateway, taker } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { permits, encoded } = await signPermits(ctx, alice);
            await spoke.setUserPositionManagersWithSig(permits.positionManagers, permits.positionManagersSignature);
            await gateway.setUsingAsCollateralWithSig(permits.collateral, permits.collateralSignature);
            await taker.approveWithdrawWithSig(permits.withdrawal, permits.withdrawalSignature);

            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits: encoded }));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
        });

        it('do not block the order when they revert and the maker approved on-chain', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, gateway, taker, giver, adapter } = ctx.contracts;
            const { alice } = ctx.accounts;
            for (const positionManager of [giver, taker, gateway]) {
                await spoke.connect(alice).setUserPositionManager(positionManager, true);
            }
            await spoke.connect(alice).setUsingAsCollateral(BUY_RESERVE, true, alice);
            await taker.connect(alice).approveWithdraw(spoke, SELL_RESERVE, adapter, ethers.MaxUint256);
            for (const mock of [spoke, gateway, taker]) {
                await mock.setFailSignedCalls(true);
            }

            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice }));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
        });

        it('work without any permit when the maker approved on-chain', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke, gateway, taker, giver, adapter } = ctx.contracts;
            const { alice } = ctx.accounts;
            for (const positionManager of [giver, taker, gateway]) {
                await spoke.connect(alice).setUserPositionManager(positionManager, true);
            }
            await spoke.connect(alice).setUsingAsCollateral(BUY_RESERVE, true, alice);
            await taker.connect(alice).approveWithdraw(spoke, SELL_RESERVE, adapter, ethers.MaxUint256);

            await settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, preInteraction: await adapter.getAddress() }));
            expect(await spoke.getUserSuppliedAssets(BUY_RESERVE, alice)).to.equal(ether('99'));
        });

        it('with unexpected contents are rejected', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, resolver } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            const mutations = [
                p => { p.positionManagers.onBehalfOf = bob.address; },
                p => { p.positionManagers.updates[0].approve = false; },
                p => { p.positionManagers.updates.push({ positionManager: bob.address, approve: true }); },
                p => { p.collateral.reserveId = OTHER_RESERVE; },
                p => { p.collateral.useAsCollateral = false; },
                p => { p.collateral.onBehalfOf = bob.address; },
                p => { p.withdrawal.reserveId = BUY_RESERVE; },
                p => { p.withdrawal.owner = bob.address; },
                p => { p.withdrawal.spender = resolver.target; },
            ];
            for (const mutate of mutations) {
                const { permits } = await signPermits(ctx, alice);
                mutate(permits);
                await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits: encodePermits(permits) })))
                    .to.be.revertedWithCustomError(adapter, 'InvalidPermit');
            }
        });

        it('revert the fill when the collateral permit fails and the order requires collateral', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { gateway, adapter } = ctx.contracts;
            await gateway.setFailSignedCalls(true);
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice })))
                .to.be.revertedWithCustomError(adapter, 'CollateralNotEnabled');
        });
    });

    describe('reverts', function () {
        // The Limit Order Protocol reports a failing maker asset transfer as its own TransferFromMakerToTakerFailed
        it('when the same order is filled again inside its own fill', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice);
            const inner = await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('40') });
            const outer = await fusionSwapCalldata(ctx, { maker: alice, permits, fillingAmount: ether('40'), isInnermostOrder: false, additionalDataForSettlement: inner });
            await expect(settle(ctx, outer)).to.be.revertedWithCustomError(ctx.contracts.lopv4, 'TransferFromMakerToTakerFailed');
        });

        it('when the fill target is the adapter', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, lopv4 } = ctx.contracts;
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, fillTarget: await adapter.getAddress() })))
                .to.be.revertedWithCustomError(lopv4, 'TransferFromMakerToTakerFailed');
        });

        it('when the order has no pre-interaction', async function () {
            const ctx = await loadFixture(initWithPosition);
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, preInteraction: '0x' })))
                .to.be.revertedWithCustomError(ctx.contracts.lopv4, 'TransferFromMakerToTakerFailed');
        });

        it('when the order has no post-interaction', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { lopv4, resolver, adapter, buyToken } = ctx.contracts;
            const { alice } = ctx.accounts;
            const adapterAddress = await adapter.getAddress();
            const order = buildOrder(
                { maker: alice.address, receiver: adapterAddress, makerAsset: adapterAddress, takerAsset: await buyToken.getAddress(), makingAmount: ether('100'), takingAmount: ether('99') },
                { makerAssetSuffix: encodeSwapParams(await swapParams(ctx)), preInteraction: adapterAddress },
            );
            const { r, yParityAndS: vs } = ethers.Signature.from(await signOrderFor(lopv4, order, alice));
            const takerTraits = buildTakerTraits({ makingAmount: true, threshold: ether('99'), extension: order.extension, target: await resolver.getAddress() });
            await expect(settle(ctx, lopv4.interface.encodeFunctionData('fillOrderArgs', [order, r, vs, ether('100'), takerTraits.traits, takerTraits.args])))
                .to.be.revertedWithCustomError(adapter, 'UnsupportedOrder');
        });

        it('when the Settlement does not call the adapter', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            for (const customPostInteraction of ['0x', bob.address, await adapter.getAddress() + 'abcd']) {
                await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, customPostInteraction })))
                    .to.be.revertedWithCustomError(adapter, 'UnsupportedOrder');
            }
        });

        it('when the taker asset does not reach the adapter', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter } = ctx.contracts;
            const { alice } = ctx.accounts;
            // With fees the receiver becomes the Settlement and alice its custom receiver; without fees alice is the receiver
            for (const integratorFee of [1000, 0]) {
                await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, receiver: alice.address, integratorFee })))
                    .to.be.revertedWithCustomError(adapter, 'UnsupportedOrder');
            }
        });

        it('when the maker traits are not supported', async function () {
            const ctx = await loadFixture(initWithPosition);
            for (const makerTraits of [buildMakerTraits({ unwrapWeth: true }), buildMakerTraits({ usePermit2: true })]) {
                await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, makerTraits })))
                    .to.be.revertedWithCustomError(ctx.contracts.adapter, 'UnsupportedOrder');
            }
        });

        it('when the buy reserve does not hold the taker asset', async function () {
            const ctx = await loadFixture(initWithPosition);
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, params: { buyReserveId: OTHER_RESERVE } })))
                .to.be.revertedWithCustomError(ctx.contracts.adapter, 'TakerAssetMismatch');
        });

        it('when both reserves are the same', async function () {
            const ctx = await loadFixture(initWithPosition);
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, params: { buyReserveId: SELL_RESERVE } })))
                .to.be.revertedWithCustomError(ctx.contracts.adapter, 'SameReserve');
        });

        it('when no taker asset arrives', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, transferlessToken } = ctx.contracts;
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice, { buyReserveId: TRANSFERLESS_RESERVE });
            await expect(settle(ctx, await fusionSwapCalldata(ctx, {
                maker: alice,
                permits,
                takerAsset: await transferlessToken.getAddress(),
                params: { buyReserveId: TRANSFERLESS_RESERVE },
            }))).to.be.revertedWithCustomError(adapter, 'NothingReceived');
        });

        it('when the swap leaves the health factor below 1', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { spoke } = ctx.contracts;
            await spoke.setPrice(BUY_RESERVE, ether('0.5'));
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice })))
                .to.be.revertedWithCustomError(spoke, 'HealthFactorBelowThreshold');
        });

        it('when the swap leaves the health factor below the order minimum', async function () {
            const ctx = await loadFixture(initWithPosition);
            const expected = ether('99') * 8000n / 10000n * ether('1') / ether('60');
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: ctx.accounts.alice, params: { minHealthFactor: ether('1.5') } })))
                .to.be.revertedWithCustomError(ctx.contracts.adapter, 'HealthFactorTooLow')
                .withArgs(expected, ether('1.5'));
        });

        it('when the new reserve is not enabled as collateral', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { alice } = ctx.accounts;
            const { encoded: permits } = await signPermits(ctx, alice, { enableCollateral: false });
            await expect(settle(ctx, await fusionSwapCalldata(ctx, { maker: alice, permits, params: { flags: 0n } })))
                .to.be.revertedWithCustomError(ctx.contracts.spoke, 'HealthFactorBelowThreshold');
        });
    });

    describe('access control', function () {
        it('accepts the maker asset hook and the pre-interaction from the Limit Order Protocol only', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            await expect(adapter.transferFrom(alice, bob, 1n)).to.be.revertedWithCustomError(adapter, 'OnlyLimitOrderProtocol');

            const order = buildOrder({ maker: alice.address, makerAsset: await adapter.getAddress(), takerAsset: bob.address, makingAmount: 1n, takingAmount: 1n });
            await expect(adapter.preInteraction(order, '0x', ethers.ZeroHash, bob, 1n, 1n, 1n, '0x'))
                .to.be.revertedWithCustomError(adapter, 'OnlyLimitOrderProtocol');
        });

        it('rejects a maker asset transfer that no pre-interaction opened', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, lopv4 } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            await impersonateAccount(await lopv4.getAddress());
            await setBalance(await lopv4.getAddress(), ether('1'));
            const protocol = await ethers.getSigner(await lopv4.getAddress());
            await expect(adapter.connect(protocol).transferFrom(alice, bob, 1n)).to.be.revertedWithCustomError(adapter, 'UnexpectedMakerTransfer');
        });

        it('accepts the post-interaction from the Settlement and the Limit Order Protocol only', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            const order = buildOrder({ maker: alice.address, makerAsset: await adapter.getAddress(), takerAsset: bob.address, makingAmount: 1n, takingAmount: 1n });
            await expect(adapter.postInteraction(order, '0x', ethers.ZeroHash, bob, 1n, 1n, 1n, '0x'))
                .to.be.revertedWithCustomError(adapter, 'OnlyFillCallers');
        });

        it('lets only the owner rescue tokens', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, buyToken } = ctx.contracts;
            const { owner, alice } = ctx.accounts;
            await buyToken.mint(adapter, 5n);
            await expect(adapter.connect(alice).rescueFunds(buyToken, 5n))
                .to.be.revertedWithCustomError(adapter, 'OwnableUnauthorizedAccount');
            await adapter.connect(owner).rescueFunds(buyToken, 5n);
            expect(await buyToken.balanceOf(owner)).to.equal(5n);
        });
    });

    describe('validateOrder', function () {
        async function sdkEncodedOrder(ctx, postInteraction) {
            const { adapter, settlement, buyToken } = ctx.contracts;
            const adapterAddress = await adapter.getAddress();
            return buildOrder(
                {
                    maker: ctx.accounts.alice.address,
                    receiver: await settlement.getAddress(),
                    makerAsset: adapterAddress,
                    takerAsset: await buyToken.getAddress(),
                    makingAmount: ether('100'),
                    takingAmount: ether('99'),
                },
                {
                    makerAssetSuffix: encodeSwapParams(await swapParams(ctx)),
                    preInteraction: adapterAddress,
                    postInteraction,
                },
            );
        }

        function withAddresses(vector, settlement, adapter) {
            return vector
                .replaceAll(SDK_SETTLEMENT_PLACEHOLDER, trim0x(settlement).toLowerCase())
                .replaceAll(SDK_ADAPTER_PLACEHOLDER, trim0x(adapter).toLowerCase());
        }

        it('accepts a Settlement post-interaction encoded by the Fusion SDK', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, settlement } = ctx.contracts;
            const postInteraction = withAddresses(SDK_POST_INTERACTION, await settlement.getAddress(), await adapter.getAddress());
            const order = await sdkEncodedOrder(ctx, postInteraction);
            await adapter.validateOrder(order, order.extension);
        });

        it('rejects orders that do not route through the adapter', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, settlement, buyToken } = ctx.contracts;
            const { alice, bob } = ctx.accounts;
            const adapterAddress = await adapter.getAddress();
            const settlementAddress = await settlement.getAddress();
            const suffix = encodeSwapParams(await swapParams(ctx));
            const buyTokenAddress = await buyToken.getAddress();
            const order = (receiver, extensions) => buildOrder({
                maker: alice.address,
                receiver,
                makerAsset: adapterAddress,
                takerAsset: buyTokenAddress,
                makingAmount: ether('100'),
                takingAmount: ether('99'),
            }, { makerAssetSuffix: suffix, preInteraction: adapterAddress, ...extensions });
            const { postInteraction: withoutCustomReceiver } = buildSettlementExtensions({
                feeTaker: settlementAddress,
                estimatedTakingAmount: ether('99'),
                customPostInteraction: adapterAddress,
            });

            const cases = [
                order(adapterAddress, { postInteraction: bob.address }),
                order(adapterAddress, { postInteraction: adapterAddress + 'abcd' }),
                order(bob.address, { postInteraction: adapterAddress }),
                order(adapterAddress, { preInteraction: bob.address, postInteraction: adapterAddress }),
                order(settlementAddress, { postInteraction: withoutCustomReceiver }),
                order(settlementAddress, { postInteraction: settlementAddress + '01' }),
                order(adapterAddress, { postInteraction: adapterAddress, makerAssetSuffix: suffix + '00' }),
            ];
            for (const invalid of cases) {
                await expect(adapter.validateOrder(invalid, invalid.extension)).to.be.revertedWithCustomError(adapter, 'UnsupportedOrder');
            }
            const valid = order(adapterAddress, { postInteraction: adapterAddress });
            await adapter.validateOrder(valid, valid.extension);
        });

        it('rejects the SDK encoding when the chained post-interaction or the custom receiver is another contract', async function () {
            const ctx = await loadFixture(initWithPosition);
            const { adapter, settlement } = ctx.contracts;
            const adapterAddress = trim0x(await adapter.getAddress()).toLowerCase();
            const valid = withAddresses(SDK_POST_INTERACTION, await settlement.getAddress(), await adapter.getAddress());
            const other = trim0x(ctx.accounts.bob.address).toLowerCase();
            const wrongChainedTarget = valid.slice(0, -40) + other;
            const wrongCustomReceiver = valid.replace(adapterAddress, other);
            for (const postInteraction of [wrongChainedTarget, wrongCustomReceiver, valid.slice(0, -2)]) {
                const order = await sdkEncodedOrder(ctx, postInteraction);
                await expect(adapter.validateOrder(order, order.extension)).to.be.revertedWithCustomError(adapter, 'UnsupportedOrder');
            }
        });
    });
});
