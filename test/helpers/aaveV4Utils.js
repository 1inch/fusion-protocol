const { ethers } = require('hardhat');
const { trim0x, constants } = require('@1inch/solidity-utils');
const { buildOrder, buildMakerTraits } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { buildSettlementExtensions } = require('./fusionUtils');

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// SwapParams.flags of AaveV4CollateralSwap
const SwapFlags = {
    RenounceAllowance: 1n,
    RequireCollateral: 2n,
};

const SWAP_PARAMS_ABI = 'tuple(address spoke, uint256 sellReserveId, uint256 buyReserveId, uint256 minHealthFactor, uint256 maxDust, uint256 flags)';

const PERMITS_ABI = 'tuple(' +
    'tuple(address onBehalfOf, tuple(address positionManager, bool approve)[] updates, uint256 nonce, uint256 deadline) positionManagers, ' +
    'bytes positionManagersSignature, ' +
    'tuple(address spoke, uint256 reserveId, bool useAsCollateral, address onBehalfOf, uint256 nonce, uint256 deadline) collateral, ' +
    'bytes collateralSignature, ' +
    'tuple(address spoke, uint256 reserveId, address owner, address spender, uint256 amount, uint256 nonce, uint256 deadline) withdrawal, ' +
    'bytes withdrawalSignature)';

// EIP-712 types of the Aave V4 intents. Domains: name 'Spoke', 'SignatureGateway' or 'TakerPositionManager', version '1',
// verifying contract = the Spoke, SignatureGateway or TakerPositionManager of the chain.
const AaveV4Types = {
    SetUserPositionManagers: {
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
    SetUsingAsCollateral: {
        SetUsingAsCollateral: [
            { name: 'spoke', type: 'address' },
            { name: 'reserveId', type: 'uint256' },
            { name: 'useAsCollateral', type: 'bool' },
            { name: 'onBehalfOf', type: 'address' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
        ],
    },
    WithdrawPermit: {
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
};

const OrderTypes = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'makerAsset', type: 'address' },
        { name: 'takerAsset', type: 'address' },
        { name: 'makingAmount', type: 'uint256' },
        { name: 'takingAmount', type: 'uint256' },
        { name: 'makerTraits', type: 'uint256' },
    ],
};

function encodeSwapParams({ spoke, sellReserveId, buyReserveId, minHealthFactor = 0n, maxDust = 0n, flags = 0n }) {
    return abiCoder.encode([SWAP_PARAMS_ABI], [{ spoke, sellReserveId, buyReserveId, minHealthFactor, maxDust, flags }]);
}

function emptyPermits() {
    return {
        positionManagers: { onBehalfOf: constants.ZERO_ADDRESS, updates: [], nonce: 0n, deadline: 0n },
        positionManagersSignature: '0x',
        collateral: { spoke: constants.ZERO_ADDRESS, reserveId: 0n, useAsCollateral: false, onBehalfOf: constants.ZERO_ADDRESS, nonce: 0n, deadline: 0n },
        collateralSignature: '0x',
        withdrawal: {
            spoke: constants.ZERO_ADDRESS,
            reserveId: 0n,
            owner: constants.ZERO_ADDRESS,
            spender: constants.ZERO_ADDRESS,
            amount: 0n,
            nonce: 0n,
            deadline: 0n,
        },
        withdrawalSignature: '0x',
    };
}

function encodePermits(permits) {
    return abiCoder.encode([PERMITS_ABI], [permits]);
}

// Aave V4 nonces are keyed: the top 192 bits are a key, the low 64 bits count per key.
// A random key per permit keeps permits of different orders independent of each other.
function randomKeyedNonce() {
    return BigInt(ethers.hexlify(ethers.randomBytes(24))) << 64n;
}

/**
 * Signs the maker's Aave V4 intents for one collateral swap order.
 * `owner` is the position owner; it differs from `signer` for EIP-1271 wallets.
 * `withdrawAmount` defaults to the persistent max allowance; exact-allowance orders pass
 * makingAmount + maxDust plus a small rounding buffer.
 * `deadline` must not be earlier than the order expiry.
 */
async function signAaveV4Permits({
    signer,
    owner = signer.address,
    chainId,
    spoke,
    giver,
    taker,
    signatureGateway,
    adapter,
    sellReserveId,
    buyReserveId,
    deadline,
    withdrawAmount = ethers.MaxUint256,
    approveManagers = true,
    enableCollateral = true,
    grantWithdrawal = true,
}) {
    const domain = (name, verifyingContract) => ({ name, version: '1', chainId, verifyingContract });
    const permits = emptyPermits();

    if (approveManagers) {
        permits.positionManagers = {
            onBehalfOf: owner,
            updates: [giver, taker, signatureGateway].map(positionManager => ({ positionManager, approve: true })),
            nonce: randomKeyedNonce(),
            deadline,
        };
        permits.positionManagersSignature = await signer.signTypedData(
            domain('Spoke', spoke), AaveV4Types.SetUserPositionManagers, permits.positionManagers,
        );
    }

    if (enableCollateral) {
        permits.collateral = {
            spoke,
            reserveId: buyReserveId,
            useAsCollateral: true,
            onBehalfOf: owner,
            nonce: randomKeyedNonce(),
            deadline,
        };
        permits.collateralSignature = await signer.signTypedData(
            domain('SignatureGateway', signatureGateway), AaveV4Types.SetUsingAsCollateral, permits.collateral,
        );
    }

    if (grantWithdrawal) {
        permits.withdrawal = {
            spoke,
            reserveId: sellReserveId,
            owner,
            spender: adapter,
            amount: withdrawAmount,
            nonce: randomKeyedNonce(),
            deadline,
        };
        permits.withdrawalSignature = await signer.signTypedData(
            domain('TakerPositionManager', taker), AaveV4Types.WithdrawPermit, permits.withdrawal,
        );
    }

    return { permits, encoded: encodePermits(permits) };
}

/**
 * Builds an order that swaps `makingAmount` of the maker's supply in `swapParams.sellReserveId`
 * for at least `takingAmount` of the buy reserve's underlying, supplied to the maker's position.
 *
 * With `settlementExtension` it is a Fusion order: the Settlement prices it and takes fees, then calls the adapter
 * as its chained post-interaction. The object takes the `buildSettlementExtensions` options except `feeTaker`,
 * `makerReceiver` and `customPostInteraction`, which are set here. Without it, it is a plain limit order with the
 * adapter as receiver and post-interaction.
 */
function buildAaveV4CollateralSwapOrder({
    maker,
    adapter,
    settlement,
    takerAsset,
    makingAmount,
    takingAmount,
    swapParams,
    permits = '0x',
    makerTraits = buildMakerTraits(),
    settlementExtension,
}) {
    const extensions = {
        makerAssetSuffix: encodeSwapParams(swapParams),
        preInteraction: adapter + trim0x(permits),
    };
    let receiver = adapter;

    if (settlementExtension) {
        const { integratorFee = 0, resolverFee = 0, protocolSurplusFee = 0 } = settlementExtension;
        const takesFees = integratorFee > 0 || resolverFee > 0 || protocolSurplusFee > 0;
        if (takesFees) {
            receiver = settlement;
        }
        Object.assign(extensions, buildSettlementExtensions({
            ...settlementExtension,
            feeTaker: settlement,
            makerReceiver: takesFees ? adapter : undefined,
            customPostInteraction: adapter,
        }));
    } else {
        extensions.postInteraction = adapter;
    }

    return buildOrder({ maker, receiver, makerAsset: adapter, takerAsset, makingAmount, takingAmount, makerTraits }, extensions);
}

/**
 * Signs an order for the Limit Order Protocol deployment `protocol`, reading its EIP-712 domain on-chain,
 * so the same code works for a local LimitOrderProtocol and for 1inch Router V6.
 */
async function signOrderFor(protocol, order, signer) {
    const { name, version, chainId, verifyingContract } = await protocol.eip712Domain();
    return signer.signTypedData({ name, version, chainId, verifyingContract }, OrderTypes, order);
}

module.exports = {
    SwapFlags,
    AaveV4Types,
    OrderTypes,
    SWAP_PARAMS_ABI,
    PERMITS_ABI,
    encodeSwapParams,
    encodePermits,
    emptyPermits,
    randomKeyedNonce,
    signAaveV4Permits,
    buildAaveV4CollateralSwapOrder,
    signOrderFor,
};
