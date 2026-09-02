const { time, trim0x, constants } = require('@1inch/solidity-utils');
const { ethers } = require('hardhat');
const { buildOrder, buildTakerTraits, signOrder, buildFeeTakerExtensions } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');

const expBase = 999999952502977513n; // 0.05^(1/(2 years)) means 95% value loss over 2 years}

const ANCHOR_FLAG = 0x80000000; // top bit of uint32 timestamps opts into OrderRegistrator anchoring

async function buildCalldataForOrder({
    orderData,
    orderSigner,
    threshold,
    setupData,
    additionalDataForSettlement = '0x',
    isInnermostOrder = false,
    isMakingAmount = true,
    fillingAmount = isMakingAmount ? orderData.makingAmount : orderData.takingAmount,
    integratorFeeRecipient = orderSigner.address,
    protocolFeeRecipient = orderSigner.address,
    resolverFee = 0,
    integratorFee = 0,
    estimatedTakingAmount = orderData.takingAmount,
    protocolSurplusFee = 0,
    whitelistResolvers = [], // bytes10[]
    resolversAllowedTime = [], // uint16[]
    customPostInteraction = '0x',
    whitelistAllowedTime = undefined, // uint32, defaults to auction start time (with the anchor flag if anchored)
    returnOrder = false,
}) {
    const {
        contracts: { lopv4, settlement, resolver },
        others: { chainId },
        auction: { startTime: auctionStartTime, details: auctionDetails, anchored = false },
    } = setupData;

    whitelistAllowedTime = whitelistAllowedTime ?? ((anchored ? BigInt(ANCHOR_FLAG) : 0n) | BigInt(auctionStartTime));
    let whitelist = ethers.solidityPacked(['uint8'], [whitelistResolvers.length]);
    let whitelistPostInteraction = ethers.solidityPacked(['uint32', 'uint8'], [whitelistAllowedTime, whitelistResolvers.length]);
    for (let i = 0; i < whitelistResolvers.length; i++) {
        whitelistPostInteraction += trim0x(ethers.solidityPacked(['bytes10', 'uint16'], [whitelistResolvers[i], resolversAllowedTime[i] || 0]));
        whitelist += trim0x(whitelistResolvers[i]);
    }

    let makerReceiver;
    if (resolverFee > 0 || integratorFee > 0 || protocolSurplusFee > 0) {
        makerReceiver = orderData.receiver;
        orderData.receiver = await settlement.getAddress();
    }

    const order = buildOrder(
        orderData,
        buildSettlementExtensions({
            feeTaker: await settlement.getAddress(),
            estimatedTakingAmount,
            getterExtraPrefix: auctionDetails,
            integratorFeeRecipient,
            protocolFeeRecipient,
            makerReceiver: (makerReceiver && makerReceiver !== constants.ZERO_ADDRESS) ? makerReceiver : undefined,
            integratorFee,
            resolverFee,
            whitelistDiscount: 0,
            whitelist,
            whitelistPostInteraction,
            protocolSurplusFee,
            customPostInteraction,
        }),
    );

    const { r, yParityAndS: vs } = ethers.Signature.from(await signOrder(order, chainId, await lopv4.getAddress(), orderSigner));

    const takerTraits = buildTakerTraits({
        makingAmount: isMakingAmount,
        threshold,
        extension: order.extension,
        interaction: await resolver.getAddress() + (isInnermostOrder ? '01' : '00') + trim0x(additionalDataForSettlement),
        target: await resolver.getAddress(),
    });

    const calldata = lopv4.interface.encodeFunctionData('fillOrderArgs', [
        order,
        r,
        vs,
        fillingAmount,
        takerTraits.traits,
        takerTraits.args,
    ]);

    return returnOrder ? { calldata, order } : calldata;
}

async function buildAuctionDetails({
    gasBumpEstimate = 0,
    gasPriceEstimate = 0,
    startTime, // default is time.latest()
    duration = 1800, // default is 30 minutes
    delay = 0,
    initialRateBump = 0,
    points = [],
    anchored = false, // sets the top bit of the start time to anchor the auction to OrderRegistrator.announcedAt
} = {}) {
    startTime = startTime || await time.latest();
    let details = ethers.solidityPacked(
        ['uint24', 'uint32', 'uint32', 'uint24', 'uint24'], [gasBumpEstimate, gasPriceEstimate, (anchored ? ANCHOR_FLAG : 0) + startTime + delay, duration, initialRateBump],
    );
    details += trim0x(ethers.solidityPacked(['uint8'], [points.length]));
    for (let i = 0; i < points.length; i++) {
        details += trim0x(ethers.solidityPacked(['uint24', 'uint16'], [points[i][0], points[i][1]]));
    }
    return { gasBumpEstimate, gasPriceEstimate, startTime, duration, delay, initialRateBump, details, anchored };
}

function buildSettlementExtensions({
    feeTaker,
    estimatedTakingAmount,
    getterExtraPrefix = '0x',
    integratorFeeRecipient = constants.ZERO_ADDRESS,
    protocolFeeRecipient = constants.ZERO_ADDRESS,
    makerReceiver = undefined,
    integratorFee = 0,
    integratorShare = 50,
    resolverFee = 0,
    whitelistDiscount = 50,
    whitelist = '0x00',
    whitelistPostInteraction = whitelist,
    protocolSurplusFee = 0,
    customMakingGetter = '0x',
    customTakingGetter = '0x',
    customPostInteraction = '0x',
}) {
    const feeTakerExtensionsObj = buildFeeTakerExtensions({
        feeTaker,
        getterExtraPrefix,
        integratorFeeRecipient,
        protocolFeeRecipient,
        makerReceiver,
        integratorFee,
        integratorShare,
        resolverFee,
        whitelistDiscount,
        whitelist,
        whitelistPostInteraction,
        customMakingGetter,
        customTakingGetter,
        customPostInteraction: '0x',
    });

    const postInteraction = ethers.solidityPacked(
        ['bytes', 'uint256', 'uint8', 'bytes'],
        [feeTakerExtensionsObj.postInteraction, estimatedTakingAmount, protocolSurplusFee, customPostInteraction],
    );

    return {
        makingAmountData: feeTakerExtensionsObj.makingAmountData,
        takingAmountData: feeTakerExtensionsObj.takingAmountData,
        postInteraction,
    };
}

module.exports = {
    expBase,
    ANCHOR_FLAG,
    buildAuctionDetails,
    buildCalldataForOrder,
    buildSettlementExtensions,
};
