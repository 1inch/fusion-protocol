// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IAaveV4SignatureGateway } from "../../interfaces/aave-v4/IAaveV4SignatureGateway.sol";
import { AaveV4SpokeMock } from "./AaveV4SpokeMock.sol";
import { SignedCallsMock } from "./SignedCallsMock.sol";

contract AaveV4SignatureGatewayMock is IAaveV4SignatureGateway, SignedCallsMock {
    function setUsingAsCollateralWithSig(SetUsingAsCollateral calldata params, bytes calldata /* signature */) external {
        if (!_consumeIntent(params.onBehalfOf, params.nonce)) return;
        AaveV4SpokeMock(params.spoke).setUsingAsCollateral(params.reserveId, params.useAsCollateral, params.onBehalfOf);
    }
}
