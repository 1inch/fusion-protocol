const { ethers } = require('hardhat');
const { constants, trim0x } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { buildSettlementExtensions } = require('./fusionUtils');

const ANCHORED_FLAG = 1n << 31n;

function buildTwapSchedule({ startTime, interval, parts, anchored = false }) {
    return ethers.solidityPacked(
        ['uint32', 'uint24', 'uint16'],
        [anchored ? BigInt(startTime) | ANCHORED_FLAG : startTime, interval, parts],
    );
}

/**
 * Builds a Fusion order that `FusionTwap` executes as a TWAP in front of the settlement contract.
 * `auctionDetails` is the settlement's regular auction; its start time is replaced by each part's start on fill.
 * The resolver whitelist opens at the schedule start and has no exclusivity windows.
 * `scheduleTarget` is the pre-interaction that enforces the schedule: `twap` itself for a valid order.
 * An anchored schedule ends later when the order is announced late, so it gets no protocol expiry by default;
 * production orders should still set one as the latest acceptable end.
 */
function buildTwapOrder({
    twap,
    settlement,
    orderData,
    schedule,
    auctionDetails,
    estimatedTakingAmount = orderData.takingAmount,
    integratorFeeRecipient = constants.ZERO_ADDRESS,
    protocolFeeRecipient = constants.ZERO_ADDRESS,
    integratorFee = 0,
    resolverFee = 0,
    protocolSurplusFee = 0,
    whitelistResolvers = [], // bytes10[]
    makerTraits = buildMakerTraits({ expiry: schedule.anchored ? 0 : schedule.startTime + schedule.interval * schedule.parts }),
    scheduleTarget = twap,
}) {
    let whitelist = ethers.solidityPacked(['uint8'], [whitelistResolvers.length]);
    let whitelistPostInteraction = ethers.solidityPacked(['uint32', 'uint8'], [schedule.startTime, whitelistResolvers.length]);
    for (const resolver of whitelistResolvers) {
        whitelist += trim0x(resolver);
        whitelistPostInteraction += trim0x(ethers.solidityPacked(['bytes10', 'uint16'], [resolver, 0]));
    }

    const hasFees = integratorFee > 0 || resolverFee > 0 || protocolSurplusFee > 0;
    const makerReceiver = orderData.receiver && orderData.receiver !== constants.ZERO_ADDRESS ? orderData.receiver : undefined;
    const extensions = buildSettlementExtensions({
        feeTaker: settlement,
        estimatedTakingAmount,
        getterExtraPrefix: auctionDetails,
        integratorFeeRecipient,
        protocolFeeRecipient,
        makerReceiver: hasFees ? makerReceiver : undefined,
        integratorFee,
        resolverFee,
        whitelistDiscount: 0,
        whitelist,
        whitelistPostInteraction,
        protocolSurplusFee,
    });

    return buildOrder(
        {
            ...orderData,
            receiver: hasFees ? settlement : orderData.receiver,
            makerTraits,
        },
        {
            makingAmountData: twap + trim0x(extensions.makingAmountData),
            takingAmountData: twap + trim0x(extensions.takingAmountData),
            preInteraction: scheduleTarget ? scheduleTarget + trim0x(buildTwapSchedule(schedule)) : '0x',
            postInteraction: extensions.postInteraction,
        },
    );
}

module.exports = {
    buildTwapSchedule,
    buildTwapOrder,
};
