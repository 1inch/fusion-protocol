// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { ERC721Burnable } from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@1inch/solidity-utils/contracts/libraries/ECDSA.sol";

/**
 * @title KycNFT
 * @notice ERC721 token that allows only one NFT per address and includes transfer, mint and burn logic restricted to the contract owner.
 */
contract KycNFT is Ownable, ERC721Burnable, EIP712 {
    /// @notice Thrown when an address attempts to own more than one NFT.
    error OnlyOneNFTPerAddress();
    /// @notice Thrown when signature is incorrect.
    error BadSignature();
    /// @notice Thrown when signature is expired.
    error SignatureExpired();

    bytes32 public constant MINT_TYPEHASH = keccak256("Mint(address to,uint256 nonce,uint256 tokenId,uint256 deadline)");
    bytes32 public constant TRANSFER_FROM_TYPEHASH = keccak256("TransferFrom(address to,uint256 nonce,uint256 tokenId,uint256 deadline)");

    /// @notice Nonce for each token ID.
    mapping(uint256 => uint256) public nonces;

    /**
     * @notice Ensures that the provided signature is valid and signed by the contract owner.
     * @param tokenId The ID of the token.
     * @param signature The signature to be verified.
     */
    modifier onlyOwnerSignature(address to, uint256 tokenId, uint256 deadline, bytes calldata signature, bytes32 typeHash) {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 structHash = keccak256(abi.encode(typeHash, to, nonces[tokenId], tokenId, deadline));
        bytes32 hash = _hashTypedDataV4(structHash);
        if (owner() != ECDSA.recover(hash, signature)) revert BadSignature();
        _;
    }

    /**
     * @notice Constructor that initializes the ERC721 token with a name and a symbol, and sets the contract owner.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param owner The address of the owner of the contract.
     */
    constructor(string memory name, string memory symbol, string memory version, address owner)
        ERC721(name, symbol) Ownable(owner) EIP712(name, version) {}

    /**
     * @notice Transfers a token to a specified address. Only the owner can call this function.
     * @param from The address to transfer the token from.
     * @param to The address to transfer the token to.
     * @param tokenId The ID of the token to be transferred.
     */
    function transferFrom(address from, address to, uint256 tokenId) public override onlyOwner {
        _transfer(from, to, tokenId);
    }

    /**
     * @notice Transfers a token from one account to another by the designated token owner, using the contract owner's valid signature. Executable by anyone.
     * @param from The address to transfer the token from.
     * @param to The address to transfer the token to.
     * @param tokenId The ID of the token to be transferred.
     * @param deadline The deadline for the signature.
     * @param signature The signature of the owner permitting the transfer.
     */
    function transferFrom(address from, address to, uint256 tokenId, uint256 deadline, bytes calldata signature) public onlyOwnerSignature(to, tokenId, deadline, signature, TRANSFER_FROM_TYPEHASH) {
        _transfer(from, to, tokenId);
    }

    /**
     * @dev Mints a new token to a specified address. Only the owner can call this function.
     * @param to The address to mint the token to.
     * @param tokenId The ID of the token to be minted.
     */
    function mint(address to, uint256 tokenId) external onlyOwner {
        _mint(to, tokenId);
    }

    /**
     * @notice See {mint} method. This function using a valid owner's signature instead of only owner permission.
     * @param deadline The deadline for the signature.
     * @param signature The signature of the owner permitting the mint.
     */
    function mint(address to, uint256 tokenId, uint256 deadline, bytes calldata signature) external onlyOwnerSignature(to, tokenId, deadline, signature, MINT_TYPEHASH) {
        _mint(to, tokenId);
    }

    /**
     * @dev Burns a specified token. The owner can burn any token.
     * @param tokenId The ID of the token to be burned.
     */
    function burn(uint256 tokenId) public override {
        if (_msgSender() == owner()) {
            _burn(tokenId);
        } else {
            super.burn(tokenId);
        }
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to != address(0) && balanceOf(to) > 0) revert OnlyOneNFTPerAddress();
        nonces[tokenId]++;
        return super._update(to, tokenId, auth);
    }
}
