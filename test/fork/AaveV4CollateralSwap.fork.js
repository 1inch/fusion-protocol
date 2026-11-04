const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { buildTakerTraits, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { buildAuctionDetails } = require('../helpers/fusionUtils');
const { SwapFlags, signAaveV4Permits, buildAaveV4CollateralSwapOrder, signOrderFor } = require('../helpers/aaveV4Utils');

// Opt-in tests against live Aave V4, 1inch Router V6 and the deployed Fusion Settlement:
//   AAVE_V4_FORK_RPC=<rpc> [AAVE_V4_FORK_CHAIN=ethereum|avalanche] [AAVE_V4_FORK_BLOCK=<block>] yarn test:fork
// A pinned AAVE_V4_FORK_BLOCK needs an archive RPC. Without it the suite forks a recent block.
// Base is not covered here: its Aave V4 collateral is Coinbase tokenized equities that Base nodes implement natively
// (eth_getCode returns a single 0xef byte), so a Hardhat fork cannot execute them. Verify Base with simulations against
// a Base node, then a small canary fill after deployment.
const FORK_RPC = process.env.AAVE_V4_FORK_RPC;
const describeFork = FORK_RPC ? describe : describe.skip;

const ROUTER_V6 = '0x111111125421cA6dc452d289314280a0f8842A65';
const SETTLEMENT = '0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5';

const CHAINS = {
    ethereum: {
        spoke: '0x94e7A5dCbE816e498b89aB752661904E2F56c485', // Main Spoke
        giver: '0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e',
        taker: '0x6c044c0D3801499bCAbfAd458B70880bc518e9F7',
        signatureGateway: '0xfbC184337Dc6595D8bf62968Bda46e7De7AF9c3d',
        sell: { reserveId: 0n, token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, // WETH, wrapped by the user
        buy: { reserveId: 1n, token: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' }, // wstETH, minted by sending ETH to it
        debtReserveId: 7n, // USDC
        morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    },
    avalanche: {
        spoke: '0x435272CefF93a1E657E8ABfdf0A13e95900A3a56', // Main Spoke
        giver: '0x50c4C40aB6BaE46B372a251BEacE388439aa96b4',
        taker: '0x5A5A711560eb9293Ef6F4bc33CD8589b4A603D10',
        signatureGateway: '0x6E3B91A951DA9b515a5E98F0c7D210a697382e7F',
        // WETH.e, taken from the Aave V3 aWETH contract
        sell: { reserveId: 4n, token: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', holder: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8' },
        buy: { reserveId: 0n, token: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' }, // WAVAX, minted by sending AVAX to it
        debtReserveId: 2n, // USDC
    },
};

const SPOKE_ABI = [
    'error HealthFactorBelowThreshold()',
    'function ORACLE() view returns (address)',
    'function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    'function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    'function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)',
    'function setUserPositionManager(address positionManager, bool approve)',
    'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
    'function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)',
    'function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)',
    'function getUserAccountData(address user) view returns (tuple(' +
        'uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, ' +
        'uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))',
];
const ORACLE_ABI = ['function getReservePrice(uint256 reserveId) view returns (uint256)'];
const TAKER_PM_ABI = [
    'error InsufficientWithdrawAllowance(uint256 allowance, uint256 amount)',
    'function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)',
    'function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    'function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender) view returns (uint256)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function approve(address, uint256) returns (bool)',
    'function transfer(address, uint256) returns (bool)',
    'function deposit() payable',
    'function withdraw(uint256)',
];

const ether = (value) => ethers.parseEther(value);
const SUPPLY = ether('10');

describeFork(`Aave V4 collateral swap through Fusion on a ${process.env.AAVE_V4_FORK_CHAIN || 'ethereum'} fork`, function () {
    this.timeout(900_000);

    const chain = CHAINS[process.env.AAVE_V4_FORK_CHAIN || 'ethereum'];
    let deployer, integrator, protocol, user;
    let spoke, oracle, takerPM, sellToken, buyToken, router, adapter, resolver;
    let snapshotId;

    async function latestTimestamp() {
        return (await ethers.provider.getBlock('latest')).timestamp;
    }

    async function healthFactor() {
        return (await spoke.getUserAccountData(user)).healthFactor;
    }

    // Buy amount at the Aave oracle price, minus 0.5%
    async function quote(makingAmount) {
        const [sellPrice, buyPrice] = await Promise.all([oracle.getReservePrice(chain.sell.reserveId), oracle.getReservePrice(chain.buy.reserveId)]);
        const [sellDecimals, buyDecimals] = await Promise.all([sellToken.decimals(), buyToken.decimals()]);
        return makingAmount * sellPrice * 10n ** buyDecimals / (buyPrice * 10n ** sellDecimals) * 995n / 1000n;
    }

    async function fundSellToken(amount) {
        if (chain.sell.holder) {
            await network.provider.send('hardhat_impersonateAccount', [chain.sell.holder]);
            await network.provider.send('hardhat_setBalance', [chain.sell.holder, ethers.toQuantity(ether('1'))]);
            await sellToken.connect(await ethers.getSigner(chain.sell.holder)).transfer(user, amount);
        } else {
            await sellToken.connect(user).deposit({ value: amount });
        }
    }

    async function fundBuyToken(to, amount) {
        const before = await buyToken.balanceOf(deployer);
        await deployer.sendTransaction({ to: chain.buy.token, value: amount });
        await buyToken.connect(deployer).transfer(to, await buyToken.balanceOf(deployer) - before);
    }

    // The user's starting point: SUPPLY of the sell asset as collateral and USDC debt at 80% of the borrowing power
    async function openPosition() {
        await fundSellToken(SUPPLY);
        await sellToken.connect(user).approve(spoke, SUPPLY);
        await spoke.connect(user).supply(chain.sell.reserveId, SUPPLY, user);
        await spoke.connect(user).setUsingAsCollateral(chain.sell.reserveId, true, user);

        const data = await spoke.getUserAccountData(user);
        // Value has 26 decimals per USD, avgCollateralFactor is a WAD; USDC priced at 1 USD
        const borrowingPowerUsdc = data.totalCollateralValue * data.avgCollateralFactor / ether('1') / 10n ** 20n;
        await spoke.connect(user).borrow(chain.debtReserveId, borrowingPowerUsdc * 80n / 100n, user);
    }

    async function signPermits(overrides = {}) {
        return signAaveV4Permits({
            signer: user,
            chainId: (await ethers.provider.getNetwork()).chainId,
            spoke: chain.spoke,
            giver: chain.giver,
            taker: chain.taker,
            signatureGateway: chain.signatureGateway,
            adapter: await adapter.getAddress(),
            sellReserveId: chain.sell.reserveId,
            buyReserveId: chain.buy.reserveId,
            deadline: BigInt(await latestTimestamp()) + 3600n,
            ...overrides,
        });
    }

    async function buildSwapOrder({ makingAmount, takingAmount, permits, params = {}, integratorFee = 0, taker = resolver }) {
        const now = await latestTimestamp();
        const auction = await buildAuctionDetails({ startTime: now - 60 });
        const takerTail = '0x' + (await taker.getAddress()).substring(22);
        const order = buildAaveV4CollateralSwapOrder({
            maker: user.address,
            adapter: await adapter.getAddress(),
            settlement: SETTLEMENT,
            takerAsset: chain.buy.token,
            makingAmount,
            takingAmount,
            swapParams: { spoke: chain.spoke, sellReserveId: chain.sell.reserveId, buyReserveId: chain.buy.reserveId, flags: SwapFlags.RequireCollateral, ...params },
            permits: permits ?? (await signPermits()).encoded,
            makerTraits: buildMakerTraits({ expiry: now + 3600 }),
            settlementExtension: {
                estimatedTakingAmount: takingAmount,
                getterExtraPrefix: auction.details,
                integratorFeeRecipient: integrator.address,
                protocolFeeRecipient: protocol.address,
                integratorFee,
                whitelist: ethers.solidityPacked(['uint8', 'bytes10'], [1, takerTail]),
                whitelistPostInteraction: ethers.solidityPacked(['uint32', 'uint8', 'bytes10', 'uint16'], [now - 60, 1, takerTail, 0]),
            },
        });
        const signature = ethers.Signature.from(await signOrderFor(router, order, user));
        return { order, signature };
    }

    async function fillCalldata({ order, signature }, makingAmount, target = resolver) {
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            threshold: order.takingAmount * 2n,
            extension: order.extension,
            target: await target.getAddress(),
        });
        return router.interface.encodeFunctionData('fillOrderArgs', [
            order, signature.r, signature.yParityAndS, makingAmount, takerTraits.traits, takerTraits.args,
        ]);
    }

    async function fill(signedOrder, makingAmount) {
        return resolver.settleOrders(await fillCalldata(signedOrder, makingAmount));
    }

    async function expectAdapterEmpty() {
        expect(await sellToken.balanceOf(adapter)).to.equal(0n);
        expect(await buyToken.balanceOf(adapter)).to.equal(0n);
    }

    before(async function () {
        const blockNumber = process.env.AAVE_V4_FORK_BLOCK
            ? Number(process.env.AAVE_V4_FORK_BLOCK)
            : (await new ethers.JsonRpcProvider(FORK_RPC).getBlockNumber()) - 5;
        await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber } }] });
        // The mainnet Settlement caps the priority fee relative to the base fee; gasPrice is 1 wei in the hardhat config
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);

        [deployer, integrator, protocol] = await ethers.getSigners();
        user = ethers.Wallet.createRandom().connect(ethers.provider);
        await network.provider.send('hardhat_setBalance', [user.address, ethers.toQuantity(ether('100'))]);

        spoke = new ethers.Contract(chain.spoke, SPOKE_ABI, ethers.provider);
        oracle = new ethers.Contract(await spoke.ORACLE(), ORACLE_ABI, ethers.provider);
        takerPM = new ethers.Contract(chain.taker, TAKER_PM_ABI, ethers.provider);
        sellToken = new ethers.Contract(chain.sell.token, ERC20_ABI, ethers.provider);
        buyToken = new ethers.Contract(chain.buy.token, ERC20_ABI, ethers.provider);
        router = await ethers.getContractAt('LimitOrderProtocol', ROUTER_V6);

        adapter = await (await ethers.getContractFactory('AaveV4CollateralSwap')).deploy(
            ROUTER_V6, SETTLEMENT, chain.giver, chain.taker, chain.signatureGateway, deployer,
        );
        resolver = await (await ethers.getContractFactory('ResolverMock')).deploy(SETTLEMENT, ROUTER_V6);
        await resolver.approve(chain.buy.token, ROUTER_V6);
        await fundBuyToken(resolver, await quote(SUPPLY) * 2n);

        await openPosition();
        snapshotId = await network.provider.send('evm_snapshot');
    });

    after(async function () {
        await network.provider.request({ method: 'hardhat_reset', params: [] });
    });

    afterEach(async function () {
        await network.provider.send('evm_revert', [snapshotId]);
        snapshotId = await network.provider.send('evm_snapshot');
    });

    it('withdrawing the old collateral before the new one is supplied fails the health factor check', async function () {
        expect(await healthFactor()).to.be.gt(ether('1'));
        await spoke.connect(user).setUserPositionManager(chain.taker, true);
        await takerPM.connect(user).approveWithdraw(chain.spoke, chain.sell.reserveId, deployer, ethers.MaxUint256);
        const supplied = await spoke.getUserSuppliedAssets(chain.sell.reserveId, user);
        await expect(takerPM.connect(deployer).withdrawOnBehalfOf(chain.spoke, chain.sell.reserveId, supplied, user))
            .to.be.revertedWithCustomError(spoke, 'HealthFactorBelowThreshold');
    });

    it('swaps the whole collateral in one Fusion fill and sweeps accrued interest to the maker', async function () {
        const makingAmount = await spoke.getUserSuppliedAssets(chain.sell.reserveId, user);
        const takingAmount = await quote(makingAmount);
        const signedOrder = await buildSwapOrder({ makingAmount, takingAmount, integratorFee: 100, params: { maxDust: ether('0.001') } });
        const debtBefore = await spoke.getUserTotalDebt(chain.debtReserveId, user);
        const hfBefore = await healthFactor();
        const resolverBuyBefore = await buyToken.balanceOf(resolver);

        const receipt = await (await fill(signedOrder, makingAmount)).wait();
        console.log(`        first fill gas used: ${receipt.gasUsed}`);

        const fees = await buyToken.balanceOf(integrator) + await buyToken.balanceOf(protocol);
        const paid = resolverBuyBefore - await buyToken.balanceOf(resolver);
        expect(fees).to.be.gt(0n);
        expect(paid - fees).to.be.closeTo(takingAmount, 1n);
        expect(await sellToken.balanceOf(resolver)).to.equal(makingAmount);
        expect(await spoke.getUserSuppliedAssets(chain.sell.reserveId, user)).to.equal(0n);
        expect(await spoke.getUserSuppliedAssets(chain.buy.reserveId, user)).to.be.closeTo(paid - fees, 2n);
        expect((await spoke.getUserReserveStatus(chain.buy.reserveId, user))[0]).to.equal(true);
        expect(await spoke.getUserTotalDebt(chain.debtReserveId, user)).to.be.closeTo(debtBefore, debtBefore / 1_000_000n);
        expect(await healthFactor()).to.be.gt(ether('1'));
        console.log(`        health factor: ${ethers.formatEther(hfBefore)} -> ${ethers.formatEther(await healthFactor())}`);
        await expectAdapterEmpty();
    });

    it('swaps the whole collateral over two partial fills', async function () {
        const supplied = await spoke.getUserSuppliedAssets(chain.sell.reserveId, user);
        // Leave a buffer for share rounding of the partial withdrawal; maxDust returns it on the final fill
        const makingAmount = supplied - 1000n;
        const signedOrder = await buildSwapOrder({ makingAmount, takingAmount: await quote(makingAmount), params: { maxDust: ether('0.001') } });

        const firstPart = makingAmount * 40n / 100n;
        await fill(signedOrder, firstPart);
        expect(await healthFactor()).to.be.gt(ether('1'));

        const receipt = await (await fill(signedOrder, makingAmount - firstPart)).wait();
        console.log(`        later partial fill gas used: ${receipt.gasUsed}`);
        expect(await sellToken.balanceOf(resolver)).to.equal(makingAmount);
        expect(await spoke.getUserSuppliedAssets(chain.sell.reserveId, user)).to.equal(0n);
        expect(await sellToken.balanceOf(user)).to.be.gt(0n);
        expect(await healthFactor()).to.be.gt(ether('1'));
        await expectAdapterEmpty();
    });

    it('fills two concurrent orders on the same reserve with the max allowance', async function () {
        const first = SUPPLY * 40n / 100n;
        const second = SUPPLY * 50n / 100n;
        const orderA = await buildSwapOrder({ makingAmount: first, takingAmount: await quote(first) });
        const orderB = await buildSwapOrder({ makingAmount: second, takingAmount: await quote(second) });

        await fill(orderA, first / 2n);
        await fill(orderB, second);
        await fill(orderA, first - first / 2n);
        expect(await sellToken.balanceOf(resolver)).to.equal(first + second);
        expect(await takerPM.withdrawAllowance(chain.spoke, chain.sell.reserveId, user, adapter)).to.equal(ethers.MaxUint256);
    });

    it('renounces an exact withdraw allowance on the final fill', async function () {
        const makingAmount = SUPPLY / 2n;
        const { encoded: permits } = await signPermits({ withdrawAmount: makingAmount + 1000n });
        const signedOrder = await buildSwapOrder({
            makingAmount,
            takingAmount: await quote(makingAmount),
            permits,
            params: { flags: SwapFlags.RequireCollateral | SwapFlags.RenounceAllowance },
        });
        await fill(signedOrder, makingAmount);
        expect(await takerPM.withdrawAllowance(chain.spoke, chain.sell.reserveId, user, adapter)).to.equal(0n);
    });

    it('enforces the minimum health factor of the order', async function () {
        const makingAmount = SUPPLY / 2n;
        const signedOrder = await buildSwapOrder({ makingAmount, takingAmount: await quote(makingAmount), params: { minHealthFactor: ether('100') } });
        await expect(fill(signedOrder, makingAmount)).to.be.revertedWithCustomError(adapter, 'HealthFactorTooLow');
    });

    it('stops filling once the maker cancels the order or revokes the allowance', async function () {
        const makingAmount = SUPPLY / 2n;
        const cancelled = await buildSwapOrder({ makingAmount, takingAmount: await quote(makingAmount) });
        await router.connect(user).cancelOrder(cancelled.order.makerTraits, await router.hashOrder(cancelled.order));
        await expect(fill(cancelled, makingAmount)).to.be.revertedWithCustomError(router, 'InvalidatedOrder');

        const revoked = await buildSwapOrder({ makingAmount, takingAmount: await quote(makingAmount) });
        await fill(revoked, makingAmount / 2n);
        await takerPM.connect(user).approveWithdraw(chain.spoke, chain.sell.reserveId, adapter, 0n);
        await expect(fill(revoked, makingAmount / 2n)).to.be.revertedWithCustomError(takerPM, 'InsufficientWithdrawAllowance');
    });

    it('reverts the fill when the new reserve is not enabled as collateral', async function () {
        const makingAmount = await spoke.getUserSuppliedAssets(chain.sell.reserveId, user);
        const { encoded: permits } = await signPermits({ enableCollateral: false });
        const signedOrder = await buildSwapOrder({ makingAmount, takingAmount: await quote(makingAmount), permits, params: { flags: 0n } });
        await expect(fill(signedOrder, makingAmount)).to.be.revertedWithCustomError(spoke, 'HealthFactorBelowThreshold');
    });

    it('fills with a resolver that borrows the taker asset with a Morpho flash loan', async function () {
        if (!chain.morpho) this.skip();
        const flashResolver = await (await ethers.getContractFactory('FlashLoanResolverMock')).deploy(chain.morpho, ROUTER_V6);
        const makingAmount = SUPPLY / 2n;
        const takingAmount = await quote(makingAmount);
        const signedOrder = await buildSwapOrder({ makingAmount, takingAmount, integratorFee: 100, taker: flashResolver });

        // WETH received from the user's position goes back to wstETH through Lido to repay the loan
        const unwind = [
            { target: chain.sell.token, value: 0n, data: sellToken.interface.encodeFunctionData('withdraw', [makingAmount]) },
            { target: chain.buy.token, value: makingAmount, data: '0x' },
        ];
        await flashResolver.flashFill(chain.buy.token, takingAmount * 2n, await fillCalldata(signedOrder, makingAmount, flashResolver), unwind);

        expect(await spoke.getUserSuppliedAssets(chain.buy.reserveId, user)).to.be.closeTo(takingAmount, 2n);
        expect(await buyToken.balanceOf(flashResolver)).to.be.gt(0n);
        await expectAdapterEmpty();
    });
});
