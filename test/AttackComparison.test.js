/**
 * Side-by-side attack comparison.
 *
 * Each test runs the same attack twice: once against NaiveChitFund, which
 * reproduces the design found in the reviewed literature, and once against
 * ChitFund. The attack is expected to SUCCEED on the baseline and FAIL on
 * the proposed design.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(n.toString());
const commit = (amount, salt, bidder) =>
  ethers.solidityPackedKeccak256(["uint256", "uint256", "address"], [amount, salt, bidder]);
const nullifier = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const CONTRIB = E(1);
const SIZE = 5;

describe("Attack comparison: prior art vs proposed design", function () {

  async function setup() {
    const [deployer, registrar, chitCo, auditor, a, b, c, d, e, attackerWallet] =
      await ethers.getSigners();
    const members = [a, b, c, d, e];

    const Naive = await ethers.getContractFactory("NaiveChitFund");
    const naive = await Naive.deploy(chitCo.address, CONTRIB, SIZE);

    const Chit = await ethers.getContractFactory("ChitFund");
    const chit = await Chit.deploy(registrar.address, chitCo.address, auditor.address, CONTRIB, SIZE, 3);

    return { naive, chit, deployer, registrar, chitCo, auditor, members, attackerWallet };
  }

  // ------------------------------------------------------------------
  describe("A1 - Bid sniping (front-running an open auction)", function () {

    it("SUCCEEDS against the open-bid baseline", async function () {
      const { naive, chitCo, members } = await setup();
      const [honest, attacker] = members;

      for (const m of members) await naive.connect(chitCo).register(m.address);
      await naive.connect(chitCo).startRound();
      for (const m of members) await naive.connect(m).deposit({ value: CONTRIB });

      // The honest member bids first.
      await naive.connect(honest).placeBid(E(4.0));

      // The attacker reads the pending bid straight off the contract.
      const [addrs, amounts] = await naive.peekBids(1);
      expect(addrs[0]).to.equal(honest.address);
      expect(amounts[0]).to.equal(E(4.0));

      // ...and undercuts it by the smallest possible margin.
      await naive.connect(attacker).placeBid(E(4.0) - 1n);
      await naive.connect(chitCo).closeAuction();

      expect(await naive.winnerOf(1)).to.equal(attacker.address);  // attack worked
    });

    it("FAILS against commit-reveal", async function () {
      const { chit, registrar, chitCo, members } = await setup();
      const [honest, attacker] = members;

      for (let i = 0; i < members.length; i++)
        await chit.connect(registrar).registerMember(members[i].address, nullifier(`id-${i}`));
      await chit.connect(chitCo).startRound();
      for (const m of members) await chit.connect(m).deposit({ value: CONTRIB });
      await chit.connect(chitCo).openBidding();

      await chit.connect(honest).commitBid(commit(E(4.0), 7n, honest.address));

      // The attacker inspects the chain and finds only a hash.
      const seen = await chit.commitmentOf(1, 1, honest.address);
      expect(seen).to.not.equal(ethers.ZeroHash);
      expect(await chit.revealedBid(1, 1, honest.address)).to.equal(0);

      // With no value to undercut, the attacker has to guess blind.
      await chit.connect(attacker).commitBid(commit(E(4.3), 8n, attacker.address));

      await chit.connect(chitCo).openReveal();
      await chit.connect(honest).revealBid(E(4.0), 7n);
      await chit.connect(attacker).revealBid(E(4.3), 8n);
      await chit.connect(chitCo).closeBiddingRound();

      // nobody improves in the next bidding round, so the auction settles
      await chit.connect(chitCo).openReveal();
      await chit.connect(chitCo).closeBiddingRound();

      const info = await chit.getRoundView();
      expect(info.winner).to.equal(honest.address);  // attack defeated
    });

    it("FAILS even if the attacker tries to change their bid after reveal starts", async function () {
      const { chit, registrar, chitCo, members } = await setup();
      const [honest, attacker] = members;

      for (let i = 0; i < members.length; i++)
        await chit.connect(registrar).registerMember(members[i].address, nullifier(`id-${i}`));
      await chit.connect(chitCo).startRound();
      for (const m of members) await chit.connect(m).deposit({ value: CONTRIB });
      await chit.connect(chitCo).openBidding();

      await chit.connect(honest).commitBid(commit(E(4.0), 7n, honest.address));
      await chit.connect(attacker).commitBid(commit(E(4.3), 8n, attacker.address));
      await chit.connect(chitCo).openReveal();
      await chit.connect(honest).revealBid(E(4.0), 7n);

      // Now the attacker can see 4.0 and wants to open their commitment as 3.9.
      await expect(
        chit.connect(attacker).revealBid(E(3.9), 8n)
      ).to.be.revertedWith("commitment mismatch");
    });
  });

  // ------------------------------------------------------------------
  describe("A2 - Sybil re-entry after default", function () {

    it("SUCCEEDS against address-only identity", async function () {
      const { naive, chitCo, members, attackerWallet } = await setup();
      const bad = members[0];

      await naive.connect(chitCo).register(bad.address);
      expect(await naive.isMember(bad.address)).to.equal(true);

      // The same human simply registers again from another wallet.
      await naive.connect(chitCo).register(attackerWallet.address);
      expect(await naive.isMember(attackerWallet.address)).to.equal(true);
      expect(await naive.memberCount()).to.equal(2); // one person, two memberships
    });

    it("FAILS against the nullifier registry", async function () {
      const { chit, registrar, members, attackerWallet } = await setup();
      const sameHuman = nullifier("aadhaar-XXXX-1111");

      await chit.connect(registrar).registerMember(members[0].address, sameHuman);
      await expect(
        chit.connect(registrar).registerMember(attackerWallet.address, sameHuman)
      ).to.be.revertedWith("nullifier already used");

      expect(await chit.memberCount()).to.equal(1);
    });
  });

  // ------------------------------------------------------------------
  describe("A3 - Operator seizing the pot", function () {

    it("SUCCEEDS against single-operator control", async function () {
      const { naive, chitCo, members } = await setup();
      for (const m of members) await naive.connect(chitCo).register(m.address);
      await naive.connect(chitCo).startRound();
      for (const m of members) await naive.connect(m).deposit({ value: CONTRIB });

      expect(await ethers.provider.getBalance(await naive.getAddress())).to.equal(E(5));

      // One signature empties the contract.
      await expect(
        naive.connect(chitCo).drainTo(chitCo.address)
      ).to.changeEtherBalance(naive, -E(5));
    });

    it("FAILS against 2-of-3 endorsement", async function () {
      const { chit, registrar, chitCo, members } = await setup();
      for (let i = 0; i < members.length; i++)
        await chit.connect(registrar).registerMember(members[i].address, nullifier(`id-${i}`));
      await chit.connect(chitCo).startRound();
      for (const m of members) await chit.connect(m).deposit({ value: CONTRIB });
      await chit.connect(chitCo).openBidding();

      const bidder = members[0];
      await chit.connect(bidder).commitBid(commit(E(4.0), 1n, bidder.address));
      await chit.connect(chitCo).openReveal();
      await chit.connect(bidder).revealBid(E(4.0), 1n);
      await chit.connect(chitCo).closeBiddingRound();
      // settle: the next bidding round attracts no improvement
      await chit.connect(chitCo).openReveal();
      await chit.connect(chitCo).closeBiddingRound();

      // There is no drain function at all, and the operator's own approval
      // is not enough to move the pot.
      expect(chit.interface.fragments.some((f) => f.name === "drainTo")).to.equal(false);

      await chit.connect(chitCo).approvePayout(1);
      await expect(
        chit.connect(chitCo).releasePayout(1)
      ).to.be.revertedWith("insufficient approvals");
    });
  });
});
