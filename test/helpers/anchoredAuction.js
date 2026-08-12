const { ethers } = require('hardhat');

const BASE_POINTS = 10_000_000n; // 100%

// Top bit of a uint32 timestamp, free until 19 January 2038.
const ANCHORED_FLAG = 1n << 31n;
// Top bit of the uint24 anchored allowed-time delay.
const ANNOUNCEMENT_DEADLINE_FLAG = 1n << 23n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Zero fees and an empty whitelist, so a settlement getter passes its input straight through. */
const NO_FEE_DATA = ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint8'], [0, 0, 0, 0, 0]);

/**
 * Packs the AuctionDetails blob read by the settlement getters. With `anchored` unset the bytes are
 * exactly the legacy encoding; anchoring only sets the top bit of the packed start time.
 */
function buildAnchoredAuctionDetails({
    gasBumpEstimate = 0,
    gasPriceEstimate = 0,
    startTime = 0,
    duration = 0,
    initialRateBump = 0,
    anchored = false,
    points = [],
} = {}) {
    const packedStartTime = BigInt(startTime) | (anchored ? ANCHORED_FLAG : 0n);
    const types = ['uint24', 'uint32', 'uint32', 'uint24', 'uint24', 'uint8'];
    const values = [gasBumpEstimate, gasPriceEstimate, packedStartTime, duration, initialRateBump, points.length];
    for (const { coefficient, delay } of points) {
        types.push('uint24', 'uint16');
        values.push(coefficient, delay);
    }
    return ethers.solidityPacked(types, values);
}

/**
 * Packs the resolver exclusivity read by the settlement post-interaction: the absolute allowed time
 * and whitelist exactly as the legacy encoding, with the anchored fields carried on the top bits.
 * `whitelist` entries are `{ address, delta }`, where `delta` is the wait until the next resolver may fill.
 */
function buildAnchoredExclusivity({
    allowedTime = 0,
    allowedTimeDelay = undefined,
    announcementDeadlineDelay = undefined,
    whitelist = [],
} = {}) {
    if (announcementDeadlineDelay !== undefined && allowedTimeDelay === undefined) {
        // The deadline flag lives inside the anchored delay field, so the combination cannot be encoded.
        throw new Error('announcementDeadlineDelay requires allowedTimeDelay');
    }

    const types = ['uint32'];
    const values = [BigInt(allowedTime) | (allowedTimeDelay !== undefined ? ANCHORED_FLAG : 0n)];

    if (allowedTimeDelay !== undefined) {
        types.push('uint24');
        values.push(BigInt(allowedTimeDelay) | (announcementDeadlineDelay !== undefined ? ANNOUNCEMENT_DEADLINE_FLAG : 0n));
    }
    if (announcementDeadlineDelay !== undefined) {
        types.push('uint24');
        values.push(announcementDeadlineDelay);
    }

    types.push('uint8');
    values.push(whitelist.length);
    for (const { address, delta = 0 } of whitelist) {
        types.push('uint80', 'uint16');
        values.push(BigInt(address) & ((1n << 80n) - 1n), delta);
    }

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
    auctionBumpAt,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    takingAmountFor,
};
