const { ethers } = require('hardhat');

const BASE_POINTS = 10_000_000n; // 100%

const ANCHORED_FLAG = 0x01n;
const FILL_CURVE_FLAG = 0x02n;
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
    fillPremiums = undefined,
    points = [],
} = {}) {
    let flags = 0n;
    const types = ['uint8', 'uint24', 'uint32', 'uint32', 'uint24', 'uint24'];
    const values = [0, gasBumpEstimate, gasPriceEstimate, startTime, duration, initialRateBump];

    if (anchored) {
        flags |= ANCHORED_FLAG;
    }
    if (fillPremiums !== undefined) {
        flags |= FILL_CURVE_FLAG;
        types.push('uint24', 'uint8');
        values.push(fillPremiums.initial, fillPremiums.points.length);
        for (const { premium, shareDelta } of fillPremiums.points) {
            types.push('uint24', 'uint16');
            values.push(premium, shareDelta);
        }
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

const SHARE_BASE = 10_000n;

/** Mirrors FusionAnchoredAuction._fillPremium: the fill's share of what remains, on a fresh ladder. */
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

/** Mirrors FusionAnchoredAuction._rateBumpForFill. */
function rateBumpForFill(rateBump, auction, makingAmount, remainingMakingAmount) {
    if (!auction.fillPremiums || makingAmount >= remainingMakingAmount) return rateBump;
    return rateBump + fillPremiumAt(makingAmount, remainingMakingAmount, auction.fillPremiums);
}

/** Mirrors the gas bump offset from the rate bump. */
function applyGasBump(rateBump, gasBump) {
    return rateBump > gasBump ? rateBump - gasBump : 0n;
}

/** Taking amount a fill by making amount is priced at. */
function takingAmountFor(order, auction, timestamp, makingAmount, remainingMakingAmount, gasBump = 0n) {
    const rateBump = applyGasBump(rateBumpForFill(auctionBumpAt(timestamp, auction), auction, makingAmount, remainingMakingAmount), gasBump);
    const unbumped = ceilDiv(order.takingAmount * makingAmount, order.makingAmount);
    return ceilDiv(unbumped * (BASE_POINTS + rateBump), BASE_POINTS);
}

/** Making amount a fill by taking amount is priced at, including the conservative fill-share estimate. */
function makingAmountFor(order, auction, timestamp, takingAmount, remainingMakingAmount, gasBump = 0n) {
    const bump = auctionBumpAt(timestamp, auction);
    const unbumped = order.makingAmount * takingAmount / order.takingAmount;
    let rateBump = bump;
    if (auction.fillPremiums) {
        // Premium curves are enforced non-increasing, so the initial premium is the worst one.
        const worstRateBump = bump + BigInt(auction.fillPremiums.initial);
        const estimate = unbumped * BASE_POINTS / (BASE_POINTS + applyGasBump(worstRateBump, gasBump));
        rateBump = rateBumpForFill(bump, auction, estimate, remainingMakingAmount);
    }
    return unbumped * BASE_POINTS / (BASE_POINTS + applyGasBump(rateBump, gasBump));
}

module.exports = {
    BASE_POINTS,
    NO_FEE_DATA,
    ceilDiv,
    buildLegacyAuctionDetails,
    buildAnchoredAuctionDetails,
    buildAnchoredExclusivity,
    fillPremiumAt,
    takingAmountFor,
    makingAmountFor,
};
