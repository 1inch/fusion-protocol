const hre = require('hardhat');
const { ethers } = hre;
const constants = require('../config/constants');

const OWNABLE_ABI = [
    'function owner() view returns (address)',
    'function transferOwnership(address newOwner)',
];

// OZ v5 Ownable custom error selector: OwnableUnauthorizedAccount(address)
const OWNABLE_UNAUTHORIZED_SELECTOR = ethers.id('OwnableUnauthorizedAccount(address)').slice(0, 10);

async function main () {
    const networkName = hre.network.name;
    const chainId = (await ethers.provider.getNetwork()).chainId.toString();
    console.log(`running ${networkName} (chainId: ${chainId}) transfer-ownership script`);

    const contractAddress = constants.CONTRACT_ADDRESS[chainId];
    if (!contractAddress) {
        throw new Error(`contractAddress not found in constants for chainId ${chainId}`);
    }

    const newOwner = constants.NEW_OWNER[chainId];
    if (!newOwner) {
        throw new Error(`newOwner not found in constants for chainId ${chainId}`);
    }

    const privateKeyEnvVar = networkName.toUpperCase().replace(/-/g, '_') + '_PRIVATE_KEY';
    const privateKey = process.env[privateKeyEnvVar];
    if (!privateKey) {
        throw new Error(`${privateKeyEnvVar} is not set`);
    }

    const signer = new ethers.Wallet(privateKey, ethers.provider);

    console.log(`Contract address: ${contractAddress}`);
    console.log(`New owner:        ${newOwner}`);
    console.log(`Caller (signer):  ${signer.address}`);

    const contract = new ethers.Contract(contractAddress, OWNABLE_ABI, signer);

    // Verify the target is a valid Ownable contract and check current owner before sending a tx.
    let currentOwner;
    try {
        currentOwner = await contract.owner();
    } catch {
        throw new Error(`[Error type 2] Target is not a valid Ownable contract at ${contractAddress}`);
    }

    console.log(`Current owner:    ${currentOwner}`);

    if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(`[Error type 1] Caller ${signer.address} is not the owner (owner is ${currentOwner})`);
    }

    try {
        const tx = await contract.transferOwnership(newOwner);
        console.log(`Transaction sent: ${tx.hash}`);
        await tx.wait();
        console.log(`Ownership transferred: ${currentOwner} → ${newOwner}`);
    } catch (err) {
        const data = err?.data ?? err?.revert?.data ?? err?.info?.error?.data;
        if (typeof data === 'string' && data.startsWith(OWNABLE_UNAUTHORIZED_SELECTOR)) {
            throw new Error(`[Error type 1] Caller ${signer.address} is not the owner`);
        }
        throw new Error(`[Error type 2] transferOwnership failed: ${err.message}`);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
