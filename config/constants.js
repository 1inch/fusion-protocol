const constants = require('./constants.json');

module.exports = {
    ACCESS_TOKEN_SALT: constants.accessTokenSalt || {},
    ACCESS_TOKEN_OWNER: constants.accessTokenOwner || {},
    CREATE3_DEPLOYERS: constants.create3Deployers || {},
};
