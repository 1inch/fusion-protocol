const hre = require('hardhat');
const { ethers } = hre;
const constants = require('../config/constants');

async function main () {
    const networkName = hre.network.name;
    const chainId = (await ethers.provider.getNetwork()).chainId.toString();
    console.log(`running ${networkName} (chainId: ${chainId}) mint-kyc script`);

    const kycAddress = constants.ACCESS_TOKEN_ADDRESS[chainId];
    if (!kycAddress) {
        throw new Error(`KycNFT address not found in constants for chainId ${chainId}`);
    }

    const mintTo = constants.MINT_TO[chainId];
    if (!mintTo) {
        throw new Error(`mintTo not found in constants for chainId ${chainId}`);
    }

    const mintTokenId = constants.MINT_TOKEN_ID[chainId];
    if (mintTokenId === undefined || mintTokenId === null || mintTokenId === '') {
        throw new Error(`mintTokenId not found in constants for chainId ${chainId}`);
    }

    const privateKeyEnvVar = networkName.toUpperCase().replace(/-/g, '_') + '_PRIVATE_KEY';
    const privateKey = process.env[privateKeyEnvVar];
    if (!privateKey) {
        throw new Error(`${privateKeyEnvVar} is not set`);
    }

    const signer = new ethers.Wallet(privateKey, ethers.provider);

    console.log(`KycNFT address:  ${kycAddress}`);
    console.log(`Minting to:      ${mintTo}`);
    console.log(`Token ID:        ${mintTokenId}`);
    console.log(`Owner signer:    ${signer.address}`);

    const kyc = await ethers.getContractAt('KycNFT', kycAddress, signer);
    const tx = await kyc.mint(mintTo, mintTokenId);
    console.log(`Transaction sent: ${tx.hash}`);
    await tx.wait();
    console.log(`Mint confirmed: tokenId ${mintTokenId} → ${mintTo}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
