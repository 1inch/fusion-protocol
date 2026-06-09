const constants = require('./constants.json');

module.exports = {
    ACCESS_TOKEN_SALT: constants.accessTokenSalt || {},
    ACCESS_TOKEN_OWNER: constants.accessTokenOwner || {},
    CREATE3_DEPLOYERS: constants.create3Deployers || {},
    SETTLEMENT_SALT: constants.settlementSalt || {},
    SETTLEMENT_OWNER_ADDRESS: constants.settlementOwnerAddress || {},
    ACCESS_TOKEN_ADDRESS: constants.accessTokenAddress || {},
    WETH: constants.weth || {},
    ROUTER_V6_ADDRESS: constants.routerV6Address || {},
    ST1INCH_ADDR: constants.st1inchAddr || {},
    DAO_ADDRESS: constants.daoAddress || {},
    POWER_POD_ADDRESS: constants.powerPodAddress || {},
    WHITELIST_REGISTRY_ADDRESS: constants.whitelistRegistryAddress || {},
    MINT_TO: constants.mintTo || {},
    MINT_TOKEN_ID: constants.mintTokenId || {},
    CONTRACT_ADDRESS: constants.contractAddress || {},
    NEW_OWNER: constants.newOwner || {},
};
