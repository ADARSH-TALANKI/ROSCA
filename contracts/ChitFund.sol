// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  ChitFund
 * @notice Trust-minimized chit fund (ROSCA) with a multi-round descending
 *         sealed-bid auction.
 *
 *  Addresses the four research gaps identified in the Phase 1 literature review:
 *
 *   G1  Auction integrity   -> multi-round commit-reveal. The bid value is absent
 *                              from the chain until its reveal window opens, so it
 *                              cannot be observed in the mempool and front-run.
 *   G2  Default after payout -> missed deposits are recorded, dividends are diverted
 *                              to arrears, and persistent default is written against
 *                              the member's nullifier permanently.
 *   G3  Duplicate identity  -> one-way nullifier registry. One real person maps to
 *                              exactly one membership; no identity document is stored.
 *   G4  Concentrated authority -> payout requires 2-of-3 approval across Registrar,
 *                              ChitCo and Auditor. The operator can never release
 *                              funds alone.
 *
 *  THE AUCTION
 *
 *  A single sealed round defeats sniping but destroys price discovery: a bidder
 *  has no idea what anyone else will accept, so the winning discount is whichever
 *  blind guess happened to be boldest. A physical chit auction does not work that
 *  way. Subscribers sit in a room, hear the standing bid called out, and decide
 *  whether to go lower.
 *
 *  This contract reproduces that while keeping the anti-sniping property:
 *
 *    bidding round 1:  commit -> reveal -> publish the standing lowest bid
 *    bidding round 2:  commit -> reveal -> publish the standing lowest bid
 *    bidding round 3:  commit -> reveal -> settle
 *
 *  Inside a bidding round nobody can see anyone else's number. Between rounds the
 *  standing bid is public, so the auction converges rather than guessing. A later
 *  bid must come in STRICTLY BELOW the standing bid, which makes the auction
 *  monotonically descending and guarantees it terminates.
 *
 *  A subscriber who does not wish to go lower simply does not commit again. If a
 *  bidding round produces no improvement, the auction settles immediately rather
 *  than running the remaining rounds, because no later round could improve either:
 *  the admissible window only ever narrows.
 *
 *  DELIBERATE DISCLOSURE
 *
 *  The standing bidder's address is observable between bidding rounds. That is
 *  intentional and mirrors the physical auction, where everyone in the room can
 *  see who is bidding. It is also unavoidable: contract storage is publicly
 *  readable whatever the declared visibility, so treating it as hidden would be a
 *  false claim rather than a security property.
 *
 *  RANDOMNESS
 *
 *  Tied bids are drawn by lot. The draw is seeded from the revealed salts rather
 *  than from block data. Every bidder commits to a salt before knowing anything,
 *  so no participant controls the aggregate, and because the seed does not depend
 *  on block timing the operator cannot dry-run the closing call off-chain and
 *  submit only when the draw favours a chosen bidder.
 *
 *  The residual weakness is that the last bidder to reveal could withhold in order
 *  to change the seed, but withholding forfeits their own bid, which is a strictly
 *  worse trade. The empty-auction lottery still falls back to block.prevrandao,
 *  because with no reveals there are no salts to draw from; that path remains
 *  demo-grade and is reported as a known limitation.
 */
contract ChitFund {
    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_DISCOUNT_BPS = 3_000; // 30% cap, Chit Funds Act 1982
    uint8   public constant REQUIRED_APPROVALS = 2;   // of 3 organisations
    uint8   public constant DEFAULT_THRESHOLD = 3;    // missed deposits before default
    uint8   public constant MAX_BIDDING_ROUNDS_CAP = 5;

    // ------------------------------------------------------------------- roles

    address public immutable registrar; // government, verifies personhood
    address public immutable chitCo;    // operator, runs the chit
    address public immutable auditor;   // independent validator

    // ------------------------------------------------------------------ config

    uint256 public immutable monthlyContribution;
    uint256 public immutable groupSize;
    uint8   public immutable biddingRounds; // sealed bidding rounds per monthly cycle

    // ------------------------------------------------------------------- state

    enum Phase { Idle, Deposit, Commit, Reveal, Settled }

    struct Member {
        bool    registered;
        bool    hasWon;         // prized subscriber: barred from bidding again
        uint8   missedPayments;
        bool    defaulted;
        uint256 dividends;      // withdrawable
        uint256 arrears;        // owed to the pool
    }

    struct Round {
        Phase   phase;
        uint8   biddingRound;   // 0 before bidding opens, then 1..biddingRounds
        uint256 pot;
        uint256 depositCount;
        uint256 standingBid;    // 0 until someone reveals a lawful bid
        address standingBidder;
        address winner;
        uint256 winningBid;
        uint256 discount;
        bool    released;
        uint8   approvalCount;
    }

    mapping(address => Member)  public members;
    mapping(address => bytes32) public nullifierOf;
    mapping(bytes32 => bool)    public nullifierUsed;   // G3
    address[] public memberList;

    uint256 public currentRound;
    mapping(uint256 => Round) public rounds;

    // keyed by (monthly round, bidding round, member)
    mapping(uint256 => mapping(uint8 => mapping(address => bytes32))) public commitmentOf;
    mapping(uint256 => mapping(uint8 => mapping(address => bool)))    public hasRevealed;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public revealedBid;
    mapping(uint256 => mapping(uint8 => address[])) private revealers;

    // the standing bid as it stood at the end of each bidding round, for audit
    mapping(uint256 => mapping(uint8 => uint256)) public bestBidAt;
    mapping(uint256 => mapping(uint8 => address)) public bestBidderAt;

    mapping(uint256 => mapping(address => bool)) public hasDeposited;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    /// Accumulated from revealed salts. Seeds tie-breaks; no single party controls it.
    mapping(uint256 => bytes32) private revealSeed;

    // ------------------------------------------------------------------ events

    event MemberRegistered(address indexed member, bytes32 indexed nullifier);
    event RoundStarted(uint256 indexed roundId);
    event Deposited(uint256 indexed roundId, address indexed member, uint256 amount);
    event PaymentMissed(uint256 indexed roundId, address indexed member, uint8 totalMissed);
    event MemberDefaulted(address indexed member, bytes32 indexed nullifier);
    event BiddingRoundOpened(uint256 indexed roundId, uint8 indexed biddingRound, uint256 standingBid);
    event BidCommitted(uint256 indexed roundId, uint8 indexed biddingRound, address indexed member);
    event RevealOpened(uint256 indexed roundId, uint8 indexed biddingRound);
    event BidRevealed(uint256 indexed roundId, uint8 indexed biddingRound, address indexed member, uint256 amount);
    event StandingBidUpdated(uint256 indexed roundId, uint8 indexed biddingRound, address indexed bidder, uint256 amount);
    event BiddingRoundClosed(uint256 indexed roundId, uint8 indexed biddingRound, bool improved);
    event AuctionClosed(uint256 indexed roundId, address indexed winner, uint256 winningBid, uint256 discount, uint8 roundsUsed);
    event LotteryFallback(uint256 indexed roundId, address indexed winner);
    event PayoutApproved(uint256 indexed roundId, address indexed approver, uint8 approvals);
    event PayoutReleased(uint256 indexed roundId, address indexed winner, uint256 amount);
    event DividendDiverted(uint256 indexed roundId, address indexed member, uint256 amount);
    event DividendClaimed(address indexed member, uint256 amount);

    // --------------------------------------------------------------- modifiers

    modifier onlyRegistrar() { require(msg.sender == registrar, "only registrar"); _; }
    modifier onlyChitCo()    { require(msg.sender == chitCo,    "only chitco");    _; }
    modifier onlyMember()    { require(members[msg.sender].registered, "not a member"); _; }

    // ------------------------------------------------------------- constructor

    constructor(
        address _registrar,
        address _chitCo,
        address _auditor,
        uint256 _monthlyContribution,
        uint256 _groupSize,
        uint8   _biddingRounds
    ) {
        require(_registrar != address(0) && _chitCo != address(0) && _auditor != address(0), "zero address");
        require(_registrar != _chitCo && _chitCo != _auditor && _registrar != _auditor, "roles must differ");
        require(_groupSize > 1, "group too small");
        require(_monthlyContribution > 0, "contribution must be > 0");
        require(_biddingRounds >= 1 && _biddingRounds <= MAX_BIDDING_ROUNDS_CAP, "bidding rounds out of range");

        registrar = _registrar;
        chitCo = _chitCo;
        auditor = _auditor;
        monthlyContribution = _monthlyContribution;
        groupSize = _groupSize;
        biddingRounds = _biddingRounds;
    }

    // -------------------------------------------------- G3: Sybil-resistant join

    /**
     * @notice Registrar admits a member after off-chain KYC.
     * @param  nullifier keccak256(governmentId, platformSalt), computed off-chain.
     *         The identity document itself never reaches the chain. The same person
     *         presenting a second wallet recomputes the same nullifier and is refused.
     *
     *         The nullifier check runs before the capacity check on purpose: a
     *         re-registration attempt by an already-enrolled person is an identity
     *         violation and is rejected whether or not the group has room left.
     */
    function registerMember(address member, bytes32 nullifier) external onlyRegistrar {
        require(member != address(0), "zero member");
        require(nullifier != bytes32(0), "zero nullifier");
        require(!members[member].registered, "address already registered");
        require(!nullifierUsed[nullifier], "nullifier already used");
        require(memberList.length < groupSize, "group full");

        nullifierUsed[nullifier] = true;
        nullifierOf[member] = nullifier;
        members[member].registered = true;
        memberList.push(member);

        emit MemberRegistered(member, nullifier);
    }

    // ------------------------------------------------------------ round control

    function startRound() external onlyChitCo {
        require(memberList.length == groupSize, "group not full");
        require(currentRound < groupSize, "chit complete");
        if (currentRound > 0) {
            require(rounds[currentRound].released, "previous payout pending");
        }
        currentRound++;
        rounds[currentRound].phase = Phase.Deposit;
        emit RoundStarted(currentRound);
    }

    /// @notice Every member contributes, including prized subscribers who still owe installments.
    function deposit() external payable onlyMember {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Deposit, "not deposit phase");
        require(!hasDeposited[currentRound][msg.sender], "already deposited");
        require(msg.value == monthlyContribution, "incorrect contribution");

        hasDeposited[currentRound][msg.sender] = true;
        r.pot += msg.value;
        r.depositCount++;

        emit Deposited(currentRound, msg.sender, msg.value);
    }

    /// @notice Closes deposits, records misses (G2), and opens bidding round 1.
    function openBidding() external onlyChitCo {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Deposit, "not deposit phase");

        uint256 len = memberList.length;
        for (uint256 i = 0; i < len; i++) {
            address m = memberList[i];
            if (!hasDeposited[currentRound][m]) {
                Member storage mem = members[m];
                mem.missedPayments += 1;
                mem.arrears += monthlyContribution;
                emit PaymentMissed(currentRound, m, mem.missedPayments);
                if (mem.missedPayments >= DEFAULT_THRESHOLD && !mem.defaulted) {
                    mem.defaulted = true;
                    emit MemberDefaulted(m, nullifierOf[m]);
                }
            }
        }

        r.phase = Phase.Commit;
        r.biddingRound = 1;
        emit BiddingRoundOpened(currentRound, 1, 0);
    }

    // ------------------------------- G1: multi-round commit-reveal sealed bidding

    /// @param commitment keccak256(abi.encodePacked(amount, salt, bidder))
    function commitBid(bytes32 commitment) external onlyMember {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Commit, "not commit phase");
        require(commitment != bytes32(0), "empty commitment");

        Member storage m = members[msg.sender];
        require(!m.hasWon, "already prized this cycle");
        require(!m.defaulted, "member in default");
        require(hasDeposited[currentRound][msg.sender], "deposit required before bidding");
        require(commitmentOf[currentRound][r.biddingRound][msg.sender] == bytes32(0), "already committed");

        commitmentOf[currentRound][r.biddingRound][msg.sender] = commitment;
        emit BidCommitted(currentRound, r.biddingRound, msg.sender);
    }

    function openReveal() external onlyChitCo {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Commit, "not commit phase");
        r.phase = Phase.Reveal;
        emit RevealOpened(currentRound, r.biddingRound);
    }

    /**
     * @notice Opens a sealed bid. Lower is better: the bid is how much of the pot
     *         the subscriber is willing to accept, and the rest becomes dividend.
     *
     *         From bidding round 2 onward the bid must strictly improve on the
     *         published standing bid. That is what makes the auction descending and
     *         what guarantees it terminates.
     */
    function revealBid(uint256 amount, uint256 salt) external onlyMember {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Reveal, "not reveal phase");

        uint8 br = r.biddingRound;
        bytes32 c = commitmentOf[currentRound][br][msg.sender];
        require(c != bytes32(0), "nothing committed");
        require(!hasRevealed[currentRound][br][msg.sender], "already revealed");
        require(keccak256(abi.encodePacked(amount, salt, msg.sender)) == c, "commitment mismatch");

        uint256 floorBid = (r.pot * (BPS - MAX_DISCOUNT_BPS)) / BPS;
        require(amount >= floorBid, "discount exceeds statutory cap");
        require(amount <= r.pot, "bid exceeds pot");
        if (r.standingBid != 0) {
            require(amount < r.standingBid, "must improve on the standing bid");
        }

        hasRevealed[currentRound][br][msg.sender] = true;
        revealedBid[currentRound][br][msg.sender] = amount;
        revealers[currentRound][br].push(msg.sender);

        // Contributes to the tie-break seed. Committed before anyone knew anything.
        revealSeed[currentRound] = keccak256(abi.encodePacked(revealSeed[currentRound], salt));

        emit BidRevealed(currentRound, br, msg.sender, amount);
    }

    /**
     * @notice Tallies the current bidding round, publishes the new standing bid,
     *         and either opens the next bidding round or settles the auction.
     *
     *         Settles early when nobody improved, because no later round could
     *         improve either: the admissible window only ever narrows.
     */
    function closeBiddingRound() external onlyChitCo {
        Round storage r = rounds[currentRound];
        require(r.phase == Phase.Reveal, "not reveal phase");

        uint8 br = r.biddingRound;
        address[] storage revs = revealers[currentRound][br];
        bool improved = revs.length > 0;

        if (improved) {
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < revs.length; i++) {
                uint256 b = revealedBid[currentRound][br][revs[i]];
                if (b < best) best = b;
            }

            uint256 tiedCount;
            for (uint256 i = 0; i < revs.length; i++) {
                if (revealedBid[currentRound][br][revs[i]] == best) tiedCount++;
            }

            address picked;
            if (tiedCount == 1) {
                for (uint256 i = 0; i < revs.length; i++) {
                    if (revealedBid[currentRound][br][revs[i]] == best) { picked = revs[i]; break; }
                }
            } else {
                // Draw among equal bidders, as the Act prescribes on a tie.
                uint256 pick = _seededPick(tiedCount);
                uint256 seen;
                for (uint256 i = 0; i < revs.length; i++) {
                    if (revealedBid[currentRound][br][revs[i]] == best) {
                        if (seen == pick) { picked = revs[i]; break; }
                        seen++;
                    }
                }
            }

            r.standingBid = best;
            r.standingBidder = picked;
            bestBidAt[currentRound][br] = best;
            bestBidderAt[currentRound][br] = picked;
            emit StandingBidUpdated(currentRound, br, picked, best);
        }

        emit BiddingRoundClosed(currentRound, br, improved);

        if (improved && br < biddingRounds) {
            r.biddingRound = br + 1;
            r.phase = Phase.Commit;
            emit BiddingRoundOpened(currentRound, br + 1, r.standingBid);
        } else {
            _settle(r, br);
        }
    }

    function _settle(Round storage r, uint8 roundsUsed) private {
        address winner = r.standingBidder;

        if (winner == address(0)) {
            // Nobody ever bid lawfully: statutory lottery among eligible members,
            // who then receive the full undiscounted pot.
            winner = _lotteryPick();
            require(winner != address(0), "no eligible member");
            r.winningBid = r.pot;
            emit LotteryFallback(currentRound, winner);
        } else {
            r.winningBid = r.standingBid;
        }

        r.winner = winner;
        r.discount = r.pot - r.winningBid;
        members[winner].hasWon = true;
        r.phase = Phase.Settled;

        emit AuctionClosed(currentRound, winner, r.winningBid, r.discount, roundsUsed);
    }

    // ----------------------------------------- G4: distributed payout authority

    function approvePayout(uint256 roundId) external {
        require(
            msg.sender == registrar || msg.sender == chitCo || msg.sender == auditor,
            "not an approving organisation"
        );
        Round storage r = rounds[roundId];
        require(r.phase == Phase.Settled, "auction not closed");
        require(!r.released, "already released");
        require(!approvedBy[roundId][msg.sender], "already approved");

        approvedBy[roundId][msg.sender] = true;
        r.approvalCount += 1;

        emit PayoutApproved(roundId, msg.sender, r.approvalCount);
    }

    /**
     * @notice Releases the pot. Requires 2 of 3 organisations. Because there are
     *         exactly three approvers, any valid pair includes at least one party
     *         other than ChitCo: the operator can never release funds unilaterally.
     */
    function releasePayout(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.phase == Phase.Settled, "auction not closed");
        require(!r.released, "already released");
        require(r.approvalCount >= REQUIRED_APPROVALS, "insufficient approvals");

        r.released = true;

        // G2: discount is shared among non-winners, but a member in arrears has
        // their share diverted to cover what they owe before anything is paid out.
        uint256 shareCount = memberList.length - 1;
        uint256 share = shareCount > 0 ? r.discount / shareCount : 0;

        if (share > 0) {
            for (uint256 i = 0; i < memberList.length; i++) {
                address m = memberList[i];
                if (m == r.winner) continue;
                Member storage mem = members[m];
                if (mem.arrears > 0) {
                    uint256 applied = share > mem.arrears ? mem.arrears : share;
                    mem.arrears -= applied;
                    emit DividendDiverted(roundId, m, applied);
                    if (share > applied) mem.dividends += (share - applied);
                } else {
                    mem.dividends += share;
                }
            }
        }

        (bool ok, ) = payable(r.winner).call{value: r.winningBid}("");
        require(ok, "payout transfer failed");

        emit PayoutReleased(roundId, r.winner, r.winningBid);
    }

    function claimDividend() external onlyMember {
        uint256 amount = members[msg.sender].dividends;
        require(amount > 0, "nothing to claim");
        members[msg.sender].dividends = 0; // effects before interaction
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "dividend transfer failed");
        emit DividendClaimed(msg.sender, amount);
    }

    // ----------------------------------------------------------------- helpers

    /**
     * @dev Tie-break seeded from the revealed salts. Every salt was committed
     *      before its bidder knew anything about the others, and the operator
     *      cannot change the result by choosing when to call.
     */
    function _seededPick(uint256 modulus) private view returns (uint256) {
        bytes32 seed = revealSeed[currentRound];
        if (seed == bytes32(0)) {
            // Unreachable from closeBiddingRound (a tie implies reveals happened),
            // kept as a guard rather than relying on a zero seed.
            seed = keccak256(abi.encodePacked(block.prevrandao, currentRound));
        }
        return uint256(seed) % modulus;
    }

    /**
     * @dev Empty-auction lottery. No salts exist on this path, so it still leans on
     *      block.prevrandao and remains demo-grade. A production deployment would
     *      use a VRF or a commit-reveal beacon. Documented as a known limitation.
     */
    function _lotteryPick() private view returns (address) {
        uint256 eligible;
        for (uint256 i = 0; i < memberList.length; i++) {
            Member storage m = members[memberList[i]];
            if (!m.hasWon && !m.defaulted && hasDeposited[currentRound][memberList[i]]) eligible++;
        }
        if (eligible == 0) return address(0);

        uint256 pick = uint256(
            keccak256(abi.encodePacked(block.prevrandao, block.timestamp, currentRound))
        ) % eligible;

        uint256 seen;
        for (uint256 i = 0; i < memberList.length; i++) {
            address a = memberList[i];
            Member storage m = members[a];
            if (!m.hasWon && !m.defaulted && hasDeposited[currentRound][a]) {
                if (seen == pick) return a;
                seen++;
            }
        }
        return address(0);
    }

    // ------------------------------------------------------------- view helpers

    function memberCount() external view returns (uint256) { return memberList.length; }

    function revealCount(uint256 roundId, uint8 biddingRound) external view returns (uint256) {
        return revealers[roundId][biddingRound].length;
    }

    function standingOf(uint256 roundId)
        external view
        returns (address bidder, uint256 amount, uint8 biddingRound_)
    {
        Round storage r = rounds[roundId];
        return (r.standingBidder, r.standingBid, r.biddingRound);
    }

    /**
     * @notice The window a bid must land in to be accepted at reveal.
     *         `lowest` is the statutory 30% ceiling on the discount. `highest`
     *         tightens each bidding round: once a standing bid exists, a new bid
     *         must come in strictly below it.
     */
    function bidBounds(uint256 roundId) public view returns (uint256 lowest, uint256 highest) {
        Round storage r = rounds[roundId];
        lowest = (r.pot * (BPS - MAX_DISCOUNT_BPS)) / BPS;
        highest = r.standingBid == 0 ? r.pot : r.standingBid - 1;
    }

    function minimumAcceptableBid(uint256 roundId) external view returns (uint256) {
        Round storage r = rounds[roundId];
        return (r.pot * (BPS - MAX_DISCOUNT_BPS)) / BPS;
    }

    // ------------------------------------------------- batched views for the UI

    struct MemberView {
        address addr;
        bytes32 nullifier;
        bool    registered;
        bool    hasWon;
        uint8   missedPayments;
        bool    defaulted;
        uint256 dividends;
        uint256 arrears;
        bool    deposited;
        bytes32 commitment;     // this bidding round
        bool    revealed;       // this bidding round
        uint256 revealedAmount; // this bidding round
        bool    isStanding;     // currently holds the standing lowest bid
    }

    /// @notice One call returns the whole member board for the current bidding round.
    function getAllMembers() external view returns (MemberView[] memory out) {
        uint256 n = memberList.length;
        Round storage r = rounds[currentRound];
        uint8 br = r.biddingRound;
        out = new MemberView[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = memberList[i];
            Member storage m = members[a];
            out[i] = MemberView({
                addr: a,
                nullifier: nullifierOf[a],
                registered: m.registered,
                hasWon: m.hasWon,
                missedPayments: m.missedPayments,
                defaulted: m.defaulted,
                dividends: m.dividends,
                arrears: m.arrears,
                deposited: hasDeposited[currentRound][a],
                commitment: commitmentOf[currentRound][br][a],
                revealed: hasRevealed[currentRound][br][a],
                revealedAmount: revealedBid[currentRound][br][a],
                isStanding: r.standingBidder == a && r.standingBid != 0
            });
        }
    }

    struct RoundView {
        uint256 id;
        Phase   phase;
        uint8   biddingRound;
        uint8   maxBiddingRounds;
        uint256 pot;
        uint256 depositCount;
        uint256 standingBid;
        address standingBidder;
        address winner;
        uint256 winningBid;
        uint256 discount;
        bool    released;
        uint8   approvalCount;
        bool    registrarApproved;
        bool    chitCoApproved;
        bool    auditorApproved;
        uint256 minimumBid;     // statutory floor
        uint256 maximumBid;     // must beat the standing bid
        uint256 contractBalance;
    }

    function getRoundView() external view returns (RoundView memory) {
        Round storage r = rounds[currentRound];
        (uint256 lo, uint256 hi) = bidBounds(currentRound);
        return RoundView({
            id: currentRound,
            phase: r.phase,
            biddingRound: r.biddingRound,
            maxBiddingRounds: biddingRounds,
            pot: r.pot,
            depositCount: r.depositCount,
            standingBid: r.standingBid,
            standingBidder: r.standingBidder,
            winner: r.winner,
            winningBid: r.winningBid,
            discount: r.discount,
            released: r.released,
            approvalCount: r.approvalCount,
            registrarApproved: approvedBy[currentRound][registrar],
            chitCoApproved: approvedBy[currentRound][chitCo],
            auditorApproved: approvedBy[currentRound][auditor],
            minimumBid: lo,
            maximumBid: hi,
            contractBalance: address(this).balance
        });
    }

    /// @notice The standing bid as it stood after each bidding round, for the audit trail.
    function biddingHistory(uint256 roundId)
        external view
        returns (uint256[] memory amounts, address[] memory bidders)
    {
        amounts = new uint256[](biddingRounds);
        bidders = new address[](biddingRounds);
        for (uint8 i = 0; i < biddingRounds; i++) {
            amounts[i] = bestBidAt[roundId][i + 1];
            bidders[i] = bestBidderAt[roundId][i + 1];
        }
    }

    function config()
        external view
        returns (
            address reg, address op, address aud,
            uint256 contribution, uint256 size,
            uint8 required, uint8 defaultThreshold,
            uint256 maxDiscountBps, uint8 bidRounds
        )
    {
        return (
            registrar, chitCo, auditor,
            monthlyContribution, groupSize,
            REQUIRED_APPROVALS, DEFAULT_THRESHOLD,
            MAX_DISCOUNT_BPS, biddingRounds
        );
    }
}
