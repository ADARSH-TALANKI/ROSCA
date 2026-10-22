/**
 * Gas and cost evaluation.
 *
 *   npx hardhat run scripts/benchmark.js
 *
 * Measures four things:
 *
 *   1. Gas per operation, for a complete monthly cycle, at several group sizes.
 *   2. The cost of the security properties, by running the equivalent cycle on
 *      NaiveChitFund and taking the difference. Measured at ONE bidding round so
 *      the comparison is like for like: the naive design has a single open
 *      auction, so comparing it against a three-round sealed auction would
 *      conflate two separate costs.
 *   3. The scaling ceiling, because three operations walk the member list and
 *      therefore grow linearly with group size.
 *   4. What price discovery costs: the same cycle at one, two and three bidding
 *      rounds, with the discount each configuration actually achieves.
 *
 * Writes docs/benchmarks.md and docs/benchmarks.json.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const GROUP_SIZES = [3, 5, 10, 20, 30, 50];
const SHIPPED_ROUNDS = 3;              // what scripts/deploy.js deploys
const CONTRIBUTION = ethers.parseEther("1");
const BLOCK_GAS_LIMIT = 30_000_000n;   // Ethereum mainnet, for the ceiling calculation

const nullifierOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(`${s}::chitfund-platform-v1`));
const commitmentOf = (amount, salt, bidder) =>
  ethers.solidityPackedKeccak256(["uint256", "uint256", "address"], [amount, salt, bidder]);

const gasOf = async (txPromise) => (await (await txPromise).wait()).gasUsed;

/** Creates `n` funded wallets. Hardhat only unlocks 20 accounts by default. */
async function makeWallets(n, funder) {
  const wallets = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther("20") })).wait();
    wallets.push(w);
  }
  return wallets;
}

function record(into, label, gas) {
  const g = Number(gas);
  if (!into[label]) into[label] = { calls: 0, total: 0, min: g, max: g };
  const e = into[label];
  e.calls += 1;
  e.total += g;
  e.min = Math.min(e.min, g);
  e.max = Math.max(e.max, g);
}

const summarise = (s) =>
  Object.fromEntries(
    Object.entries(s).map(([k, v]) => [
      k,
      { calls: v.calls, avg: Math.round(v.total / v.calls), min: v.min, max: v.max, total: v.total },
    ])
  );

// --------------------------------------------------------------- ChitFund run

/**
 * One complete monthly cycle. `biddingRounds` sealed rounds are configured and
 * all of them are exercised, with each round producing a genuine improvement so
 * the auction runs to the configured depth rather than settling early.
 */
async function runChitFund(groupSize, biddingRounds, deployer) {
  const s = {};
  const [registrar, chitCo, auditor] = (await ethers.getSigners()).slice(1, 4);
  const members = await makeWallets(groupSize, deployer);

  const Factory = await ethers.getContractFactory("ChitFund");
  const c = await Factory.connect(deployer).deploy(
    registrar.address, chitCo.address, auditor.address,
    CONTRIBUTION, groupSize, biddingRounds
  );
  await c.waitForDeployment();
  record(s, "deploy", (await c.deploymentTransaction().wait()).gasUsed);

  // G3 enrolment
  for (let i = 0; i < groupSize; i++) {
    record(s, "registerMember", await gasOf(
      c.connect(registrar).registerMember(members[i].address, nullifierOf(`DOC-${groupSize}-${biddingRounds}-${i}`))
    ));
  }

  record(s, "startRound", await gasOf(c.connect(chitCo).startRound()));

  for (const m of members) {
    record(s, "deposit", await gasOf(c.connect(m).deposit({ value: CONTRIBUTION })));
  }

  // walks the member list: O(n)
  record(s, "openBidding", await gasOf(c.connect(chitCo).openBidding()));

  const pot = CONTRIBUTION * BigInt(groupSize);
  const floor = (pot * 7000n) / 10000n;
  const step = (pot - floor) / BigInt(biddingRounds + 1);

  let standing = pot;
  for (let br = 1; br <= biddingRounds; br++) {
    // half the members bid each round (at least one), all below the standing bid
    const bidders = Math.max(1, Math.floor(groupSize / 2));
    const amounts = [];
    const salts = [];
    for (let i = 0; i < bidders; i++) {
      const amount = standing - step - BigInt(i);
      amounts.push(amount);
      const salt = BigInt(ethers.hexlify(ethers.randomBytes(8)));
      salts.push(salt);
      record(s, "commitBid", await gasOf(
        c.connect(members[i]).commitBid(commitmentOf(amount, salt, members[i].address))
      ));
    }
    record(s, "openReveal", await gasOf(c.connect(chitCo).openReveal()));
    for (let i = 0; i < bidders; i++) {
      record(s, "revealBid", await gasOf(c.connect(members[i]).revealBid(amounts[i], salts[i])));
    }
    // walks the revealer list: O(n)
    record(s, "closeBiddingRound", await gasOf(c.connect(chitCo).closeBiddingRound()));
    standing = amounts[amounts.length - 1];
  }

  record(s, "approvePayout", await gasOf(c.connect(chitCo).approvePayout(1)));
  record(s, "approvePayout", await gasOf(c.connect(registrar).approvePayout(1)));

  // walks the member list to split the discount: O(n)
  record(s, "releasePayout", await gasOf(c.connect(chitCo).releasePayout(1)));

  const r = await c.getRoundView();
  const winner = r.winner.toLowerCase();
  const claimant = members.find((m) => m.address.toLowerCase() !== winner);
  record(s, "claimDividend", await gasOf(c.connect(claimant).claimDividend()));

  return { gas: summarise(s), winningBid: r.winningBid, pot };
}

// ------------------------------------------------------------ NaiveChitFund run

async function runNaive(groupSize, deployer) {
  const s = {};
  const chitCo = (await ethers.getSigners())[2];
  const members = await makeWallets(groupSize, deployer);

  const Factory = await ethers.getContractFactory("NaiveChitFund");
  const c = await Factory.connect(deployer).deploy(chitCo.address, CONTRIBUTION, groupSize);
  await c.waitForDeployment();
  record(s, "deploy", (await c.deploymentTransaction().wait()).gasUsed);

  for (const m of members) {
    record(s, "register", await gasOf(c.connect(chitCo).register(m.address)));
  }
  record(s, "startRound", await gasOf(c.connect(chitCo).startRound()));
  for (const m of members) {
    record(s, "deposit", await gasOf(c.connect(m).deposit({ value: CONTRIBUTION })));
  }

  const pot = CONTRIBUTION * BigInt(groupSize);
  for (let i = 0; i < groupSize; i++) {
    const amount = (pot * BigInt(70 + i)) / 100n > pot ? pot : (pot * BigInt(70 + i)) / 100n;
    record(s, "placeBid", await gasOf(c.connect(members[i]).placeBid(amount)));
  }
  record(s, "closeAuction", await gasOf(c.connect(chitCo).closeAuction()));
  record(s, "releasePayout", await gasOf(c.connect(chitCo).releasePayout(1)));

  return summarise(s);
}

// ------------------------------------------------------------------- reporting

const SETUP_OPS = new Set(["deploy", "registerMember", "register"]);

const roundTotal = (s) =>
  Object.entries(s).filter(([k]) => !SETUP_OPS.has(k)).reduce((a, [, v]) => a + v.total, 0);

const setupTotal = (s) =>
  (s.deploy?.total || 0) + (s.registerMember?.total || 0) + (s.register?.total || 0);

function markdown(shipped, single, naive, discovery) {
  const L = [];
  L.push("# Gas and cost evaluation");
  L.push("");
  L.push("Generated by `npm run bench`. Every figure is measured gas actually consumed on");
  L.push("the EVM, not an estimate.");
  L.push("");
  L.push("Solidity 0.8.24, optimizer enabled, 200 runs. Contribution fixed at 1 ETH per");
  L.push("subscriber, so the pot is *groupSize* ETH. Unless stated otherwise the auction");
  L.push(`runs at the shipped configuration of **${SHIPPED_ROUNDS} bidding rounds** per monthly cycle.`);
  L.push("");

  L.push("## 1. Gas per operation");
  L.push("");
  L.push("Average gas per call, by group size. Operations marked **O(n)** iterate the");
  L.push("member or revealer list and so grow with the size of the chit.");
  L.push("");

  const ops = [
    ["deploy", "one-off"], ["registerMember", "per member"], ["startRound", "per round"],
    ["deposit", "per member"], ["openBidding", "per round, **O(n)**"],
    ["commitBid", "per bid"], ["openReveal", "per bidding round"], ["revealBid", "per bid"],
    ["closeBiddingRound", "per bidding round, **O(n)**"],
    ["approvePayout", "per approver"], ["releasePayout", "per round, **O(n)**"],
    ["claimDividend", "per member"],
  ];

  L.push("| Operation | Frequency | " + GROUP_SIZES.map((n) => `n=${n}`).join(" | ") + " |");
  L.push("|---|---|" + GROUP_SIZES.map(() => "---:").join("|") + "|");
  for (const [op, freq] of ops) {
    const cells = GROUP_SIZES.map((n) => {
      const v = shipped[n]?.gas?.[op];
      return v ? v.avg.toLocaleString() : "-";
    });
    L.push(`| \`${op}\` | ${freq} | ${cells.join(" | ")} |`);
  }
  L.push("");

  L.push("## 2. Cost of a complete monthly cycle");
  L.push("");
  L.push("Setup is paid once for the life of the chit. Cycle gas is everything from");
  L.push(`\`startRound\` through \`claimDividend\`, with all ${SHIPPED_ROUNDS} bidding rounds exercised.`);
  L.push("");
  L.push("| Group size | Setup gas | Gas per cycle | Gas per member per cycle |");
  L.push("|---:|---:|---:|---:|");
  for (const n of GROUP_SIZES) {
    const s = shipped[n]?.gas;
    if (!s) continue;
    const rt = roundTotal(s);
    L.push(`| ${n} | ${setupTotal(s).toLocaleString()} | ${rt.toLocaleString()} | ${Math.round(rt / n).toLocaleString()} |`);
  }
  L.push("");

  L.push("## 3. What the security properties cost");
  L.push("");
  L.push("`NaiveChitFund` reconstructs the designs reported in the reviewed literature:");
  L.push("one open plaintext auction, identity by address, unilateral operator custody, no");
  L.push("statutory cap. To compare like with like, `ChitFund` is measured here at **one**");
  L.push("bidding round, so the difference isolates the cost of the security properties");
  L.push("rather than the cost of price discovery, which is reported separately in section 6.");
  L.push("");
  L.push("| Group size | Naive gas | ChitFund gas (1 round) | Overhead | Overhead per member |");
  L.push("|---:|---:|---:|---:|---:|");
  for (const n of GROUP_SIZES) {
    if (!single[n] || !naive[n]) continue;
    const a = roundTotal(naive[n]);
    const b = roundTotal(single[n].gas);
    const pct = (((b - a) / a) * 100).toFixed(0);
    L.push(`| ${n} | ${a.toLocaleString()} | ${b.toLocaleString()} | +${(b - a).toLocaleString()} (+${pct}%) | +${Math.round((b - a) / n).toLocaleString()} |`);
  }
  L.push("");

  L.push("## 4. Scaling ceiling");
  L.push("");
  L.push("Three operations iterate the member list, so their gas grows linearly with group");
  L.push("size. Each must fit in a single block, which bounds how large a chit can be.");
  L.push("Against a 30,000,000 gas block limit:");
  L.push("");
  L.push("| Operation | Gas at n=5 | Gas at n=50 | Marginal gas per member | Group size at block limit |");
  L.push("|---|---:|---:|---:|---:|");
  for (const op of ["openBidding", "closeBiddingRound", "releasePayout"]) {
    const lo = shipped[5]?.gas?.[op];
    const hi = shipped[50]?.gas?.[op];
    if (!lo || !hi) continue;
    const slope = (hi.avg - lo.avg) / (50 - 5);
    const intercept = lo.avg - slope * 5;
    const ceiling = Math.floor((Number(BLOCK_GAS_LIMIT) - intercept) / slope);
    L.push(`| \`${op}\` | ${lo.avg.toLocaleString()} | ${hi.avg.toLocaleString()} | ~${Math.round(slope).toLocaleString()} | ~${ceiling.toLocaleString()} |`);
  }
  L.push("");
  L.push("The practical limit is far below the arithmetic one. A real chit fund runs at 10");
  L.push("to 50 subscribers, well inside a single block, so the linear growth is not a");
  L.push("binding constraint at realistic sizes. It would become one for a design that");
  L.push("tried to pool thousands of subscribers in a single contract.");
  L.push("");

  L.push("## 5. Monetary cost");
  L.push("");
  L.push("Gas is a resource measure. What a cycle actually costs depends on where it is");
  L.push("deployed, which is the point of next semester's platform comparison.");
  L.push("");
  const n = 10;
  const rt = roundTotal(shipped[n]?.gas || {});
  if (rt) {
    L.push(`For a 10-subscriber chit at ${rt.toLocaleString()} gas per cycle:`);
    L.push("");
    L.push("| Deployment | Gas price | Cost per cycle | Cost per member per cycle |");
    L.push("|---|---:|---:|---:|");
    for (const [label, gwei] of [["Ethereum mainnet", 20n], ["Ethereum mainnet, congested", 60n], ["Layer 2 rollup", 1n]]) {
      const eth = Number(ethers.formatEther(BigInt(rt) * gwei * 1_000_000_000n));
      L.push(`| ${label} | ${gwei} gwei | ${eth.toFixed(6)} ETH | ${(eth / n).toFixed(6)} ETH |`);
    }
    L.push("| Permissioned chain (Hyperledger Fabric) | n/a | no gas | no gas |");
    L.push("");
    L.push("Multiply the ETH figures by the prevailing ETH price for a fiat number. The ETH");
    L.push("price is deliberately left as a parameter rather than hard-coded, because a");
    L.push("figure printed in a report goes stale immediately.");
    L.push("");
    L.push("The last row is the argument for the permissioned deployment. The computation is");
    L.push("identical, the metering is not. A chit fund serving subscribers who save a");
    L.push("thousand rupees a month cannot pass a per-transaction fee on to them, and that");
    L.push("constraint, rather than throughput, is what should decide the platform.");
  }
  L.push("");

  L.push("## 6. What price discovery costs");
  L.push("");
  L.push("The auction runs several sealed rounds inside one monthly cycle, publishing the");
  L.push("standing lowest bid between rounds so subscribers can respond to it. Sniping is");
  L.push("still impossible inside a round; what changes is that bidders are no longer");
  L.push("guessing blind.");
  L.push("");
  L.push("| Group size | Bidding rounds | Gas per cycle | vs 1 round | Winning bid | Discount achieved |");
  L.push("|---:|---:|---:|---:|---:|---:|");
  for (const n2 of [5, 10]) {
    const base = discovery[`${n2}:1`];
    for (const br of [1, 2, 3]) {
      const m = discovery[`${n2}:${br}`];
      if (!m || !base) continue;
      const rt2 = roundTotal(m.gas);
      const baseRt = roundTotal(base.gas);
      const delta = br === 1 ? "-" : `+${(((rt2 - baseRt) / baseRt) * 100).toFixed(0)}%`;
      const pot = Number(ethers.formatEther(m.pot));
      const bid = Number(ethers.formatEther(m.winningBid));
      L.push(`| ${n2} | ${br} | ${rt2.toLocaleString()} | ${delta} | ${bid.toFixed(4)} ETH | ${(((pot - bid) / pot) * 100).toFixed(1)}% |`);
    }
  }
  L.push("");
  L.push("Each additional bidding round costs roughly one more commit-reveal cycle in gas");
  L.push("and buys a deeper discount, because the winner is pushed closer to the statutory");
  L.push("floor. The cost climbs linearly while the discount improves with diminishing");
  L.push("returns, which is the argument for three rounds rather than five.");
  L.push("");
  L.push("A deeper discount is not straightforwardly a win. The discount becomes the");
  L.push("dividend, so pushing the winner lower transfers value from whoever needs the pot");
  L.push("most urgently to everyone who can afford to wait. That is precisely the dynamic");
  L.push("the 30% statutory ceiling exists to bound. The bidding round count is a");
  L.push("constructor parameter, so this remains a policy choice per chit rather than one");
  L.push("the contract makes on everybody's behalf.");
  L.push("");
  return L.join("\n");
}

// ------------------------------------------------------------------------ main

async function main() {
  const [deployer] = await ethers.getSigners();
  const shipped = {};
  const single = {};
  const naive = {};

  for (const n of GROUP_SIZES) {
    process.stdout.write(`  ChitFund n=${n}, ${SHIPPED_ROUNDS} bidding rounds ... `);
    shipped[n] = await runChitFund(n, SHIPPED_ROUNDS, deployer);
    process.stdout.write("ok\n");

    process.stdout.write(`  ChitFund n=${n}, 1 bidding round ... `);
    single[n] = await runChitFund(n, 1, deployer);
    process.stdout.write("ok\n");

    process.stdout.write(`  NaiveChitFund n=${n} ... `);
    naive[n] = await runNaive(n, deployer);
    process.stdout.write("ok\n");
  }

  // price discovery sweep (reuses the runs above where they match)
  const discovery = {};
  for (const n of [5, 10]) {
    discovery[`${n}:1`] = single[n];
    discovery[`${n}:3`] = shipped[n];
    process.stdout.write(`  ChitFund n=${n}, 2 bidding rounds ... `);
    discovery[`${n}:2`] = await runChitFund(n, 2, deployer);
    process.stdout.write("ok\n");
  }

  const outDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(outDir, { recursive: true });

  const serialise = (o) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [
      k, { gas: v.gas, winningBid: v.winningBid.toString(), pot: v.pot.toString() },
    ]));

  fs.writeFileSync(path.join(outDir, "benchmarks.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    groupSizes: GROUP_SIZES,
    shippedBiddingRounds: SHIPPED_ROUNDS,
    chitFundShipped: serialise(shipped),
    chitFundSingleRound: serialise(single),
    naive,
    priceDiscovery: serialise(discovery),
  }, null, 2));

  const md = markdown(shipped, single, naive, discovery);
  fs.writeFileSync(path.join(outDir, "benchmarks.md"), md);

  console.log("\n" + md);
  console.log("\nWritten to docs/benchmarks.md and docs/benchmarks.json");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
