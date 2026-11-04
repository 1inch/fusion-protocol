const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { trim0x } = require('@1inch/solidity-utils');
const { buildOrder, buildTakerTraits, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { buildAuctionDetails, buildSettlementExtensions } = require('../helpers/fusionUtils');

// Opt-in: AAVE_V4_FORK_RPC=<mainnet rpc> [AAVE_V4_FORK_BLOCK=<block>] yarn hardhat test test/poc/AaveV4CollateralSwap.fork.js
const FORK_RPC = process.env.AAVE_V4_FORK_RPC;
const describeFork = FORK_RPC ? describe : describe.skip;

const ADDRESSES = {
    routerV6: '0x111111125421cA6dc452d289314280a0f8842A65',
    settlement: '0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5',
    spoke: '0x94e7A5dCbE816e498b89aB752661904E2F56c485', // Aave V4 Ethereum, Main Spoke
    giver: '0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e',
    taker: '0x6c044c0D3801499bCAbfAd458B70880bc518e9F7',
    signatureGateway: '0xfbC184337Dc6595D8bf62968Bda46e7De7AF9c3d',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wstETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};
const RESERVES = { weth: 0, wstETH: 1, usdc: 7 };

const SPOKE_ABI = [
    'error HealthFactorBelowThreshold()',
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
    'function nonces(address owner, uint192 key) view returns (uint256)',
];
const TAKER_PM_ABI = [
    'function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)',
    'function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
    'function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender) view returns (uint256)',
    'function nonces(address owner, uint192 key) view returns (uint256)',
];
const NONCES_ABI = ['function nonces(address owner, uint192 key) view returns (uint256)'];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function transfer(address, uint256) returns (bool)',
    'function deposit() payable',
    'function getWstETHByStETH(uint256) view returns (uint256)',
];

const ORDER_TYPE = [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makerAsset', type: 'address' },
    { name: 'takerAsset', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' },
    { name: 'makerTraits', type: 'uint256' },
];

const PERMITS_ABI_TYPE = 'tuple(' +
    'tuple(address onBehalfOf, tuple(address positionManager, bool approve)[] updates, uint256 nonce, uint256 deadline) positionManagers, ' +
    'bytes positionManagersSignature, ' +
    'tuple(address spoke, uint256 reserveId, bool useAsCollateral, address onBehalfOf, uint256 nonce, uint256 deadline) collateral, ' +
    'bytes collateralSignature, ' +
    'tuple(address spoke, uint256 reserveId, address owner, address spender, uint256 amount, uint256 nonce, uint256 deadline) withdrawal, ' +
    'bytes withdrawalSignature)';

const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const ether = (value) => ethers.parseEther(value);

describeFork('Aave V4 collateral swap through Fusion, taker pays first (mainnet fork)', function () {
    this.timeout(600_000);

    let deployer, user, integrator, protocol;
    let spoke, takerPM, weth, wstETH, router, adapter, resolver;
    let snapshotId;

    async function latestTimestamp() {
        return (await ethers.provider.getBlock('latest')).timestamp;
    }

    async function healthFactor(account) {
        return (await spoke.getUserAccountData(account)).healthFactor;
    }

    // The user's starting point: 10 WETH as collateral and USDC debt at ~85% of the borrowing power.
    async function openPosition() {
        await weth.connect(user).deposit({ value: ether('10') });
        await weth.connect(user).approve(spoke, ether('10'));
        await spoke.connect(user).supply(RESERVES.weth, ether('10'), user);
        await spoke.connect(user).setUsingAsCollateral(RESERVES.weth, true, user);

        const data = await spoke.getUserAccountData(user);
        // Value has 26 decimals per USD, avgCollateralFactor is a WAD; USDC priced at 1 USD
        const borrowingPowerUsdc = data.totalCollateralValue * data.avgCollateralFactor / ether('1') / 10n ** 20n;
        await spoke.connect(user).borrow(RESERVES.usdc, borrowingPowerUsdc * 85n / 100n, user);
    }

    async function signAavePermits(sellAmount, { enableCollateral = true } = {}) {
        const { chainId } = await ethers.provider.getNetwork();
        const deadline = (await latestTimestamp()) + 3600;
        const domain = (name, verifyingContract) => ({ name, version: '1', chainId, verifyingContract });

        const positionManagers = {
            onBehalfOf: user.address,
            updates: [
                { positionManager: ADDRESSES.giver, approve: true },
                { positionManager: ADDRESSES.taker, approve: true },
                { positionManager: ADDRESSES.signatureGateway, approve: true },
            ],
            nonce: await spoke.nonces(user, 0),
            deadline,
        };
        const positionManagersSignature = await user.signTypedData(
            domain('Spoke', ADDRESSES.spoke),
            {
                SetUserPositionManagers: [
                    { name: 'onBehalfOf', type: 'address' },
                    { name: 'updates', type: 'PositionManagerUpdate[]' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
                PositionManagerUpdate: [
                    { name: 'positionManager', type: 'address' },
                    { name: 'approve', type: 'bool' },
                ],
            },
            positionManagers,
        );

        const collateral = {
            spoke: ADDRESSES.spoke,
            reserveId: RESERVES.wstETH,
            useAsCollateral: true,
            onBehalfOf: user.address,
            nonce: await new ethers.Contract(ADDRESSES.signatureGateway, NONCES_ABI, ethers.provider).nonces(user, 0),
            deadline: enableCollateral ? deadline : 0,
        };
        const collateralSignature = await user.signTypedData(
            domain('SignatureGateway', ADDRESSES.signatureGateway),
            {
                SetUsingAsCollateral: [
                    { name: 'spoke', type: 'address' },
                    { name: 'reserveId', type: 'uint256' },
                    { name: 'useAsCollateral', type: 'bool' },
                    { name: 'onBehalfOf', type: 'address' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            collateral,
        );

        const withdrawal = {
            spoke: ADDRESSES.spoke,
            reserveId: RESERVES.weth,
            owner: user.address,
            spender: await adapter.getAddress(),
            // Shares rounding makes each withdrawal consume up to a few wei more allowance than requested
            amount: sellAmount + 1000n,
            nonce: await takerPM.nonces(user, 0),
            deadline,
        };
        const withdrawalSignature = await user.signTypedData(
            domain('TakerPositionManager', ADDRESSES.taker),
            {
                WithdrawPermit: [
                    { name: 'spoke', type: 'address' },
                    { name: 'reserveId', type: 'uint256' },
                    { name: 'owner', type: 'address' },
                    { name: 'spender', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' },
                ],
            },
            withdrawal,
        );

        return abiCoder.encode([PERMITS_ABI_TYPE], [{
            positionManagers,
            positionManagersSignature,
            collateral,
            collateralSignature,
            withdrawal,
            withdrawalSignature,
        }]);
    }

    async function buildCollateralSwapOrder({ makingAmount, takingAmount, integratorFee, enableCollateral = true }) {
        const now = await latestTimestamp();
        const adapterAddress = await adapter.getAddress();
        const resolverAddress = await resolver.getAddress();
        const auction = await buildAuctionDetails({ startTime: now - 60, duration: 1800 });
        const resolverBytes10 = '0x' + resolverAddress.slice(-20);

        const settlementExtensions = buildSettlementExtensions({
            feeTaker: ADDRESSES.settlement,
            estimatedTakingAmount: takingAmount,
            getterExtraPrefix: auction.details,
            integratorFeeRecipient: integrator.address,
            protocolFeeRecipient: protocol.address,
            makerReceiver: adapterAddress,
            integratorFee,
            whitelist: ethers.solidityPacked(['uint8', 'bytes10'], [1, resolverBytes10]),
            whitelistPostInteraction: ethers.solidityPacked(['uint32', 'uint8', 'bytes10', 'uint16'], [now - 60, 1, resolverBytes10, 0]),
            customPostInteraction: adapterAddress + trim0x(abiCoder.encode(['uint256'], [RESERVES.wstETH])),
        });

        const order = buildOrder(
            {
                maker: user.address,
                receiver: ADDRESSES.settlement,
                makerAsset: adapterAddress,
                takerAsset: ADDRESSES.wstETH,
                makingAmount,
                takingAmount,
                makerTraits: buildMakerTraits({ expiry: now + 3600 }),
            },
            {
                makerAssetSuffix: abiCoder.encode(['address', 'uint256'], [ADDRESSES.spoke, RESERVES.weth]),
                makingAmountData: settlementExtensions.makingAmountData,
                takingAmountData: settlementExtensions.takingAmountData,
                preInteraction: adapterAddress + trim0x(await signAavePermits(makingAmount, { enableCollateral })),
                postInteraction: settlementExtensions.postInteraction,
            },
        );

        const { chainId } = await ethers.provider.getNetwork();
        const signature = await user.signTypedData(
            { name: '1inch Aggregation Router', version: '6', chainId, verifyingContract: ADDRESSES.routerV6 },
            { Order: ORDER_TYPE },
            order,
        );
        return { order, signature: ethers.Signature.from(signature) };
    }

    async function fill({ order, signature }, makingAmount, maxTakingAmount) {
        const takerTraits = buildTakerTraits({
            makingAmount: true,
            threshold: maxTakingAmount,
            extension: order.extension,
            target: await resolver.getAddress(),
        });
        const calldata = router.interface.encodeFunctionData('fillOrderArgs', [
            order, signature.r, signature.yParityAndS, makingAmount, takerTraits.traits, takerTraits.args,
        ]);
        return resolver.settleOrders(calldata);
    }

    before(async function () {
        const blockNumber = process.env.AAVE_V4_FORK_BLOCK
            ? Number(process.env.AAVE_V4_FORK_BLOCK)
            : (await new ethers.JsonRpcProvider(FORK_RPC).getBlockNumber()) - 5;
        await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber } }] });
        // Mainnet Settlement caps the priority fee relative to the base fee; gasPrice is 1 wei in the hardhat config
        await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1']);

        [deployer, integrator, protocol] = await ethers.getSigners();
        user = ethers.Wallet.createRandom().connect(ethers.provider);
        await network.provider.send('hardhat_setBalance', [user.address, ethers.toQuantity(ether('100'))]);

        spoke = new ethers.Contract(ADDRESSES.spoke, SPOKE_ABI, ethers.provider);
        takerPM = new ethers.Contract(ADDRESSES.taker, TAKER_PM_ABI, ethers.provider);
        weth = new ethers.Contract(ADDRESSES.weth, ERC20_ABI, ethers.provider);
        wstETH = new ethers.Contract(ADDRESSES.wstETH, ERC20_ABI, ethers.provider);
        router = await ethers.getContractAt('LimitOrderProtocol', ADDRESSES.routerV6);

        adapter = await (await ethers.getContractFactory('AaveV4CollateralSwapAdapter')).deploy(
            ADDRESSES.routerV6, ADDRESSES.settlement, ADDRESSES.giver, ADDRESSES.taker, ADDRESSES.signatureGateway,
        );
        resolver = await (await ethers.getContractFactory('ResolverMock')).deploy(ADDRESSES.settlement, ADDRESSES.routerV6);
        await resolver.approve(ADDRESSES.wstETH, ADDRESSES.routerV6);

        // Resolver inventory: wstETH minted by sending ETH to the wstETH contract
        await deployer.sendTransaction({ to: ADDRESSES.wstETH, value: ether('20') });
        await wstETH.connect(deployer).transfer(resolver, await wstETH.balanceOf(deployer));

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
        const hf = await healthFactor(user);
        expect(hf).to.be.gt(ether('1'));
        expect(hf).to.be.lt(ether('1.25'));

        // This is the order of operations a regular Fusion fill would impose: maker asset leaves the position first
        await spoke.connect(user).setUserPositionManager(ADDRESSES.taker, true);
        await takerPM.connect(user).approveWithdraw(ADDRESSES.spoke, RESERVES.weth, deployer, ethers.MaxUint256);
        const supplied = await spoke.getUserSuppliedAssets(RESERVES.weth, user);
        await expect(
            takerPM.connect(deployer).withdrawOnBehalfOf(ADDRESSES.spoke, RESERVES.weth, supplied, user),
        ).to.be.revertedWithCustomError(spoke, 'HealthFactorBelowThreshold');
    });

    it('swaps the whole WETH collateral into wstETH collateral in a single Fusion fill', async function () {
        const makingAmount = await spoke.getUserSuppliedAssets(RESERVES.weth, user);
        const takingAmount = (await wstETH.getWstETHByStETH(makingAmount)) * 995n / 1000n;
        const integratorFee = 100; // 0.1% in 1e5 units, half of it goes to the protocol
        const signedOrder = await buildCollateralSwapOrder({ makingAmount, takingAmount, integratorFee });

        const debtBefore = await spoke.getUserTotalDebt(RESERVES.usdc, user);
        const hfBefore = await healthFactor(user);
        const resolverWstETHBefore = await wstETH.balanceOf(resolver);

        const tx = await fill(signedOrder, makingAmount, takingAmount * 2n);
        const receipt = await tx.wait();
        console.log(`        fill gas used: ${receipt.gasUsed}`);

        const takerPaid = resolverWstETHBefore - await wstETH.balanceOf(resolver);
        const fee = await wstETH.balanceOf(integrator) + await wstETH.balanceOf(protocol);
        expect(fee).to.be.gt(0n);
        // The getter rounds the fee-inclusive taking amount up, the fee split rounds down
        expect(takerPaid - fee).to.be.closeTo(takingAmount, 1n);
        expect(await weth.balanceOf(resolver)).to.equal(makingAmount);

        expect(await spoke.getUserSuppliedAssets(RESERVES.weth, user)).to.be.lt(ether('0.000001'));
        expect(await spoke.getUserSuppliedAssets(RESERVES.wstETH, user)).to.be.closeTo(takerPaid - fee, 2n);
        const [usingAsCollateral] = await spoke.getUserReserveStatus(RESERVES.wstETH, user);
        expect(usingAsCollateral).to.equal(true);
        expect(await spoke.getUserTotalDebt(RESERVES.usdc, user)).to.be.closeTo(debtBefore, debtBefore / 1_000_000n);

        const hfAfter = await healthFactor(user);
        expect(hfAfter).to.be.gt(ether('1'));
        console.log(`        health factor: ${ethers.formatEther(hfBefore)} -> ${ethers.formatEther(hfAfter)}`);
        expect(await wstETH.balanceOf(adapter)).to.equal(0n);
        expect(await weth.balanceOf(adapter)).to.equal(0n);
    });

    it('supports partial fills of the same order', async function () {
        const makingAmount = await spoke.getUserSuppliedAssets(RESERVES.weth, user);
        const takingAmount = (await wstETH.getWstETHByStETH(makingAmount)) * 995n / 1000n;
        const signedOrder = await buildCollateralSwapOrder({ makingAmount, takingAmount, integratorFee: 0 });

        const firstPart = makingAmount * 40n / 100n;
        await fill(signedOrder, firstPart, takingAmount);
        expect(await weth.balanceOf(resolver)).to.equal(firstPart);
        expect(await healthFactor(user)).to.be.gt(ether('1'));

        await fill(signedOrder, makingAmount - firstPart, takingAmount);
        expect(await weth.balanceOf(resolver)).to.equal(makingAmount);
        expect(await spoke.getUserSuppliedAssets(RESERVES.weth, user)).to.be.lt(ether('0.000001'));
        expect(await spoke.getUserSuppliedAssets(RESERVES.wstETH, user)).to.be.closeTo(takingAmount, 4n);
        expect(await healthFactor(user)).to.be.gt(ether('1'));
    });

    it('reverts the fill when the new reserve is not enabled as collateral', async function () {
        const makingAmount = await spoke.getUserSuppliedAssets(RESERVES.weth, user);
        const takingAmount = (await wstETH.getWstETHByStETH(makingAmount)) * 995n / 1000n;
        const signedOrder = await buildCollateralSwapOrder({ makingAmount, takingAmount, integratorFee: 0, enableCollateral: false });

        await expect(fill(signedOrder, makingAmount, takingAmount)).to.be.revertedWithCustomError(spoke, 'HealthFactorBelowThreshold');
    });

    it('rejects calls that do not come from the Limit Order Protocol or the settlement', async function () {
        await expect(adapter.transferFrom(user, deployer, 1n)).to.be.revertedWithCustomError(adapter, 'OnlyLimitOrderProtocol');
        const { order } = await buildCollateralSwapOrder({ makingAmount: 1n, takingAmount: 1n, integratorFee: 0 });
        await expect(
            adapter.postInteraction(order, '0x', ethers.ZeroHash, deployer, 1n, 1n, 1n, abiCoder.encode(['uint256'], [RESERVES.wstETH])),
        ).to.be.revertedWithCustomError(adapter, 'OnlySettlement');
    });
});
