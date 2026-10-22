/* ===========================================================================
   Attack Lab scenarios.

   Every scenario runs twice, on two freshly deployed contracts:

     NaiveChitFund - a faithful reconstruction of the designs reported in the
                     reviewed literature (open plaintext bidding, identity by
                     address, unilateral operator custody, no statutory cap).
     ChitFund      - this project's contract.

   Fresh instances per run mean a scenario can be replayed as often as you
   like, in any order, and can never disturb the guided walkthrough.
   =========================================================================== */

import { ethers } from "ethers";
import { provider, cfg, makeNullifier, makeCommitment, randomSalt, revertReason, fmtEth } from "./chain.js";
import chitAbi from "./generated/ChitFund.abi.json";
import naiveAbi from "./generated/NaiveChitFund.abi.json";
import bytecode from "./generated/bytecode.json";

const E = (n) => ethers.parseEther(String(n));
const L = cfg.labActors;
const CONTRIB = BigInt(cfg.contribution);
const POT = CONTRIB * BigInt(cfg.groupSize);

const sgn = (addr) => provider.getSigner(addr);
const as = async (c, addr) => c.connect(await sgn(addr));
const M = (i) => L.members[i];
const name = (i) => L.members[i].name;

async function deployChit() {
  const f = new ethers.ContractFactory(chitAbi, bytecode.ChitFund, await sgn(cfg.deployer));
  const c = await f.deploy(L.registrar, L.operator, L.auditor, CONTRIB, cfg.groupSize, 3);
  await c.waitForDeployment();
  return c;
}

async function deployNaive() {
  const f = new ethers.ContractFactory(naiveAbi, bytecode.NaiveChitFund, await sgn(cfg.deployer));
  const c = await f.deploy(L.operator, CONTRIB, cfg.groupSize);
  await c.waitForDeployment();
  return c;
}

/** Runs a call that is expected to revert. Returns the reason, or null if it went through. */
async function expectRevert(fn) {
  try {
    const tx = await fn();
    if (tx?.wait) await tx.wait();
    return null;
  } catch (e) {
    return revertReason(e);
  }
}

// ---------------------------------------------------------------- seeding

async function seedNaive(naive, t) {
  const op = await as(naive, L.operator);
  for (const m of L.members) await (await op.register(m.address)).wait();
  await (await op.startRound()).wait();
  for (const m of L.members) {
    const c = await as(naive, m.address);
    await (await c.deposit({ value: CONTRIB })).wait();
  }
  t.dim(`setup: 5 members registered, round 1 open, ${fmtEth(POT)} ETH in escrow`);
}

async function seedOurs(ours, t, { openBidding = true } = {}) {
  const reg = await as(ours, L.registrar);
  for (const m of L.members) {
    await (await reg.registerMember(m.address, makeNullifier(m.govId))).wait();
  }
  const op = await as(ours, L.operator);
  await (await op.startRound()).wait();
  for (const m of L.members) {
    const c = await as(ours, m.address);
    await (await c.deposit({ value: CONTRIB })).wait();
  }
  if (openBidding) await (await op.openBidding()).wait();
  t.dim(`setup: 5 members enrolled by nullifier, round 1 open, ${fmtEth(POT)} ETH in escrow`);
}

/** Commit/reveal a whole round on ChitFund. bids is an array of numbers in ETH. */
async function runOursAuction(ours, bids, t) {
  const salts = [];
  for (let i = 0; i < bids.length; i++) {
    const salt = randomSalt();
    salts.push(salt);
    const c = await as(ours, M(i).address);
    await (await c.commitBid(makeCommitment(E(bids[i]), salt, M(i).address))).wait();
  }
  await (await (await as(ours, L.operator)).openReveal()).wait();
  for (let i = 0; i < bids.length; i++) {
    const c = await as(ours, M(i).address);
    await (await c.revealBid(E(bids[i]), salts[i])).wait();
  }
  const op2 = await as(ours, L.operator);
  await (await op2.closeBiddingRound()).wait();
  // nobody improves in the next bidding round, so the auction settles there
  await (await op2.openReveal()).wait();
  await (await op2.closeBiddingRound()).wait();
  return salts;
}

const whoIs = (addr) => {
  const a = String(addr).toLowerCase();
  if (a === L.operator.toLowerCase()) return "the operator";
  if (a === L.registrar.toLowerCase()) return "the registrar";
  if (a === L.auditor.toLowerCase()) return "the auditor";
  if (a === L.attacker.toLowerCase()) return "Mallory";
  const m = L.members.find((x) => x.address.toLowerCase() === a);
  return m ? m.name : addr;
};

/* ===========================================================================
   A1 - Bid sniping
   =========================================================================== */

const A1 = {
  id: "A1",
  title: "Bid sniping on an open auction",
  subtitle: "Reported design writes the bid amount to state in the clear and emits it in an event.",
  source: "Kumar & Sangal (2020); TruChit",
  gap: "G1",
  naiveLabel: "Prior art · open bidding",
  oursLabel: "This work · commit-reveal",

  async naive(t) {
    const c = await deployNaive();
    t.dim(`NaiveChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedNaive(c, t);

    await (await (await as(c, M(0).address)).placeBid(E(4.0))).wait();
    t.step(`${name(0)} bids 4.0 ETH — written to bidOf[1][${name(0)}], emitted as BidPlaced`);

    const [addrs, amounts] = await c.peekBids(1);
    const seen = addrs.map((a, i) => `${whoIs(a)} ${fmtEth(amounts[i])} ETH`).join(", ");
    t.bad(`${name(1)} calls peekBids(1) and reads: ${seen}`);

    const snipe = E(4.0) - 1n;
    await (await (await as(c, M(1).address)).placeBid(snipe)).wait();
    t.bad(`${name(1)} undercuts by exactly 1 wei: ${fmtEth(snipe)} ETH`);

    await (await (await as(c, L.operator)).closeAuction()).wait();
    const w = await c.winnerOf(1);
    t.bad(`closeAuction → winner is ${whoIs(w)}`);

    return {
      verdict: "breached",
      summary: `${name(1)} wins the pot without ever competing on price. Reading the chain was enough.`,
    };
  },

  async ours(t) {
    const c = await deployChit();
    t.dim(`ChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedOurs(c, t);

    const salt = randomSalt();
    const commitment = makeCommitment(E(4.0), salt, M(0).address);
    await (await (await as(c, M(0).address)).commitBid(commitment)).wait();
    t.step(`${name(0)} commits keccak256(4.0 ETH ‖ salt ‖ her address)`);
    t.dim(`  stored on chain: ${commitment.slice(0, 22)}…`);

    const view = await c.getAllMembers();
    const anita = view.find((m) => m.addr.toLowerCase() === M(0).address.toLowerCase());
    t.ok(`${name(1)} reads the same state: commitment present, revealedBid = ${fmtEth(anita.revealedAmount)}`);
    t.ok(`  no amount field exists to read. The value is absent from state, not hidden behind a modifier.`);

    const bSalt = randomSalt();
    await (await (await as(c, M(1).address)).commitBid(makeCommitment(E(4.5), bSalt, M(1).address))).wait();
    t.step(`${name(1)} is forced to bid blind and commits 4.5 ETH`);

    await (await (await as(c, L.operator)).openReveal()).wait();
    await (await (await as(c, M(0).address)).revealBid(E(4.0), salt)).wait();
    t.step(`reveal opens. ${name(0)} opens hers: 4.0 ETH, verified against her commitment`);

    const cheat = await expectRevert(async () => {
      const m = await as(c, M(1).address);
      return m.revealBid.staticCall(E(3.9), bSalt);
    });
    t.ok(`${name(1)} now sees 4.0 and tries to open his as 3.9 instead → reverted: "${cheat}"`);
    t.ok(`  he is bound to the 4.5 he sealed before he knew anything`);

    await (await (await as(c, M(1).address)).revealBid(E(4.5), bSalt)).wait();

    const opc = await as(c, L.operator);
    await (await opc.closeBiddingRound()).wait();
    await (await opc.openReveal()).wait();
    await (await opc.closeBiddingRound()).wait();
    const r = await c.getRoundView();
    t.ok(`auction settles → winner is ${whoIs(r.winner)} at ${fmtEth(r.winningBid)} ETH`);

    return {
      verdict: "blocked",
      summary: "The lowest genuine bid wins. There was no window in which one bidder could see another's number.",
    };
  },
};

/* ===========================================================================
   A2 - Sybil re-entry
   =========================================================================== */

const A2 = {
  id: "A2",
  title: "Sybil re-entry with a second wallet",
  subtitle: "Reported design treats an address as an identity, so one person can hold several memberships.",
  source: "B-ROSCA; Finguard",
  gap: "G3",
  naiveLabel: "Prior art · identity = address",
  oursLabel: "This work · nullifier registry",

  async naive(t) {
    const c = await deployNaive();
    t.dim(`NaiveChitFund deployed at ${c.target.slice(0, 10)}…`);
    const op = await as(c, L.operator);

    await (await op.register(M(0).address)).wait();
    t.step(`${name(0)} enrols with wallet A (${M(0).address.slice(0, 10)}…)`);

    await (await op.register(L.attacker)).wait();
    t.bad(`the same person enrols again with wallet B (${L.attacker.slice(0, 10)}…)`);

    const n = await c.memberCount();
    t.bad(`memberCount() = ${n} — one human now holds ${n} of 5 seats`);
    t.bad(`she can bid twice, draw two dividends, and walk away from one seat after winning on the other`);

    return {
      verdict: "breached",
      summary: "Nothing on chain links a seat to a person, so there is no upper bound on how many seats one person takes.",
    };
  },

  async ours(t) {
    const c = await deployChit();
    t.dim(`ChitFund deployed at ${c.target.slice(0, 10)}…`);
    const reg = await as(c, L.registrar);

    const gov = M(0).govId;
    const nul = makeNullifier(gov);
    t.dim(`off-chain: nullifier = keccak256("${gov}" ‖ platformSalt)`);
    t.dim(`  = ${nul.slice(0, 26)}…`);

    await (await reg.registerMember(M(0).address, nul)).wait();
    t.step(`registrar admits ${name(0)} with wallet A, submitting only the 32-byte nullifier`);
    t.ok(`the document number itself never enters a transaction, a log or the world state`);

    const again = await expectRevert(() => reg.registerMember.staticCall(L.attacker, nul));
    t.ok(`same person, wallet B, same document → same nullifier → reverted: "${again}"`);

    const n = await c.memberCount();
    t.ok(`memberCount() = ${n} — the second wallet never becomes a seat`);
    t.dim(`honest limit: a genuinely forged document would yield a different nullifier and be admitted.`);
    t.dim(`  the contract bounds seats per document; the registrar bounds which documents are real.`);

    return {
      verdict: "blocked",
      summary: "The nullifier is deterministic in the document, so a second seat for the same person is unreachable by construction.",
    };
  },
};

/* ===========================================================================
   A3 - Operator seizes the escrow
   =========================================================================== */

const A3 = {
  id: "A3",
  title: "Operator seizes the escrow",
  subtitle: "Reported designs let the operator move funds on its own signature, reproducing the offline foreman risk.",
  source: "TruChit; Kumar & Sangal (2020)",
  gap: "G4",
  naiveLabel: "Prior art · unilateral custody",
  oursLabel: "This work · 2-of-3 approval",

  async naive(t) {
    const c = await deployNaive();
    t.dim(`NaiveChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedNaive(c, t);

    const before = await provider.getBalance(c.target);
    t.step(`escrow holds ${fmtEth(before)} ETH of members' money`);

    await (await (await as(c, L.operator)).drainTo(L.operator)).wait();
    const after = await provider.getBalance(c.target);
    t.bad(`operator calls drainTo(itself) — one signature, no quorum, no auction`);
    t.bad(`escrow balance: ${fmtEth(before)} → ${fmtEth(after)} ETH`);
    t.bad(`five subscribers lose a month of contributions with no on-chain recourse`);

    return {
      verdict: "breached",
      summary: `The operator took ${fmtEth(before)} ETH. On-chain custody with one key is the same trust assumption as the offline foreman.`,
    };
  },

  async ours(t) {
    const c = await deployChit();
    t.dim(`ChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedOurs(c, t);
    await runOursAuction(c, [4.2, 4.6, 4.8, 4.9, 5.0], t);
    t.step(`round settled, winner ${name(0)} at 4.2 ETH, ${fmtEth(POT)} ETH still in escrow`);

    const drains = chitAbi.filter(
      (f) => f.type === "function" && f.inputs?.some((i) => i.type === "address") &&
             /drain|withdrawTo|sweep|transferTo|rescue/i.test(f.name || "")
    );
    t.ok(`ABI scan for a caller-directed transfer (drain/sweep/withdrawTo/rescue): ${drains.length} found`);

    const outsider = await expectRevert(async () => {
      const m = await as(c, L.attacker);
      return m.approvePayout.staticCall(1);
    });
    t.ok(`Mallory tries to approve the payout → reverted: "${outsider}"`);

    await (await (await as(c, L.operator)).approvePayout(1)).wait();
    let r = await c.getRoundView();
    t.step(`operator approves — quorum now ${r.approvalCount}/2`);

    const alone = await expectRevert(async () => {
      const m = await as(c, L.operator);
      return m.releasePayout.staticCall(1);
    });
    t.ok(`operator alone calls releasePayout(1) → reverted: "${alone}"`);

    await (await (await as(c, L.registrar)).approvePayout(1)).wait();
    r = await c.getRoundView();
    t.step(`registrar adds the second approval — quorum ${r.approvalCount}/2`);

    const rcpt = await (await (await as(c, L.operator)).releasePayout(1)).wait();
    const winnerBefore = await provider.getBalance(M(0).address, rcpt.blockNumber - 1);
    const winnerAfter = await provider.getBalance(M(0).address, rcpt.blockNumber);
    const paid = winnerAfter - winnerBefore;
    t.ok(`release succeeds and the money goes to ${name(0)}: +${fmtEth(paid)} ETH`);
    t.ok(`with exactly three approvers, any valid pair contains someone other than the operator`);

    return {
      verdict: "blocked",
      summary: "No path moves value to a caller-chosen address, and the operator cannot reach quorum without an outside organisation.",
    };
  },
};

/* ===========================================================================
   A4 - Commitment replay
   =========================================================================== */

const A4 = {
  id: "A4",
  title: "Replaying someone else's sealed bid",
  subtitle: "A commitment is public bytes. If it were not bound to its author, copying it would be free.",
  source: "Attack on this work's own design",
  gap: "G1",
  naiveLabel: "Prior art · nothing to replay",
  oursLabel: "This work · address-bound commitment",

  async naive(t) {
    const c = await deployNaive();
    t.dim(`NaiveChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedNaive(c, t);
    await (await (await as(c, M(0).address)).placeBid(E(4.0))).wait();

    const [, amounts] = await c.peekBids(1);
    t.bad(`there is no commitment to replay: ${name(0)}'s bid sits in state as ${fmtEth(amounts[0])} ETH`);
    t.bad(`an attacker does not need to copy a sealed bid when the open one is already readable`);
    t.dim(`this is the weaker attack A1 again, which is the point: the design never raises the bar this far`);

    return {
      verdict: "breached",
      summary: "The scheme offers no sealing at all, so the replay question never arises. A1 already defeats it.",
    };
  },

  async ours(t) {
    const c = await deployChit();
    t.dim(`ChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedOurs(c, t);

    const salt = randomSalt();
    const commitment = makeCommitment(E(4.0), salt, M(0).address);
    await (await (await as(c, M(0).address)).commitBid(commitment)).wait();
    t.step(`${name(0)} commits ${commitment.slice(0, 20)}… for 4.0 ETH`);

    await (await (await as(c, M(2).address)).commitBid(commitment)).wait();
    t.step(`${name(2)} copies those exact 32 bytes off the chain and submits them as her own commitment`);
    t.dim(`  the contract accepts the bytes — it cannot tell a copy from an original at commit time`);

    await (await (await as(c, L.operator)).openReveal()).wait();
    await (await (await as(c, M(0).address)).revealBid(E(4.0), salt)).wait();
    t.step(`${name(0)} opens hers normally: 4.0 ETH accepted`);

    const replay = await expectRevert(async () => {
      const m = await as(c, M(2).address);
      return m.revealBid.staticCall(E(4.0), salt);
    });
    t.ok(`${name(2)} tries to open the copy with the same amount and salt → reverted: "${replay}"`);
    t.ok(`the hash commits to (amount ‖ salt ‖ bidder), so it only verifies for ${name(0)}'s address`);

    const opc = await as(c, L.operator);
    await (await opc.closeBiddingRound()).wait();
    await (await opc.openReveal()).wait();
    await (await opc.closeBiddingRound()).wait();
    const r = await c.getRoundView();
    t.ok(`${name(2)}'s copied commitment never becomes a bid. Winner: ${whoIs(r.winner)} at ${fmtEth(r.winningBid)} ETH`);

    return {
      verdict: "blocked",
      summary: "Binding the bidder's address into the preimage makes a stolen commitment unopenable, so replaying it costs the thief her own bid.",
    };
  },
};

/* ===========================================================================
   A5 - Predatory discount past the statutory ceiling
   =========================================================================== */

const A5 = {
  id: "A5",
  title: "Discount past the statutory ceiling",
  subtitle: "The Chit Funds Act 1982 caps the discount at 30% of the chit amount. No reviewed design encodes it.",
  source: "Chit Funds Act 1982, s.6; absent from all six reviewed designs",
  gap: "G1 / compliance",
  naiveLabel: "Prior art · no legal bound",
  oursLabel: "This work · cap in the contract",

  async naive(t) {
    const c = await deployNaive();
    t.dim(`NaiveChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedNaive(c, t);

    await (await (await as(c, M(0).address)).placeBid(E(0.1))).wait();
    t.bad(`${name(0)}, in distress, bids 0.1 ETH for a ${fmtEth(POT)} ETH pot — a 98% discount`);

    await (await (await as(c, L.operator)).closeAuction()).wait();
    const w = await c.winnerOf(1);
    const amt = await c.winningBidOf(1);
    t.bad(`closeAuction accepts it: ${whoIs(w)} takes ${fmtEth(amt)} ETH and stays liable for the full ${fmtEth(POT)} ETH`);
    t.bad(`the remaining ${fmtEth(POT - amt)} ETH is left with no distribution rule at all`);

    return {
      verdict: "breached",
      summary: "A desperate subscriber can be driven to an illegal discount, and the contract has no opinion about it.",
    };
  },

  async ours(t) {
    const c = await deployChit();
    t.dim(`ChitFund deployed at ${c.target.slice(0, 10)}…`);
    await seedOurs(c, t);

    const conf = await c.config();
    const floor = await c.minimumAcceptableBid(1);
    t.dim(`the discount is capped at ${Number(conf[7]) / 100}% of the pot, so the lowest admissible bid is ${fmtEth(floor)} ETH`);

    const salt = randomSalt();
    await (await (await as(c, M(0).address)).commitBid(makeCommitment(E(0.1), salt, M(0).address))).wait();
    t.step(`${name(0)} commits 0.1 ETH — the commit succeeds, because a hash carries no number`);

    await (await (await as(c, L.operator)).openReveal()).wait();
    const capped = await expectRevert(async () => {
      const m = await as(c, M(0).address);
      return m.revealBid.staticCall(E(0.1), salt);
    });
    t.ok(`opening it at reveal → reverted: "${capped}"`);
    t.ok(`the ceiling is checked where the number first exists, which is the only place it can be checked`);

    t.dim(`a lawful bid of ${fmtEth(floor)} ETH or more opens without complaint; only the illegal one cannot.`);

    return {
      verdict: "blocked",
      summary: `A bid below ${fmtEth(floor)} ETH cannot settle, so the statutory ceiling is a property of the platform rather than a promise in a brochure.`,
    };
  },
};

export const ATTACKS = [A1, A2, A3, A4, A5];
