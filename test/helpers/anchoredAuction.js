const { ethers } = require('hardhat');

const BASE_POINTS = 10_000_000n; // 100%

// Top bit of a uint32 timestamp, free until 19 January 2038.
const ANCHORED_FLAG = 1n << 31n;
// Top bit of the uint24 anchored allowed-time delay.
const ANNOUNCEMENT_DEADLINE_FLAG = 1n << 23n;
// Top bit of the uint8 auction points count.
const FILL_CURVE_FLAG = 1n << 7n;
// Fill shares are measured in 1e4.
const SHARE_BASE = 10_000n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Zero fees and an empty whitelist, so a settlement getter passes its input straight through. */
const NO_FEE_DATA = ethers.solidityPacked(['uint16', 'uint8', 'uint16', 'uint8', 'uint8'], [0, 0, 0, 0, 0]);

/** Packs the AuctionDetails blob; with no options set the bytes are exactly the legacy encoding. */
function buildAnchoredAuctionDetails({
    gasBumpEstimate = 0,
    gasPriceEstimate = 0,
    startTime = 0,
    duration = 0,
    initialRateBump = 0,
    anchored = false,
    fillPremiums = undefined,
    points = [],
} = {}) {
    const packedStartTime = BigInt(startTime) | (anchored ? ANCHORED_FLAG : 0n);
    const packedPointsCount = BigInt(points.length) | (fillPremiums !== undefined ? FILL_CURVE_FLAG : 0n);
    const types = ['uint24', 'uint32', 'uint32', 'uint24', 'uint24', 'uint8'];
    const values = [gasBumpEstimate, gasPriceEstimate, packedStartTime, duration, initialRateBump, packedPointsCount];
    for (const { coefficient, delay } of points) {
        types.push('uint24', 'uint16');
        values.push(coefficient, delay);
    }
    if (fillPremiums !== undefined) {
        types.push('uint24', 'uint8');
        values.push(fillPremiums.initial, fillPremiums.points.length);
        for (const { premium, shareDelta } of fillPremiums.points) {
            types.push('uint24', 'uint16');
            values.push(premium, shareDelta);
        }
    }
    return ethers.solidityPacked(types, values);
}

/** Packs the whitelist blob; anchored fields ride on the top bits, legacy bytes otherwise. */
function buildAnchoredExclusivity({
    allowedTime = 0,
    allowedTimeDelay = undefined,
    announcementDeadlineDelay = undefined,
    whitelist = [],
} = {}) {
    if (announcementDeadlineDelay !== undefined && allowedTimeDelay === undefined) {
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

/** Mirrors PartialFillPremiumAuction._fillPremium. */
function fillPremiumAt(makingAmount, remainingMakingAmount, { initial, points = [] }) {
    let currentPremium = BigInt(initial);
    const share = makingAmount * SHARE_BASE / remainingMakingAmount;
    if (share === 0n) return currentPremium;

    let currentShare = 0n;
    for (const { premium, shareDelta } of points) {
        const nextPremium = BigInt(premium);
        const nextShare = currentShare + BigInt(shareDelta);
        if (share <= nextShare) {
            return ((share - currentShare) * nextPremium + (nextShare - share) * currentPremium) / (nextShare - currentShare);
        }
        currentPremium = nextPremium;
        currentShare = nextShare;
    }
    return (SHARE_BASE - share) * currentPremium / (SHARE_BASE - currentShare);
}

/** Mirrors PartialFillPremiumAuction._fillRateBump. */
function rateBumpForFill(auctionBump, auction, makingAmount, remainingMakingAmount) {
    if (!auction.fillPremiums || makingAmount >= remainingMakingAmount) return auctionBump;
    return auctionBump + fillPremiumAt(makingAmount, remainingMakingAmount, auction.fillPremiums);
}

/** Taking amount a fill by making amount is priced at. */
function takingAmountFor(order, auction, timestamp, makingAmount, remainingMakingAmount, gasBump = 0n) {
    const rateBump = applyGasBump(rateBumpForFill(auctionBumpAt(timestamp, auction), auction, makingAmount, remainingMakingAmount), gasBump);
    const unbumped = ceilDiv(order.takingAmount * makingAmount, order.makingAmount);
    return ceilDiv(unbumped * (BASE_POINTS + rateBump), BASE_POINTS);
}

/** Making amount a fill by taking amount is priced at, with the conservative fill-share estimate. */
function makingAmountFor(order, auction, timestamp, takingAmount, remainingMakingAmount, gasBump = 0n) {
    const auctionBump = auctionBumpAt(timestamp, auction);
    const unbumped = order.makingAmount * takingAmount / order.takingAmount;
    let rateBump = auctionBump;
    if (auction.fillPremiums) {
        // Premium curves are enforced non-increasing, so the initial premium is the worst one.
        const worstRateBump = applyGasBump(auctionBump + BigInt(auction.fillPremiums.initial), gasBump);
        const estimate = unbumped * BASE_POINTS / (BASE_POINTS + worstRateBump);
        rateBump = rateBumpForFill(auctionBump, auction, estimate, remainingMakingAmount);
    }
    return unbumped * BASE_POINTS / (BASE_POINTS + applyGasBump(rateBump, gasBump));
}

module.exports = {
    BASE_POINTS,
    NO_FEE_DATA,
    ceilDiv,
    auctionBumpAt,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    fillPremiumAt,
    takingAmountFor,
    makingAmountFor,
};
