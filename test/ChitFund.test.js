const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------- helpers

const E = (n) => ethers.parseEther(n.toString());

/** The commitment the contract checks: keccak256(amount, salt, bidder). */
const commit = (amount, salt, bidder) =>
  ethers.solidityPackedKeccak256(["uint256", "uint256", "address"], [amount, salt, bidder]);

/** Stands in for keccak256(governmentId, platformSalt), computed off-chain. */
const nullifier = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const randSalt = () => BigInt(ethers.hexlify(ethers.randomBytes(8)));

const CONTRIBUTION = E(1);
const GROUP_SIZE = 5;
const BIDDING_ROUNDS = 3;
const POT = E(5);
const FLOOR = E(3.5); // 30% statutory cap on a 5 ETH pot

const Phase = { Idle: 0, Deposit: 1, Commit: 2, Reveal: 3, Settled: 4 };

describe("ChitFund", function () {
  // -------------------------------------------------------------- fixtures

  async function deployFixture() {
    const [deployer, registrar, chitCo, auditor, a, b, c, d, e, outsider] =
      await ethers.getSigners();
    const F = await ethers.getContractFactory("ChitFund");
    const chit = await F.connect(deployer).deploy(
      registrar.address, chitCo.address, auditor.address,
      CONTRIBUTION, GROUP_SIZE, BIDDING_ROUNDS
    );
    await chit.waitForDeployment();
    return { chit, deployer, registrar, chitCo, auditor, members: [a, b, c, d, e], outsider };
  }

  async function registeredFixture() {
    const f = await loadFixture(deployFixture);
    for (let i = 0; i < GROUP_SIZE; i++) {
      await f.chit.connect(f.registrar).registerMember(f.members[i].address, nullifier(`DOC-${i}`));
    }
    return f;
  }

  async function depositedFixture() {
    const f = await loadFixture(registeredFixture);
    await f.chit.connect(f.chitCo).startRound();
    for (const m of f.members) await f.chit.connect(m).deposit({ value: CONTRIBUTION });
    return f;
  }

  async function biddingOpenFixture() {
    const f = await loadFixture(depositedFixture);
    await f.chit.connect(f.chitCo).openBidding();
    return f;
  }

  /** commit -> reveal -> close, for one bidding round. bids: [{member, amount}] */
  async function playBiddingRound(chit, chitCo, bids) {
    const salts = [];
    for (const { member, amount } of bids) {
      const salt = randSalt();
      salts.push(salt);
      await chit.connect(member).commitBid(commit(amount, salt, member.address));
    }
    await chit.connect(chitCo).openReveal();
    for (let i = 0; i < bids.length; i++) {
      await chit.connect(bids[i].member).revealBid(bids[i].amount, salts[i]);
    }
    await chit.connect(chitCo).closeBiddingRound();
    return salts;
  }

  /** Nobody commits, so the auction settles on the standing bid. */
  async function settleNow(chit, chitCo) {
    await chit.connect(chitCo).openReveal();
    await chit.connect(chitCo).closeBiddingRound();
  }

  /** Full round: one bidding round of bids, then settle, approve and release. */
  async function settledFixture() {
    const f = await loadFixture(biddingOpenFixture);
    const [a, b, c] = f.members;
    await playBiddingRound(f.chit, f.chitCo, [
      { member: a, amount: E(4.2) },
      { member: b, amount: E(4.5) },
      { member: c, amount: E(4.8) },
    ]);
    await settleNow(f.chit, f.chitCo);
    return f;
  }

  // -------------------------------------------- G3: Sybil resistance (nullifier)

  describe("G3 - Sybil resistance via nullifier registry", function () {
    it("registers a member and records the nullifier as used", async function () {
      const { chit, registrar, members } = await loadFixture(deployFixture);
      const n = nullifier("AADHAAR-4321");
      await expect(chit.connect(registrar).registerMember(members[0].address, n))
        .to.emit(chit, "MemberRegistered").withArgs(members[0].address, n);
      expect(await chit.nullifierUsed(n)).to.equal(true);
      expect(await chit.memberCount()).to.equal(1);
    });

    it("ATTACK: the same person cannot rejoin under a fresh address", async function () {
      const { chit, registrar, members, outsider } = await loadFixture(deployFixture);
      const n = nullifier("AADHAAR-4321");
      await chit.connect(registrar).registerMember(members[0].address, n);
      await expect(chit.connect(registrar).registerMember(outsider.address, n))
        .to.be.revertedWith("nullifier already used");
    });

    it("refuses a repeat nullifier even when the group still has room", async function () {
      const { chit, registrar, members, outsider } = await loadFixture(deployFixture);
      const n = nullifier("AADHAAR-4321");
      await chit.connect(registrar).registerMember(members[0].address, n);
      expect(await chit.memberCount()).to.be.lessThan(GROUP_SIZE);
      await expect(chit.connect(registrar).registerMember(outsider.address, n))
        .to.be.revertedWith("nullifier already used");
    });

    it("rejects a second registration of the same address", async function () {
      const { chit, registrar, members } = await loadFixture(deployFixture);
      await chit.connect(registrar).registerMember(members[0].address, nullifier("A"));
      await expect(chit.connect(registrar).registerMember(members[0].address, nullifier("B")))
        .to.be.revertedWith("address already registered");
    });

    it("only the Registrar may admit members, not the operator", async function () {
      const { chit, chitCo, members } = await loadFixture(deployFixture);
      await expect(chit.connect(chitCo).registerMember(members[0].address, nullifier("A")))
        .to.be.revertedWith("only registrar");
    });

    it("stores no identity document, only the one-way nullifier", async function () {
      const { chit, registrar, members } = await loadFixture(deployFixture);
      const govId = "AADHAAR-4321";
      await chit.connect(registrar).registerMember(members[0].address, nullifier(govId));
      const stored = await chit.nullifierOf(members[0].address);
      expect(stored).to.equal(nullifier(govId));
      expect(stored).to.not.include(Buffer.from(govId).toString("hex"));
    });
  });

  // ----------------------------------------------------------------- deposits

  describe("Deposits", function () {
    it("accepts the exact monthly contribution and grows the pot", async function () {
      const { chit, chitCo, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      await chit.connect(members[0]).deposit({ value: CONTRIBUTION });
      const r = await chit.getRoundView();
      expect(r.pot).to.equal(CONTRIBUTION);
      expect(r.depositCount).to.equal(1);
    });

    it("rejects an incorrect contribution amount", async function () {
      const { chit, chitCo, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      await expect(chit.connect(members[0]).deposit({ value: E(0.5) }))
        .to.be.revertedWith("incorrect contribution");
    });

    it("rejects a double deposit in the same round", async function () {
      const { chit, chitCo, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      await chit.connect(members[0]).deposit({ value: CONTRIBUTION });
      await expect(chit.connect(members[0]).deposit({ value: CONTRIBUTION }))
        .to.be.revertedWith("already deposited");
    });

    it("rejects deposits from non-members", async function () {
      const { chit, chitCo, outsider } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      await expect(chit.connect(outsider).deposit({ value: CONTRIBUTION }))
        .to.be.revertedWith("not a member");
    });
  });

  // -------------------------------------- G1: sealed bidding inside one round

  describe("G1 - Sealed bidding", function () {
    it("keeps the bid value off-chain until reveal", async function () {
      const { chit, members } = await loadFixture(biddingOpenFixture);
      const salt = randSalt();
      await chit.connect(members[0]).commitBid(commit(E(4.2), salt, members[0].address));
      expect(await chit.revealedBid(1, 1, members[0].address)).to.equal(0n);
      expect(await chit.commitmentOf(1, 1, members[0].address)).to.not.equal(ethers.ZeroHash);
    });

    it("produces different commitments for the same bid under different salts", async function () {
      const { members } = await loadFixture(biddingOpenFixture);
      const a = members[0].address;
      expect(commit(E(4.2), 1n, a)).to.not.equal(commit(E(4.2), 2n, a));
    });

    it("ATTACK: a bidder cannot change their bid at reveal time", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      const sa = randSalt(), sb = randSalt();
      await chit.connect(a).commitBid(commit(E(4.2), sa, a.address));
      await chit.connect(b).commitBid(commit(E(4.5), sb, b.address));
      await chit.connect(chitCo).openReveal();
      await chit.connect(a).revealBid(E(4.2), sa);
      await expect(chit.connect(b).revealBid(E(4.1), sb))
        .to.be.revertedWith("commitment mismatch");
    });

    it("ATTACK: a bidder cannot replay another member's commitment", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, , c] = members;
      const salt = randSalt();
      const h = commit(E(4.2), salt, a.address);
      await chit.connect(a).commitBid(h);
      await chit.connect(c).commitBid(h); // byte-for-byte copy
      await chit.connect(chitCo).openReveal();
      await chit.connect(a).revealBid(E(4.2), salt);
      await expect(chit.connect(c).revealBid(E(4.2), salt))
        .to.be.revertedWith("commitment mismatch");
    });

    it("rejects a reveal before the reveal window opens", async function () {
      const { chit, members } = await loadFixture(biddingOpenFixture);
      const salt = randSalt();
      await chit.connect(members[0]).commitBid(commit(E(4.2), salt, members[0].address));
      await expect(chit.connect(members[0]).revealBid(E(4.2), salt))
        .to.be.revertedWith("not reveal phase");
    });

    it("awards the round to the lowest revealed bid", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b, c] = members;
      await playBiddingRound(chit, chitCo, [
        { member: a, amount: E(4.8) },
        { member: b, amount: E(4.2) },
        { member: c, amount: E(4.5) },
      ]);
      await settleNow(chit, chitCo);
      const r = await chit.getRoundView();
      expect(r.winner).to.equal(b.address);
      expect(r.winningBid).to.equal(E(4.2));
      expect(r.discount).to.equal(POT - E(4.2));
    });

    it("enforces the 30% statutory discount cap", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const salt = randSalt();
      await chit.connect(members[0]).commitBid(commit(E(1), salt, members[0].address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(members[0]).revealBid(E(1), salt))
        .to.be.revertedWith("discount exceeds statutory cap");
    });

    it("rejects a bid above the pot", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const salt = randSalt();
      await chit.connect(members[0]).commitBid(commit(E(6), salt, members[0].address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(members[0]).revealBid(E(6), salt))
        .to.be.revertedWith("bid exceeds pot");
    });

    it("ATTACK: a prized subscriber cannot win twice in one cycle", async function () {
      const f = await loadFixture(settledFixture);
      const { chit, chitCo, registrar, members } = f;
      await chit.connect(chitCo).approvePayout(1);
      await chit.connect(registrar).approvePayout(1);
      await chit.connect(chitCo).releasePayout(1);

      await chit.connect(chitCo).startRound();
      for (const m of members) await chit.connect(m).deposit({ value: CONTRIBUTION });
      await chit.connect(chitCo).openBidding();

      await expect(chit.connect(members[0]).commitBid(commit(E(4), 1n, members[0].address)))
        .to.be.revertedWith("already prized this cycle");
    });

    it("falls back to a lottery when nobody reveals, paying the full pot", async function () {
      const { chit, chitCo } = await loadFixture(biddingOpenFixture);
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(chitCo).closeBiddingRound())
        .to.emit(chit, "LotteryFallback");
      const r = await chit.getRoundView();
      expect(r.winningBid).to.equal(POT);
      expect(r.discount).to.equal(0n);
    });
  });

  // ------------------------------------------- G1: multi-round price discovery

  describe("G1 - Multi-round descending auction", function () {
    it("rejects a bidding round count outside the allowed range", async function () {
      const [, registrar, chitCo, auditor] = await ethers.getSigners();
      const F = await ethers.getContractFactory("ChitFund");
      await expect(F.deploy(registrar.address, chitCo.address, auditor.address, CONTRIBUTION, GROUP_SIZE, 0))
        .to.be.revertedWith("bidding rounds out of range");
      await expect(F.deploy(registrar.address, chitCo.address, auditor.address, CONTRIBUTION, GROUP_SIZE, 6))
        .to.be.revertedWith("bidding rounds out of range");
    });

    it("opens at bidding round 1 with no standing bid", async function () {
      const { chit } = await loadFixture(biddingOpenFixture);
      const r = await chit.getRoundView();
      expect(r.biddingRound).to.equal(1);
      expect(r.maxBiddingRounds).to.equal(BIDDING_ROUNDS);
      expect(r.standingBid).to.equal(0n);
      expect(r.standingBidder).to.equal(ethers.ZeroAddress);
    });

    it("publishes the standing bid and opens the next bidding round", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      await playBiddingRound(chit, chitCo, [
        { member: a, amount: E(4.6) },
        { member: b, amount: E(4.8) },
      ]);
      const r = await chit.getRoundView();
      expect(r.standingBidder).to.equal(a.address);
      expect(r.standingBid).to.equal(E(4.6));
      expect(r.biddingRound).to.equal(2);
      expect(r.phase).to.equal(Phase.Commit);
    });

    it("converges over three rounds and the last improvement wins", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b, c] = members;
      await playBiddingRound(chit, chitCo, [{ member: a, amount: E(4.6) }]);
      await playBiddingRound(chit, chitCo, [{ member: b, amount: E(4.2) }]);
      await playBiddingRound(chit, chitCo, [{ member: c, amount: E(3.9) }]);

      const r = await chit.getRoundView();
      expect(r.phase).to.equal(Phase.Settled);
      expect(r.winner).to.equal(c.address);
      expect(r.winningBid).to.equal(E(3.9));
    });

    it("yields a deeper discount than stopping after one round", async function () {
      const one = await loadFixture(biddingOpenFixture);
      await playBiddingRound(one.chit, one.chitCo, [
        { member: one.members[0], amount: E(4.6) },
        { member: one.members[1], amount: E(4.8) },
      ]);
      await settleNow(one.chit, one.chitCo);
      const oneBid = (await one.chit.getRoundView()).winningBid;

      const many = await loadFixture(biddingOpenFixture);
      await playBiddingRound(many.chit, many.chitCo, [
        { member: many.members[0], amount: E(4.6) },
        { member: many.members[1], amount: E(4.8) },
      ]);
      await playBiddingRound(many.chit, many.chitCo, [
        { member: many.members[1], amount: E(4.3) },
      ]);
      await settleNow(many.chit, many.chitCo);
      const manyBid = (await many.chit.getRoundView()).winningBid;

      expect(manyBid).to.be.lessThan(oneBid);
    });

    it("rejects a later bid that does not improve on the standing bid", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      await playBiddingRound(chit, chitCo, [{ member: a, amount: E(4.2) }]);
      const salt = randSalt();
      await chit.connect(b).commitBid(commit(E(4.5), salt, b.address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(b).revealBid(E(4.5), salt))
        .to.be.revertedWith("must improve on the standing bid");
    });

    it("rejects a later bid equal to the standing bid", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      await playBiddingRound(chit, chitCo, [{ member: a, amount: E(4.2) }]);
      const salt = randSalt();
      await chit.connect(b).commitBid(commit(E(4.2), salt, b.address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(b).revealBid(E(4.2), salt))
        .to.be.revertedWith("must improve on the standing bid");
    });

    it("still enforces the statutory cap in later rounds", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      await playBiddingRound(chit, chitCo, [{ member: a, amount: E(4.2) }]);
      const salt = randSalt();
      await chit.connect(b).commitBid(commit(E(1), salt, b.address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(b).revealBid(E(1), salt))
        .to.be.revertedWith("discount exceeds statutory cap");
    });

    it("reports a tightening bid window between rounds", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      let [lo, hi] = await chit.bidBounds(1);
      expect(lo).to.equal(FLOOR);
      expect(hi).to.equal(POT);

      await playBiddingRound(chit, chitCo, [{ member: members[0], amount: E(4.2) }]);

      [lo, hi] = await chit.bidBounds(1);
      expect(lo).to.equal(FLOOR);
      expect(hi).to.equal(E(4.2) - 1n);
    });

    it("settles early when a bidding round produces no improvement", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      await playBiddingRound(chit, chitCo, [{ member: members[0], amount: E(4.4) }]);
      await settleNow(chit, chitCo); // round 2 attracts nothing

      const r = await chit.getRoundView();
      expect(r.phase).to.equal(Phase.Settled);
      expect(r.winner).to.equal(members[0].address);
      expect(r.winningBid).to.equal(E(4.4));
      expect(r.biddingRound).to.equal(2); // round 3 was never opened
    });

    it("settles after the configured number of bidding rounds", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      await playBiddingRound(chit, chitCo, [{ member: members[0], amount: E(4.6) }]);
      await playBiddingRound(chit, chitCo, [{ member: members[1], amount: E(4.4) }]);
      expect((await chit.getRoundView()).phase).to.equal(Phase.Commit);
      await playBiddingRound(chit, chitCo, [{ member: members[2], amount: E(4.2) }]);
      expect((await chit.getRoundView()).phase).to.equal(Phase.Settled);
    });

    it("records the standing bid after each bidding round for the audit trail", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      await playBiddingRound(chit, chitCo, [{ member: members[0], amount: E(4.6) }]);
      await playBiddingRound(chit, chitCo, [{ member: members[1], amount: E(4.2) }]);
      const [amounts, bidders] = await chit.biddingHistory(1);
      expect(amounts[0]).to.equal(E(4.6));
      expect(bidders[0]).to.equal(members[0].address);
      expect(amounts[1]).to.equal(E(4.2));
      expect(bidders[1]).to.equal(members[1].address);
      expect(amounts[2]).to.equal(0n);
    });

    it("ATTACK: sniping across rounds still fails, the commitment binds", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      await playBiddingRound(chit, chitCo, [{ member: a, amount: E(4.4) }]);

      // b now knows the standing bid is 4.4 and commits 4.3, then tries 4.0 at reveal
      const salt = randSalt();
      await chit.connect(b).commitBid(commit(E(4.3), salt, b.address));
      await chit.connect(chitCo).openReveal();
      await expect(chit.connect(b).revealBid(E(4.0), salt))
        .to.be.revertedWith("commitment mismatch");
    });
  });

  // ----------------------------------------------------------- tie-break seed

  describe("Tie-break randomness", function () {
    it("is seeded from revealed salts, so operator timing cannot change it", async function () {
      const setup = async () => {
        const f = await loadFixture(biddingOpenFixture);
        const [a, b] = f.members;
        const sa = 1001n, sb = 2002n;
        await f.chit.connect(a).commitBid(commit(E(4.2), sa, a.address));
        await f.chit.connect(b).commitBid(commit(E(4.2), sb, b.address));
        await f.chit.connect(f.chitCo).openReveal();
        await f.chit.connect(a).revealBid(E(4.2), sa);
        await f.chit.connect(b).revealBid(E(4.2), sb);
        return f;
      };

      const first = await setup();
      await first.chit.connect(first.chitCo).closeBiddingRound();
      const winnerA = (await first.chit.getRoundView()).standingBidder;

      const second = await setup();
      await ethers.provider.send("evm_increaseTime", [7200]);
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);
      await second.chit.connect(second.chitCo).closeBiddingRound();
      const winnerB = (await second.chit.getRoundView()).standingBidder;

      expect(winnerA).to.equal(winnerB);
    });

    it("picks exactly one winner from a tie", async function () {
      const { chit, chitCo, members } = await loadFixture(biddingOpenFixture);
      const [a, b] = members;
      const sa = randSalt(), sb = randSalt();
      await chit.connect(a).commitBid(commit(E(4.2), sa, a.address));
      await chit.connect(b).commitBid(commit(E(4.2), sb, b.address));
      await chit.connect(chitCo).openReveal();
      await chit.connect(a).revealBid(E(4.2), sa);
      await chit.connect(b).revealBid(E(4.2), sb);
      await chit.connect(chitCo).closeBiddingRound();

      const r = await chit.getRoundView();
      expect([a.address, b.address]).to.include(r.standingBidder);
      expect(r.standingBid).to.equal(E(4.2));
    });
  });

  // ------------------------------------------ G4: distributed payout authority

  describe("G4 - Distributed payout authority (2-of-3)", function () {
    it("ATTACK: the operator cannot release the pot alone", async function () {
      const { chit, chitCo } = await loadFixture(settledFixture);
      await chit.connect(chitCo).approvePayout(1);
      await expect(chit.connect(chitCo).releasePayout(1))
        .to.be.revertedWith("insufficient approvals");
    });

    it("ATTACK: an outsider cannot approve a payout", async function () {
      const { chit, outsider } = await loadFixture(settledFixture);
      await expect(chit.connect(outsider).approvePayout(1))
        .to.be.revertedWith("not an approving organisation");
    });

    it("rejects a duplicate approval from the same organisation", async function () {
      const { chit, chitCo } = await loadFixture(settledFixture);
      await chit.connect(chitCo).approvePayout(1);
      await expect(chit.connect(chitCo).approvePayout(1))
        .to.be.revertedWith("already approved");
    });

    it("releases the pot once two organisations approve", async function () {
      const { chit, chitCo, registrar, members } = await loadFixture(settledFixture);
      await chit.connect(chitCo).approvePayout(1);
      await chit.connect(registrar).approvePayout(1);
      await expect(chit.connect(chitCo).releasePayout(1))
        .to.changeEtherBalance(members[0], E(4.2));
    });

    it("any valid pair necessarily includes a party other than the operator", async function () {
      const { chit, registrar, auditor, members } = await loadFixture(settledFixture);
      await chit.connect(registrar).approvePayout(1);
      await chit.connect(auditor).approvePayout(1);
      await expect(chit.connect(registrar).releasePayout(1))
        .to.changeEtherBalance(members[0], E(4.2));
    });

    it("distributes the discount as dividends to non-winners", async function () {
      const { chit, chitCo, registrar, members } = await loadFixture(settledFixture);
      await chit.connect(chitCo).approvePayout(1);
      await chit.connect(registrar).approvePayout(1);
      await chit.connect(chitCo).releasePayout(1);

      const share = (POT - E(4.2)) / 4n;
      for (let i = 1; i < GROUP_SIZE; i++) {
        const m = await chit.members(members[i].address);
        expect(m.dividends).to.equal(share);
      }
      const winner = await chit.members(members[0].address);
      expect(winner.dividends).to.equal(0n);
    });
  });

  // ------------------------------------------------------ G2: default handling

  describe("G2 - Default handling", function () {
    it("records a missed deposit as arrears against the member", async function () {
      const { chit, chitCo, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      for (let i = 0; i < GROUP_SIZE - 1; i++) {
        await chit.connect(members[i]).deposit({ value: CONTRIBUTION });
      }
      await expect(chit.connect(chitCo).openBidding())
        .to.emit(chit, "PaymentMissed").withArgs(1, members[4].address, 1);

      const m = await chit.members(members[4].address);
      expect(m.missedPayments).to.equal(1);
      expect(m.arrears).to.equal(CONTRIBUTION);
    });

    it("diverts a defaulter's dividend to cover their arrears", async function () {
      const { chit, chitCo, registrar, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      for (let i = 0; i < GROUP_SIZE - 1; i++) {
        await chit.connect(members[i]).deposit({ value: CONTRIBUTION });
      }
      await chit.connect(chitCo).openBidding();
      await playBiddingRound(chit, chitCo, [{ member: members[0], amount: E(3.2) }]);
      await settleNow(chit, chitCo);

      await chit.connect(chitCo).approvePayout(1);
      await chit.connect(registrar).approvePayout(1);
      await expect(chit.connect(chitCo).releasePayout(1))
        .to.emit(chit, "DividendDiverted");

      const late = await chit.members(members[4].address);
      expect(late.arrears).to.be.lessThan(CONTRIBUTION);
      expect(late.dividends).to.equal(0n);
    });

    it("flags persistent default against the nullifier and bars further bidding", async function () {
      const { chit, chitCo, registrar, members } = await loadFixture(registeredFixture);

      for (let round = 1; round <= 3; round++) {
        await chit.connect(chitCo).startRound();
        for (let i = 0; i < GROUP_SIZE - 1; i++) {
          await chit.connect(members[i]).deposit({ value: CONTRIBUTION });
        }
        await chit.connect(chitCo).openBidding();

        // a member who has not already won takes this round
        const bidder = members.find(async () => true);
        const idx = round - 1;
        await playBiddingRound(chit, chitCo, [{ member: members[idx], amount: E(2.9) }]);
        await settleNow(chit, chitCo);

        await chit.connect(chitCo).approvePayout(round);
        await chit.connect(registrar).approvePayout(round);
        await chit.connect(chitCo).releasePayout(round);
      }

      const m = await chit.members(members[4].address);
      expect(m.missedPayments).to.equal(3);
      expect(m.defaulted).to.equal(true);

      await chit.connect(chitCo).startRound();
      await chit.connect(members[4]).deposit({ value: CONTRIBUTION });
      for (let i = 0; i < GROUP_SIZE - 1; i++) {
        await chit.connect(members[i]).deposit({ value: CONTRIBUTION });
      }
      await chit.connect(chitCo).openBidding();
      await expect(chit.connect(members[4]).commitBid(commit(E(4), 1n, members[4].address)))
        .to.be.revertedWith("member in default");
    });
  });

  // ----------------------------------------------------------------- lifecycle

  describe("Lifecycle", function () {
    it("will not start a round before the group is full", async function () {
      const { chit, registrar, chitCo, members } = await loadFixture(deployFixture);
      await chit.connect(registrar).registerMember(members[0].address, nullifier("A"));
      await expect(chit.connect(chitCo).startRound()).to.be.revertedWith("group not full");
    });

    it("will not start the next round while a payout is pending", async function () {
      const { chit, chitCo } = await loadFixture(settledFixture);
      await expect(chit.connect(chitCo).startRound())
        .to.be.revertedWith("previous payout pending");
    });

    it("rejects bidding without a deposit in that round", async function () {
      const { chit, chitCo, members } = await loadFixture(registeredFixture);
      await chit.connect(chitCo).startRound();
      for (let i = 0; i < GROUP_SIZE - 1; i++) {
        await chit.connect(members[i]).deposit({ value: CONTRIBUTION });
      }
      await chit.connect(chitCo).openBidding();
      await expect(chit.connect(members[4]).commitBid(commit(E(4), 1n, members[4].address)))
        .to.be.revertedWith("deposit required before bidding");
    });

    it("only the operator can advance the round phases", async function () {
      const { chit, members } = await loadFixture(depositedFixture);
      await expect(chit.connect(members[0]).openBidding()).to.be.revertedWith("only chitco");
      await expect(chit.connect(members[0]).openReveal()).to.be.revertedWith("only chitco");
      await expect(chit.connect(members[0]).closeBiddingRound()).to.be.revertedWith("only chitco");
    });

    it("lets a non-winner claim their dividend", async function () {
      const { chit, chitCo, registrar, members } = await loadFixture(settledFixture);
      await chit.connect(chitCo).approvePayout(1);
      await chit.connect(registrar).approvePayout(1);
      await chit.connect(chitCo).releasePayout(1);
      const share = (POT - E(4.2)) / 4n;
      await expect(chit.connect(members[1]).claimDividend())
        .to.changeEtherBalance(members[1], share);
    });
  });
});
