import { ethers } from "ethers";
import config from "./generated/config.json";
import chitAbi from "./generated/ChitFund.abi.json";
import naiveAbi from "./generated/NaiveChitFund.abi.json";

export const cfg = config;
export const provider = new ethers.JsonRpcProvider(config.rpcUrl);

export const chitRead = new ethers.Contract(config.chitFund, chitAbi, provider);
export const naiveRead = new ethers.Contract(config.naiveChitFund, naiveAbi, provider);

export async function chitAs(address) {
  const signer = await provider.getSigner(address);
  return new ethers.Contract(config.chitFund, chitAbi, signer);
}

export async function naiveAs(address) {
  const signer = await provider.getSigner(address);
  return new ethers.Contract(config.naiveChitFund, naiveAbi, signer);
}

// ----------------------------------------------------------------- formatting

export const PHASES = ["Idle", "Deposit", "Commit", "Reveal", "Settled"];

export const fmtEth = (wei) => {
  if (wei === undefined || wei === null) return "0";
  const s = ethers.formatEther(wei);
  return s.replace(/\.?0+$/, "") || "0";
};

export const parseEth = (v) => ethers.parseEther(String(v));

/** parseEth that returns null instead of throwing. Use wherever a user is typing. */
export const tryParseEth = (v) => {
  const t = String(v ?? "").trim();
  if (t === "" || !/^\d*\.?\d*$/.test(t) || t === ".") return null;
  try {
    return ethers.parseEther(t);
  } catch {
    return null;
  }
};

export const short = (a, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "");
export const isZeroHash = (h) => !h || h === ethers.ZeroHash;
export const ZERO_ADDR = ethers.ZeroAddress;

// --------------------------------------------------------------- crypto bits

/** nullifier = keccak256(governmentId || platformSalt). Computed off-chain. */
export const PLATFORM_SALT = "chitfund-platform-v1";
export const makeNullifier = (govId) =>
  ethers.keccak256(ethers.toUtf8Bytes(`${govId}::${PLATFORM_SALT}`));

/** commitment = keccak256(abi.encodePacked(amount, salt, bidder)) */
export const makeCommitment = (amountWei, salt, bidder) =>
  ethers.solidityPackedKeccak256(["uint256", "uint256", "address"], [amountWei, salt, bidder]);

export const randomSalt = () => BigInt(ethers.hexlify(ethers.randomBytes(8)));

// ------------------------------------------------------------ salt persistence
// Keyed by bidding round as well, because a subscriber may bid in several.

const saltKey = (round, biddingRound, addr) =>
  `chit:salt:${round}:${biddingRound}:${addr.toLowerCase()}`;

export function rememberBid(round, biddingRound, addr, amountWei, salt) {
  localStorage.setItem(
    saltKey(round, biddingRound, addr),
    JSON.stringify({ amount: amountWei.toString(), salt: salt.toString() })
  );
}

export function recallBid(round, biddingRound, addr) {
  try {
    const raw = localStorage.getItem(saltKey(round, biddingRound, addr));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return { amount: BigInt(o.amount), salt: BigInt(o.salt) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- error decoding

export function revertReason(err) {
  const candidates = [
    err?.reason,
    err?.revert?.args?.[0],
    err?.info?.error?.message,
    err?.shortMessage,
    err?.message,
  ].filter(Boolean);

  for (const c of candidates) {
    const m = String(c).match(/reverted with reason string ['"]([^'"]+)['"]/);
    if (m) return m[1];
    const m2 = String(c).match(/execution reverted:?\s*"?([^"\n]+)"?/);
    if (m2 && m2[1].trim()) return m2[1].trim();
  }
  return candidates[0] ? String(candidates[0]).split("\n")[0] : "transaction reverted";
}

// ------------------------------------------------------------------- snapshot

export async function readState() {
  const [round, members, conf] = await Promise.all([
    chitRead.getRoundView(),
    chitRead.getAllMembers(),
    chitRead.config(),
  ]);

  let history = [];
  if (Number(round.id) > 0) {
    try {
      const [amounts, bidders] = await chitRead.biddingHistory(round.id);
      history = amounts.map((a, i) => ({
        biddingRound: i + 1,
        amount: a,
        bidder: bidders[i],
      }));
    } catch {
      history = [];
    }
  }

  return {
    round: {
      id: Number(round.id),
      phase: Number(round.phase),
      biddingRound: Number(round.biddingRound),
      maxBiddingRounds: Number(round.maxBiddingRounds),
      pot: round.pot,
      depositCount: Number(round.depositCount),
      standingBid: round.standingBid,
      standingBidder: round.standingBidder,
      winner: round.winner,
      winningBid: round.winningBid,
      discount: round.discount,
      released: round.released,
      approvalCount: Number(round.approvalCount),
      registrarApproved: round.registrarApproved,
      chitCoApproved: round.chitCoApproved,
      auditorApproved: round.auditorApproved,
      minimumBid: round.minimumBid,
      maximumBid: round.maximumBid,
      contractBalance: round.contractBalance,
    },
    history,
    members: members.map((m) => ({
      addr: m.addr,
      nullifier: m.nullifier,
      registered: m.registered,
      hasWon: m.hasWon,
      missedPayments: Number(m.missedPayments),
      defaulted: m.defaulted,
      dividends: m.dividends,
      arrears: m.arrears,
      deposited: m.deposited,
      commitment: m.commitment,
      revealed: m.revealed,
      revealedAmount: m.revealedAmount,
      isStanding: m.isStanding,
    })),
    config: {
      registrar: conf[0],
      chitCo: conf[1],
      auditor: conf[2],
      contribution: conf[3],
      groupSize: Number(conf[4]),
      requiredApprovals: Number(conf[5]),
      defaultThreshold: Number(conf[6]),
      maxDiscountBps: Number(conf[7]),
      biddingRounds: Number(conf[8]),
    },
  };
}
