// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  NaiveChitFund
 * @notice A deliberately vulnerable baseline, modelled on the designs found in
 *         the reviewed literature. This contract is NOT part of the proposed
 *         system. It exists so the attacks can be demonstrated succeeding
 *         against prior art and then failing against ChitFund.sol.
 *
 *  Reproduced weaknesses:
 *
 *   V1  Open plaintext bidding.      Kumar & Sangal (2020) expose bidding() with a
 *                                    raw value and pick the lowest. Every pending
 *                                    bid is readable before the round closes, so a
 *                                    rival can simply undercut it.
 *   V2  Identity by address only.    No nullifier. A member who defaults or is
 *                                    removed re-registers from a fresh wallet and
 *                                    arrives with a clean record, which is what
 *                                    makes credit scoring (TruChit, 2024) hollow.
 *   V3  Unilateral operator control. A single administrator releases the pot.
 *                                    TruChit's threat model simply assumes this
 *                                    party "can not be compromised".
 */
contract NaiveChitFund {
    address public operator;
    uint256 public monthlyContribution;
    uint256 public groupSize;
    uint256 public currentRound;

    mapping(address => bool) public isMember;
    mapping(address => bool) public hasWon;
    address[] public memberList;

    mapping(uint256 => uint256) public pot;
    mapping(uint256 => mapping(address => bool)) public deposited;
    mapping(uint256 => mapping(address => uint256)) public bidOf;   // V1: public and plaintext
    mapping(uint256 => address[]) public bidders;
    mapping(uint256 => address) public winnerOf;
    mapping(uint256 => uint256) public winningBidOf;
    mapping(uint256 => bool) public releasedOf;

    event Registered(address indexed member);
    event BidPlaced(uint256 indexed round, address indexed bidder, uint256 amount); // leaks the value
    event AuctionClosed(uint256 indexed round, address indexed winner, uint256 amount);
    event PayoutReleased(uint256 indexed round, address indexed winner, uint256 amount);

    constructor(address _operator, uint256 _monthlyContribution, uint256 _groupSize) {
        operator = _operator;
        monthlyContribution = _monthlyContribution;
        groupSize = _groupSize;
    }

    // V2: nothing binds a membership to a person, only to an address.
    function register(address member) external {
        require(msg.sender == operator, "only operator");
        require(!isMember[member], "already a member");
        isMember[member] = true;
        memberList.push(member);
        emit Registered(member);
    }

    function startRound() external {
        require(msg.sender == operator, "only operator");
        currentRound++;
    }

    function deposit() external payable {
        require(isMember[msg.sender], "not a member");
        require(msg.value == monthlyContribution, "incorrect contribution");
        require(!deposited[currentRound][msg.sender], "already deposited");
        deposited[currentRound][msg.sender] = true;
        pot[currentRound] += msg.value;
    }

    // V1: the bid is written in the clear and emitted in an event. Anyone
    // watching the chain, or the mempool, sees it before the round closes.
    function placeBid(uint256 amount) external {
        require(isMember[msg.sender], "not a member");
        require(!hasWon[msg.sender], "already prized");
        require(amount <= pot[currentRound], "bid exceeds pot");
        if (bidOf[currentRound][msg.sender] == 0) bidders[currentRound].push(msg.sender);
        bidOf[currentRound][msg.sender] = amount;
        emit BidPlaced(currentRound, msg.sender, amount);
    }

    /// @notice Anyone can read every bid at any time. This is the attack surface.
    function peekBids(uint256 round)
        external view
        returns (address[] memory addrs, uint256[] memory amounts)
    {
        addrs = bidders[round];
        amounts = new uint256[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) amounts[i] = bidOf[round][addrs[i]];
    }

    function closeAuction() external {
        require(msg.sender == operator, "only operator");
        address[] storage bs = bidders[currentRound];
        require(bs.length > 0, "no bids");

        address best = bs[0];
        uint256 bestAmount = bidOf[currentRound][bs[0]];
        for (uint256 i = 1; i < bs.length; i++) {
            uint256 a = bidOf[currentRound][bs[i]];
            if (a < bestAmount) { bestAmount = a; best = bs[i]; }
        }
        winnerOf[currentRound] = best;
        winningBidOf[currentRound] = bestAmount;
        hasWon[best] = true;
        emit AuctionClosed(currentRound, best, bestAmount);
    }

    // V3: one signature moves the money.
    function releasePayout(uint256 round) external {
        require(msg.sender == operator, "only operator");
        require(!releasedOf[round], "already released");
        address w = winnerOf[round];
        require(w != address(0), "no winner");
        releasedOf[round] = true;
        (bool ok, ) = payable(w).call{value: winningBidOf[round]}("");
        require(ok, "transfer failed");
        emit PayoutReleased(round, w, winningBidOf[round]);
    }

    /// @notice V3 in its starkest form: the operator can simply take the pot.
    function drainTo(address destination) external {
        require(msg.sender == operator, "only operator");
        (bool ok, ) = payable(destination).call{value: address(this).balance}("");
        require(ok, "transfer failed");
    }

    function memberCount() external view returns (uint256) { return memberList.length; }
    function bidderCount(uint256 round) external view returns (uint256) { return bidders[round].length; }
}
