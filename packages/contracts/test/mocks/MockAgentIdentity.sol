// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Stands in for the ERC-8004 Identity Registry: the registry only needs ownerOf, including
///         its revert on an unknown id.
contract MockAgentIdentity is ERC721 {
    constructor() ERC721("Mock Agent Identity", "AGENT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}
