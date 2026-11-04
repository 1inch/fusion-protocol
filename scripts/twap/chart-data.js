// Runs FusionTwap in front of SimpleSettlement on the in-process Hardhat network and records the data behind
// the TWAP charts: getter quotes over time, a resolver executing a TWAP against a seeded market path, a late
// start with and without announcement anchoring, and the gas of each kind of fill.
// Usage: yarn hardhat run scripts/twap/chart-data.js   (writes build/twap-charts/onchain.json)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ethers, network } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { ether, deployContract, trim0x } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits, buildTakerTraits, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('../../test/helpers/fixtures');
const { buildAuctionDetails, buildCalldataForOrder, buildSettlementExtensions } = require('../../test/helpers/fusionUtils');
const { buildTwapOrder } = require('../../test/helpers/twapUtils');

const OUT_DIR = process.env.TWAP_CHARTS_DIR || path.join(__dirname, '../../build/twap-charts');
const MAKING_AMOUNT = ether('100');
const TAKING_AMOUNT = ether('0.1');
const RATE_BUMP_BASE = 10000000n;
const LIMIT_PRICE = 0.001; // WETH per DAI
const ARRIVAL_PRICE = LIMIT_PRICE / 0.95;
const TOP_PREMIUM_BUMP = BigInt(Math.round((1.03 / 0.95 - 1) * 1e7)); // curve top 3% above the arrival price
const BLOCK_TIME = 12;
const RESOLVER_COST = 0.001; // 10 bps

const toFloat = (wei) => Number(wei) / 1e18;
const ceilDiv = (a, b) => (a + b - 1n) / b;

function modelTakingAmount(makingAmount, elapsed, duration, initialRateBump) {
    let rateBump = 0n;
    if (elapsed <= 0) {
        rateBump = initialRateBump;
    } else if (elapsed < duration) {
        rateBump = BigInt(duration - elapsed) * initialRateBump / BigInt(duration);
    }
    return ceilDiv(ceilDiv(TAKING_AMOUNT * makingAmount, MAKING_AMOUNT) * (RATE_BUMP_BASE + rateBump), RATE_BUMP_BASE);
}

function extensionField(extension, index) {
    const data = trim0x(extension);
    const offsets = BigInt('0x' + data.slice(0, 64));
    const start = index === 0 ? 0 : Number((offsets >> BigInt(32 * (index - 1))) & 0xffffffffn);
    const end = Number((offsets >> BigInt(32 * index)) & 0xffffffffn);
    return '0x' + data.slice(64 + start * 2, 64 + end * 2);
}

function mulberry32(seed) {
    return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function marketPath({ seed, sigma, steps }) {
    const random = mulberry32(seed);
    const dt = BLOCK_TIME / (365 * 24 * 3600);
    const prices = [ARRIVAL_PRICE];
    for (let i = 1; i <= steps; i++) {
        const z = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
        prices.push(prices[i - 1] * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z));
    }
    return prices;
}

async function snapshot() {
    return network.provider.send('evm_snapshot');
}

async function revert(id) {
    await network.provider.send('evm_revert', [id]);
}

const AMOUNT_GETTER = '@1inch/limit-order-protocol-contract/contracts/interfaces/IAmountGetter.sol:IAmountGetter';

async function quoteTakingAmount({ order, orderHash }, makingAmount, remainingMakingAmount, taker) {
    const takingAmountData = extensionField(order.extension, 3);
    const getter = await ethers.getContractAt(AMOUNT_GETTER, '0x' + trim0x(takingAmountData).slice(0, 40));
    return getter.getTakingAmount.staticCall(
        order, order.extension, orderHash, taker, makingAmount, remainingMakingAmount, '0x' + trim0x(takingAmountData).slice(40),
        { blockTag: 'pending' },
    );
}

async function fill({ lopv4, resolver }, order, signature, makingAmount, maxTakingAmount, timestamp) {
    const takerTraits = buildTakerTraits({
        makingAmount: true,
        threshold: maxTakingAmount,
        extension: order.extension,
        interaction: await resolver.getAddress() + '01',
        target: await resolver.getAddress(),
    });
    const { r, yParityAndS: vs } = ethers.Signature.from(signature);
    await time.setNextBlockTimestamp(timestamp);
    const tx = await resolver.settleOrders(lopv4.interface.encodeFunctionData('fillOrderArgs', [order, r, vs, makingAmount, takerTraits.traits, takerTraits.args]));
    return tx.wait();
}

async function twapOrder(setup, { startTime, interval, parts, initialRateBump, anchored = false }) {
    const { contracts: { dai, weth, lopv4, settlement, twap }, accounts: { alice }, others: { chainId } } = setup;
    const schedule = { startTime, interval, parts, anchored };
    const { details } = await buildAuctionDetails({ startTime, duration: interval, initialRateBump });
    const order = buildTwapOrder({
        twap: await twap.getAddress(),
        settlement: await settlement.getAddress(),
        orderData: {
            maker: alice.address,
            makerAsset: await dai.getAddress(),
            takerAsset: await weth.getAddress(),
            makingAmount: MAKING_AMOUNT,
            takingAmount: TAKING_AMOUNT,
        },
        schedule,
        auctionDetails: details,
    });
    const signature = await signOrder(order, chainId, await lopv4.getAddress(), alice);
    return { order, orderHash: await lopv4.hashOrder(order), signature };
}

async function priceCurve(setup) {
    const { contracts: { dai, weth, lopv4, settlement }, accounts: { owner } } = setup;
    const interval = 600;
    const startTime = await time.latest() + 60;
    const initialRateBump = 1000000n;
    const twap = await twapOrder(setup, { startTime, interval, parts: 4, initialRateBump });

    const { details } = await buildAuctionDetails({ startTime, duration: interval, initialRateBump });
    const plain = buildOrder(
        { maker: owner.address, makerAsset: await dai.getAddress(), takerAsset: await weth.getAddress(), makingAmount: MAKING_AMOUNT, takingAmount: TAKING_AMOUNT, makerTraits: buildMakerTraits() },
        buildSettlementExtensions({
            feeTaker: await settlement.getAddress(),
            estimatedTakingAmount: TAKING_AMOUNT,
            getterExtraPrefix: details,
            whitelistPostInteraction: ethers.solidityPacked(['uint32', 'uint8'], [startTime, 0]),
        }),
    );
    const fusion = { order: plain, orderHash: await lopv4.hashOrder(plain) };

    const part = MAKING_AMOUNT / 4n;
    const curve = { minutes: [], twap: [], fusion: [], samples: 0, maxDeviationWei: 0n };
    for (let offset = 0; offset < 4 * interval; offset += 15) {
        await time.setNextBlockTimestamp(startTime + offset);
        const twapTaking = await quoteTakingAmount(twap, part, MAKING_AMOUNT, owner.address);
        const fusionTaking = await quoteTakingAmount(fusion, part, MAKING_AMOUNT, owner.address);
        const deviations = [
            twapTaking - modelTakingAmount(part, offset % interval, interval, initialRateBump),
            fusionTaking - modelTakingAmount(part, offset, interval, initialRateBump),
        ].map((d) => (d < 0n ? -d : d));
        curve.maxDeviationWei = deviations.reduce((a, b) => (b > a ? b : a), curve.maxDeviationWei);
        curve.minutes.push(offset / 60);
        curve.twap.push(100 * (toFloat(twapTaking) / toFloat(part) / LIMIT_PRICE - 1));
        curve.fusion.push(100 * (toFloat(fusionTaking) / toFloat(part) / LIMIT_PRICE - 1));
        curve.samples += 2;
    }
    return { ...curve, maxDeviationWei: curve.maxDeviationWei.toString(), interval, parts: 4, initialRateBumpPct: 10 };
}

async function execute(setup, { prices, parts, interval, visibleFrom = 0, anchoredAt, horizon }) {
    const { contracts, accounts: { alice, owner } } = setup;
    const baseTime = await time.latest() + 60;
    const anchored = anchoredAt !== undefined;
    const twap = await twapOrder(setup, { startTime: baseTime, interval, parts, initialRateBump: TOP_PREMIUM_BUMP, anchored });
    const scheduleStart = anchored ? anchoredAt : 0;
    const end = scheduleStart + parts * interval;

    const blocks = [];
    const fills = [];
    let filled = 0n;
    for (let offset = 0; offset <= horizon; offset += BLOCK_TIME) {
        const market = prices[offset / BLOCK_TIME];
        if (anchored && offset === anchoredAt) {
            await time.setNextBlockTimestamp(baseTime + offset);
            await (await contracts.registrator.registerOrder(twap.order)).wait();
            blocks.push({ t: offset, market, price: null, unlocked: toFloat(filled), filled: toFloat(filled) });
            continue;
        }
        await time.setNextBlockTimestamp(baseTime + offset);
        const active = offset >= scheduleStart && offset < end && (!anchored || offset > anchoredAt);
        const partIndex = active ? Math.floor((offset - scheduleStart) / interval) : -1;
        const unlocked = active ? MAKING_AMOUNT * BigInt(partIndex + 1) / BigInt(parts) : (offset >= end ? MAKING_AMOUNT : 0n);
        let price = null;
        if (active) {
            const onePart = MAKING_AMOUNT / BigInt(parts);
            price = toFloat(await quoteTakingAmount(twap, onePart, MAKING_AMOUNT - filled, owner.address)) / toFloat(onePart);
        }
        const available = unlocked - filled;
        if (active && offset >= visibleFrom && available > 0n) {
            const takingAmount = await quoteTakingAmount(twap, available, MAKING_AMOUNT - filled, owner.address);
            const fillPrice = toFloat(takingAmount) / toFloat(available);
            if (fillPrice <= market * (1 - RESOLVER_COST)) {
                const before = await contracts.weth.balanceOf(alice.address);
                const receipt = await fill(contracts, twap.order, twap.signature, available, takingAmount, baseTime + offset);
                const received = (await contracts.weth.balanceOf(alice.address)) - before;
                if (received !== takingAmount) throw new Error(`maker received ${received}, quoted ${takingAmount}`);
                filled += available;
                fills.push({
                    t: offset,
                    making: toFloat(available),
                    taking: toFloat(takingAmount),
                    price: fillPrice,
                    market,
                    costBps: (market - fillPrice) / market * 1e4,
                    parts: Math.round(toFloat(available) * parts / toFloat(MAKING_AMOUNT)),
                    gasUsed: Number(receipt.gasUsed),
                });
            }
        }
        blocks.push({ t: offset, market, price, unlocked: toFloat(unlocked), filled: toFloat(filled) });
    }
    return { parts, interval, visibleFrom, anchoredAt: anchored ? anchoredAt : null, blocks, fills };
}

async function gas(setup) {
    const { contracts, accounts: { alice } } = setup;
    const result = {};

    let id = await snapshot();
    const plainData = await buildCalldataForOrder({
        orderData: {
            maker: alice.address,
            makerAsset: await contracts.dai.getAddress(),
            takerAsset: await contracts.weth.getAddress(),
            makingAmount: MAKING_AMOUNT,
            takingAmount: TAKING_AMOUNT,
            makerTraits: buildMakerTraits(),
        },
        orderSigner: alice,
        setupData: { ...setup, auction: await buildAuctionDetails() },
        threshold: TAKING_AMOUNT / 4n,
        fillingAmount: MAKING_AMOUNT / 4n,
        isInnermostOrder: true,
    });
    const plainGas = [];
    for (const delay of [10, 620]) {
        await time.setNextBlockTimestamp(await time.latest() + delay);
        plainGas.push(Number((await (await contracts.resolver.settleOrders(plainData)).wait()).gasUsed));
    }
    result.plain = { first: plainGas[0], later: plainGas[1] };
    await revert(id);

    for (const anchored of [false, true]) {
        id = await snapshot();
        const startTime = await time.latest() + 60;
        const { order, signature } = await twapOrder(setup, { startTime, interval: 600, parts: 4, initialRateBump: 0n, anchored });
        if (anchored) {
            await time.setNextBlockTimestamp(startTime - 30);
            await (await contracts.registrator.registerOrder(order)).wait();
        }
        const first = await fill(contracts, order, signature, MAKING_AMOUNT / 4n, TAKING_AMOUNT / 4n, startTime + 20);
        const later = await fill(contracts, order, signature, MAKING_AMOUNT / 4n, TAKING_AMOUNT / 4n, startTime + 620);
        result[anchored ? 'anchoredTwap' : 'twap'] = { first: Number(first.gasUsed), later: Number(later.gasUsed) };
        await revert(id);
    }
    return result;
}

async function main() {
    const setup = await initContractsForSettlement();
    const registrator = await deployContract('OrderRegistratorMock', [setup.contracts.lopv4]);
    const twap = await deployContract('FusionTwap', [registrator]);
    await setup.contracts.weth.transfer(setup.contracts.resolver, ether('0.5'));
    setup.contracts = { ...setup.contracts, registrator, twap };

    const seed = 4;
    const sigma = 0.6;
    const prices = marketPath({ seed, sigma, steps: 900 });

    let id = await snapshot();
    const curve = await priceCurve(setup);
    await revert(id);

    id = await snapshot();
    const execution = await execute(setup, { prices, parts: 12, interval: 600, horizon: 7200 });
    await revert(id);

    id = await snapshot();
    const lateFixed = await execute(setup, { prices, parts: 12, interval: 600, visibleFrom: 2700, horizon: 9900 });
    await revert(id);

    id = await snapshot();
    const lateAnchored = await execute(setup, { prices, parts: 12, interval: 600, anchoredAt: 2700, horizon: 9900 });
    await revert(id);

    const gasUsed = await gas(setup);

    const commit = execSync('git rev-parse --short HEAD').toString().trim();
    const output = {
        meta: {
            commit,
            network: 'hardhat',
            settlement: 'SimpleSettlement',
            limitPrice: LIMIT_PRICE,
            arrivalPrice: ARRIVAL_PRICE,
            blockTime: BLOCK_TIME,
            resolverCostBps: RESOLVER_COST * 1e4,
            market: { seed, sigma },
        },
        curve,
        execution,
        late: { fixed: lateFixed, anchored: lateAnchored, delaySeconds: 2700 },
        gas: gasUsed,
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'onchain.json'), JSON.stringify(output, null, 2));
    console.log(`curve samples ${curve.samples}, max deviation from the model ${curve.maxDeviationWei} wei`);
    console.log(`execution fills ${execution.fills.length}, late fixed fills ${lateFixed.fills.length}, late anchored fills ${lateAnchored.fills.length}`);
    console.log(`gas ${JSON.stringify(gasUsed)}`);
    console.log(`wrote ${path.join(OUT_DIR, 'onchain.json')}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
