// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Stands in for the ERC-8004 Identity Registry in tests. The only behaviour the registry
///         depends on is that ownerOf returns the agent owner and reverts for an id nobody has
///         registered, which is what OpenZeppelin ERC721 already does.
contract MockAgentIdentity is ERC721 {
    constructor() ERC721("Mock Agent Identity", "AGENT") {}

    /// @notice Registers an agent id to an owner.
    /// @param to The wallet that will own the agent.
    /// @param id The agent id.
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}
