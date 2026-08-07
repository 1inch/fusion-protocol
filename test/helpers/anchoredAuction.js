const { ethers } = require('hardhat');

const BASE_POINTS = 10_000_000n; // 100%

const ANCHORED_FLAG = 0x01n;
// Exclusivity-blob flag namespace: 0x01 is shared with ANCHORED_FLAG.
const ANNOUNCEMENT_DEADLINE_FLAG = 0x02n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** The auction encoding the deployed settlement reads, which is the anchored one without its flags byte. */
function buildLegacyAuctionDetails({
    gasBumpEstimate = 0,
    gasPriceEstimate = 0,
    startTime = 0,
    duration = 0,
    initialRateBump = 0,
    points = [],
} = {}) {
    const types = ['uint24', 'uint32', 'uint32', 'uint24', 'uint24', 'uint8'];
    const values = [gasBumpEstimate, gasPriceEstimate, startTime, duration, initialRateBump, points.length];
    for (const { coefficient, delay } of points) {
        types.push('uint24', 'uint16');
        values.push(coefficient, delay);
    }
    return ethers.solidityPacked(types, values);
}

/** Zero fees and an empty whitelist, so a settlement getter passes its input straight through. */
const NO_FEE_DATA = ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint8'], [0, 0, 0, 0, 0]);

/** Packs the AuctionDetails blob read by the FusionAnchoredAuction getters. */
function buildAnchoredAuctionDetails({
    gasBumpEstimate = 0,
    gasPriceEstimate = 0,
    startTime = 0,
    duration = 0,
    initialRateBump = 0,
    anchored = false,
    points = [],
} = {}) {
    let flags = 0n;
    const types = ['uint8', 'uint24', 'uint32', 'uint32', 'uint24', 'uint24'];
    const values = [0, gasBumpEstimate, gasPriceEstimate, startTime, duration, initialRateBump];

    if (anchored) {
        flags |= ANCHORED_FLAG;
    }

    types.push('uint8');
    values.push(points.length);
    for (const { coefficient, delay } of points) {
        types.push('uint24', 'uint16');
        values.push(coefficient, delay);
    }
    values[0] = flags;

    return ethers.solidityPacked(types, values);
}

/**
 * Packs the resolver exclusivity read by FusionAnchoredAuction.postInteraction. `whitelist` entries are
 * `{ address, delta }`, where `delta` is the wait until the next resolver may fill.
 */
function buildAnchoredExclusivity({
    allowedTime = 0,
    allowedTimeDelay = undefined,
    announcementDeadlineDelay = undefined,
    whitelist = [],
} = {}) {
    let flags = 0n;
    const types = ['uint8', 'uint32'];
    const values = [0, allowedTime];

    if (allowedTimeDelay !== undefined) {
        flags |= ANCHORED_FLAG;
        types.push('uint24');
        values.push(allowedTimeDelay);
    }
    if (announcementDeadlineDelay !== undefined) {
        flags |= ANNOUNCEMENT_DEADLINE_FLAG;
        types.push('uint24');
        values.push(announcementDeadlineDelay);
    }

    types.push('uint8');
    values.push(whitelist.length);
    for (const { address, delta = 0 } of whitelist) {
        types.push('uint80', 'uint16');
        values.push(BigInt(address) & ((1n << 80n) - 1n), delta);
    }
    values[0] = flags;

    return ethers.solidityPacked(types, values);
}

/** Mirrors DutchAuctionBase._getAuctionBump. */
function auctionBumpAt(timestamp, { startTime, duration, initialRateBump, points = [] }) {
    const now = BigInt(timestamp);
    const start = BigInt(startTime);
    const finish = start + BigInt(duration);
    if (now <= start) return BigInt(initialRateBump);
    if (now >= finish) return 0n;

    let currentPointTime = start;
    let currentRateBump = BigInt(initialRateBump);
    for (const { coefficient, delay } of points) {
        const nextRateBump = BigInt(coefficient);
        const nextPointTime = currentPointTime + BigInt(delay);
        if (now <= nextPointTime) {
            return ((now - currentPointTime) * nextRateBump + (nextPointTime - now) * currentRateBump) / (nextPointTime - currentPointTime);
        }
        currentRateBump = nextRateBump;
        currentPointTime = nextPointTime;
    }
    return (finish - now) * currentRateBump / (finish - currentPointTime);
}

/** Mirrors the gas bump offset from the rate bump. */
function applyGasBump(rateBump, gasBump) {
    return rateBump > gasBump ? rateBump - gasBump : 0n;
}

/** Taking amount a fill by making amount is priced at. */
function takingAmountFor(order, auction, timestamp, makingAmount, remainingMakingAmount, gasBump = 0n) {
    const rateBump = applyGasBump(auctionBumpAt(timestamp, auction), gasBump);
    const unbumped = ceilDiv(order.takingAmount * makingAmount, order.makingAmount);
    return ceilDiv(unbumped * (BASE_POINTS + rateBump), BASE_POINTS);
}

module.exports = {
    BASE_POINTS,
    NO_FEE_DATA,
    ceilDiv,
    buildLegacyAuctionDetails,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    takingAmountFor,
};
