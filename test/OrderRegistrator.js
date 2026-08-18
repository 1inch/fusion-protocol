const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { ethers } = require('hardhat');
const { expect, deployContract } = require('@1inch/solidity-utils');
const { buildOrder, signOrder } = require('@1inch/limit-order-protocol-contract/test/helpers/orderUtils');
const { initContractsForSettlement } = require('./helpers/fixtures');

// The anchored auction trusts the package OrderRegistrator to record `announcedAt` exactly once;
// these tests pin that upstream invariant so a dependency bump cannot silently change it.
describe('OrderRegistrator', function () {
    async function prepareOrder() {
        const setupData = await loadFixture(initContractsForSettlement);
        const {
            contracts: { dai, weth, lopv4 },
            accounts: { owner, alice },
            others: { chainId },
        } = setupData;

        const registrator = await deployContract('OrderRegistrator', [lopv4]);

        const order = buildOrder({
            maker: alice.address,
            makerAsset: await weth.getAddress(),
            takerAsset: await dai.getAddress(),
            makingAmount: 1,
            takingAmount: 2,
        });
        const signature = ethers.Signature.from(
            await signOrder(order, chainId, await lopv4.getAddress(), alice),
        ).compactSerialized;
        const orderHash = await lopv4.hashOrder(order);

        return { lopv4, registrator, order, orderHash, signature, owner, alice, chainId };
    }

    it('stores the announcement timestamp on first registration', async function () {
        const { registrator, order, orderHash, signature } = await prepareOrder();

        expect(await registrator.announcedAt(orderHash)).to.equal(0);

        const orderTuple = [order.salt, order.maker, order.receiver, order.makerAsset, order.takerAsset, order.makingAmount, order.takingAmount, order.makerTraits];
        const tx = await registrator.registerOrder(order, order.extension, signature);
        await expect(tx).to.emit(registrator, 'OrderRegistered').withArgs(orderTuple, order.extension, signature);

        const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
        expect(await registrator.announcedAt(orderHash)).to.equal(block.timestamp);
    });

    it('does not shift the timestamp on repeated registration', async function () {
        const { registrator, order, orderHash, signature } = await prepareOrder();

        await registrator.registerOrder(order, order.extension, signature);
        const announcedAt = await registrator.announcedAt(orderHash);

        await time.increase(1000);
        await expect(registrator.registerOrder(order, order.extension, signature))
            .to.emit(registrator, 'OrderRegistered');
        expect(await registrator.announcedAt(orderHash)).to.equal(announcedAt);
    });

    it('reverts on invalid signature and stores nothing', async function () {
        const { lopv4, registrator, order, orderHash, owner, chainId } = await prepareOrder();

        // Signed by owner while the order maker is alice
        const wrongSignature = ethers.Signature.from(
            await signOrder(order, chainId, await lopv4.getAddress(), owner),
        ).compactSerialized;

        await expect(registrator.registerOrder(order, order.extension, wrongSignature))
            .to.be.revertedWithCustomError(registrator, 'BadSignature');
        expect(await registrator.announcedAt(orderHash)).to.equal(0);
    });

    it('reverts on invalid extension and stores nothing', async function () {
        const { registrator, order, orderHash, signature } = await prepareOrder();

        const orderLib = await ethers.getContractFactory('OrderLib');
        await expect(registrator.registerOrder(order, order.extension + '00', signature))
            .to.be.revertedWithCustomError(orderLib, 'UnexpectedOrderExtension');
        expect(await registrator.announcedAt(orderHash)).to.equal(0);
    });
});
