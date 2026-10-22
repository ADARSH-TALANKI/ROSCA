/**
 * Narrated walkthrough of one full chit round.
 * Run with:  npx hardhat run scripts/demo.js
 */
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(n.toString());
const fmt = (w) => ethers.formatEther(w);
const commit = (amount, salt, bidder) =>
  ethers.solidityPackedKeccak256(["uint256", "uint256", "address"], [amount, salt, bidder]);
const nullifier = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const line = (s = "") => console.log(s);
const head = (s) => { line(); line("=".repeat(68)); line("  " + s); line("=".repeat(68)); };
const ok = (s) => line("   [ok]       " + s);
const blocked = (s) => line("   [BLOCKED]  " + s);

async function expectRevert(p, label) {
  try { await p; line("   [!!] NOT BLOCKED: " + label); }
  catch (e) {
    const m = e.message.match(/reverted with reason string '([^']+)'/);
    blocked(label + "  ->  " + (m ? m[1] : "reverted"));
  }
}

async function main() {
  const [, registrar, chitCo, auditor, anita, bilal, chitra, devi, eldho, outsider] =
    await ethers.getSigners();
  const names = new Map([
    [anita.address, "Anita"], [bilal.address, "Bilal"], [chitra.address, "Chitra"],
    [devi.address, "Devi"],   [eldho.address, "Eldho"],
  ]);
  const members = [anita, bilal, chitra, devi, eldho];

  const CONTRIB = E(1);

  head("SETUP");
  const chit = await (await ethers.getContractFactory("ChitFund"))
    .deploy(registrar.address, chitCo.address, auditor.address, CONTRIB, 5, 3);
  await chit.waitForDeployment();
  line("   Contract        " + (await chit.getAddress()));
  line("   Registrar       " + registrar.address + "   (government, does KYC)");
  line("   ChitCo          " + chitCo.address + "   (operator)");
  line("   Auditor         " + auditor.address + "   (independent)");
  line("   Group           5 members, 1 ETH per month, pot = 5 ETH");
  line("   Payout policy   2-of-3 organisations must approve");

  head("G3  SYBIL-RESISTANT REGISTRATION");
  line("   The Registrar verifies identity off-chain and submits only a nullifier,");
  line("   a one-way hash of the government ID. The document never reaches the chain.");
  line();
  for (let i = 0; i < members.length; i++) {
    await chit.connect(registrar).registerMember(members[i].address, nullifier(`aadhaar-${i}`));
    ok(`${names.get(members[i].address).padEnd(7)} registered`);
  }
  line();
  line("   Anita tries to rejoin from a second wallet, same real identity:");
  await expectRevert(
    chit.connect(registrar).registerMember(outsider.address, nullifier("aadhaar-0")),
    "second membership for the same person"
  );

  head("ROUND 1  -  DEPOSITS");
  await chit.connect(chitCo).startRound();
  for (const m of members) {
    await chit.connect(m).deposit({ value: CONTRIB });
    ok(`${names.get(m.address).padEnd(7)} deposited 1 ETH`);
  }
  await chit.connect(chitCo).openBidding();
  line();
  line("   Pot                  " + fmt((await chit.getRoundView()).pot) + " ETH");
  line("   Minimum valid bid    " + fmt(await chit.minimumAcceptableBid(1)) + " ETH  (30% discount cap)");

  head("G1  COMMIT PHASE  -  bids are sealed");
  const bids = [
    { s: anita,  amount: E(4.5), salt: 1001n },
    { s: bilal,  amount: E(4.0), salt: 1002n },
    { s: chitra, amount: E(4.7), salt: 1003n },
  ];
  for (const b of bids) {
    await chit.connect(b.s).commitBid(commit(b.amount, b.salt, b.s.address));
    ok(`${names.get(b.s.address).padEnd(7)} committed  ${await chit.commitmentOf(1, 1, b.s.address)}`);
  }
  line();
  line("   What the chain holds right now for each bidder is a 32-byte hash.");
  line("   Reading the stored bid value returns zero, because no value exists yet:");
  for (const b of bids) {
    line(`      revealedBid(${names.get(b.s.address).padEnd(7)}) = ${await chit.revealedBid(1, 1, b.s.address)}`);
  }
  line();
  line("   This is the difference from the reviewed literature. The bid is not");
  line("   access-controlled, it is structurally absent until the window closes.");

  head("G1  REVEAL PHASE");
  await chit.connect(chitCo).openReveal();
  line("   Bilal has now seen that others committed. He tries to lower his bid:");
  await expectRevert(chit.connect(bilal).revealBid(E(3.6), 1002n), "bid altered after commitment");
  line();
  line("   Chitra tries to open Anita's commitment as her own:");
  await expectRevert(chit.connect(chitra).revealBid(E(4.5), 1001n), "commitment replay by another bidder");
  line();
  for (const b of bids) {
    await chit.connect(b.s).revealBid(b.amount, b.salt);
    ok(`${names.get(b.s.address).padEnd(7)} revealed ${fmt(b.amount)} ETH`);
  }

  head("AUCTION CLOSE");
  await chit.connect(chitCo).closeBiddingRound();
  // the next bidding round attracts no improvement, so the auction settles
  await chit.connect(chitCo).openReveal();
  await chit.connect(chitCo).closeBiddingRound();
  const r = await chit.getRoundView();
  line("   Winner        " + names.get(r.winner) + "  (lowest accepted amount)");
  line("   Prize money   " + fmt(r.winningBid) + " ETH");
  line("   Discount      " + fmt(r.discount) + " ETH, shared among the other four");

  head("G4  DISTRIBUTED PAYOUT AUTHORITY");
  line("   ChitCo approves and immediately tries to release the pot to the winner:");
  await chit.connect(chitCo).approvePayout(1);
  await expectRevert(chit.connect(chitCo).releasePayout(1), "operator acting alone");
  line();
  line("   An unrelated address tries to supply the second approval:");
  await expectRevert(chit.connect(outsider).approvePayout(1), "approval from outside the three organisations");
  line();
  line("   The Auditor independently approves:");
  await chit.connect(auditor).approvePayout(1);
  ok("approvals now 2 of 3");
  const before = await ethers.provider.getBalance(r.winner);
  await chit.connect(chitCo).releasePayout(1);
  const after = await ethers.provider.getBalance(r.winner);
  ok(`payout released, ${names.get(r.winner)} received ${fmt(after - before)} ETH`);

  head("DIVIDENDS");
  for (const m of members) {
    if (m.address === r.winner) continue;
    const info = await chit.members(m.address);
    line(`   ${names.get(m.address).padEnd(7)} dividend ${fmt(info.dividends)} ETH`);
  }

  head("G2  DEFAULT HANDLING  -  ROUND 2");
  await chit.connect(chitCo).startRound();
  line("   Eldho stops paying after the pot has already been awarded once.");
  for (const m of members) {
    if (m.address === eldho.address) continue;
    await chit.connect(m).deposit({ value: CONTRIB });
  }
  await chit.connect(chitCo).openBidding();
  const e = await chit.members(eldho.address);
  line();
  line("   Eldho missed payments   " + e.missedPayments);
  line("   Eldho arrears           " + fmt(e.arrears) + " ETH");
  line();
  line("   His dividend from this round will be diverted to cover the arrears");
  line("   instead of being paid out. After 3 misses the default is written");
  line("   permanently against his nullifier, so it follows the person and not");
  line("   the wallet address.");

  head("SUMMARY");
  line("   G1  sealed bidding          bid absent from chain until reveal");
  line("   G2  default handling        arrears tracked, dividends diverted");
  line("   G3  Sybil resistance        one person, one membership, no ID stored");
  line("   G4  distributed authority   operator cannot release funds alone");
  line();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
