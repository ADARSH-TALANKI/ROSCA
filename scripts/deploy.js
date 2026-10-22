/**
 * Deploys both contracts to the local Hardhat node and writes the addresses,
 * ABIs, bytecode and demo account list into the frontend so the dApp can pick
 * them up with no manual copy-pasting of addresses.
 *
 *   npx hardhat run scripts/deploy.js --network localhost
 *
 * Two sets of accounts are written out:
 *
 *   actors[]      - the guided demo. Registrar / ChitCo / Auditor, five named
 *                   subscribers and one outsider.
 *   labActors[]   - a separate set used only by the Attack Lab, which deploys
 *                   throwaway contract instances for every run. Keeping them
 *                   apart means an attack scenario can never disturb the
 *                   balances or state of the walkthrough you present.
 */
const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");

const CONTRIBUTION = ethers.parseEther("1");
const GROUP_SIZE = 5;
const BIDDING_ROUNDS = 3;
const NAMES = ["Anita", "Bilal", "Chitra", "Devi", "Eldho"];

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length < 19) {
    throw new Error(
      `Need at least 19 unlocked accounts, the node exposed ${signers.length}. ` +
      `Start it with "npm run node" (Hardhat's default gives 20).`
    );
  }

  const deployer = signers[0];
  const [registrar, chitCo, auditor] = signers.slice(1, 4);
  const memberSigners = signers.slice(4, 4 + GROUP_SIZE);
  const attacker = signers[4 + GROUP_SIZE];
  const lab = signers.slice(10, 19); // reg, op, aud, 5 members, attacker

  const ChitFund = await ethers.getContractFactory("ChitFund");
  const chit = await ChitFund.connect(deployer).deploy(
    registrar.address, chitCo.address, auditor.address, CONTRIBUTION, GROUP_SIZE, BIDDING_ROUNDS
  );
  await chit.waitForDeployment();

  const Naive = await ethers.getContractFactory("NaiveChitFund");
  const naive = await Naive.connect(deployer).deploy(chitCo.address, CONTRIBUTION, GROUP_SIZE);
  await naive.waitForDeployment();

  const chitArt = await artifacts.readArtifact("ChitFund");
  const naiveArt = await artifacts.readArtifact("NaiveChitFund");

  const config = {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    contribution: CONTRIBUTION.toString(),
    groupSize: GROUP_SIZE,
    biddingRounds: BIDDING_ROUNDS,
    chitFund: await chit.getAddress(),
    naiveChitFund: await naive.getAddress(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    actors: [
      { key: "registrar", label: "Registrar of Chits", short: "RG", kind: "org",
        role: "Issuing authority",
        blurb: "Government body. Verifies identity documents off-chain and admits members by nullifier. Never sees a bid.",
        address: registrar.address, index: 1 },
      { key: "chitCo", label: "ChitCo", short: "CO", kind: "org",
        role: "Operator / foreman",
        blurb: "Runs the chit and advances the round. Holds one approval of three, so it cannot pay anyone alone.",
        address: chitCo.address, index: 2 },
      { key: "auditor", label: "Independent Auditor", short: "AU", kind: "org",
        role: "Third-party validator",
        blurb: "Issues no credentials and takes no custody. Exists so that no single organisation holds quorum.",
        address: auditor.address, index: 3 },
      ...memberSigners.map((s, i) => ({
        key: `member${i}`, label: NAMES[i], short: NAMES[i].slice(0, 2).toUpperCase(),
        kind: "member", role: `Subscriber ${i + 1} of ${GROUP_SIZE}`,
        blurb: `Pays ${ethers.formatEther(CONTRIBUTION)} ETH a month into the sala and bids for the pot.`,
        address: s.address, index: 4 + i,
        govId: `AADHAAR-${4321 + i * 1111}`,
      })),
      { key: "attacker", label: "Mallory", short: "ML", kind: "outsider",
        role: "Adversary",
        blurb: "Unregistered wallet. Used to show what an outsider, and a colluding insider, cannot do.",
        address: attacker.address, index: 4 + GROUP_SIZE },
    ],
    labActors: {
      registrar: lab[0].address,
      operator: lab[1].address,
      auditor: lab[2].address,
      members: lab.slice(3, 8).map((s, i) => ({ name: NAMES[i], address: s.address, govId: `AADHAAR-${4321 + i * 1111}` })),
      attacker: lab[8].address,
    },
  };

  const outDir = path.join(__dirname, "..", "frontend", "src", "generated");
  fs.mkdirSync(outDir, { recursive: true });

  const write = (name, data) =>
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));

  write("config.json", config);
  write("ChitFund.abi.json", chitArt.abi);
  write("NaiveChitFund.abi.json", naiveArt.abi);
  write("bytecode.json", {
    ChitFund: chitArt.bytecode,
    NaiveChitFund: naiveArt.bytecode,
  });

  console.log("");
  console.log("  ChitFund        ", config.chitFund);
  console.log("  NaiveChitFund   ", config.naiveChitFund);
  console.log("  contribution     ", ethers.formatEther(CONTRIBUTION), "ETH x", GROUP_SIZE, "members");
  console.log("  bidding rounds   ", BIDDING_ROUNDS, "per monthly cycle");
  console.log("  frontend config   frontend/src/generated/");
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
