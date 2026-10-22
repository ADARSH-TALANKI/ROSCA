# Trust-Minimized Chit Fund Platform

A working chit fund on an Ethereum-compatible chain, built so that the four weaknesses
identified in the literature review can be **demonstrated rather than asserted**.

The repository contains two contracts on purpose:

| Contract | Purpose |
|---|---|
| `contracts/ChitFund.sol` | This project's design. Multi-round descending sealed-bid auction, nullifier identity, 2-of-3 custody, statutory discount cap, arrears and default tracking. |
| `contracts/NaiveChitFund.sol` | A deliberately vulnerable reconstruction of the designs reported in the reviewed literature. It exists so each attack can be shown **landing** on prior art and **failing** here. |

---

## Running it

Two terminals, both in this folder.

```bash
npm install          # once

# terminal 1 - the local chain, leave it running
npm run node

# terminal 2 - deploys both contracts and opens the dApp
npm run dev
```

The browser opens on <http://localhost:5173>. The deploy step writes the fresh contract
addresses, ABIs, bytecode and the demo account list into `frontend/src/generated/`, so there is
never an address to copy by hand.

If you restart the chain, run `npm run deploy` again and reload the page.

Other commands:

```bash
npm test             # 56 tests, including the side-by-side attack comparison
npm run bench        # gas and cost evaluation, writes docs/benchmarks.md
npm run compile      # contracts only
npm run demo:cli     # the narrated terminal walkthrough, no browser
```

---

## The dApp

Five tabs, nine personas. Every button sends a real transaction signed by the selected account;
there is no mock layer anywhere in the application.

**1 · Walkthrough** — what the platform is, the seven stages of a round, the live state of the
chain, and the table mapping each literature gap to the mechanism that answers it.

**2 · Identity & KYC** — type a government document number and watch the nullifier being derived
off-chain, see exactly what reaches the contract, and run the Sybil probe: present a document that
is already enrolled and the transaction is refused.

**3 · Auction** — the operating console. Start a round, pay in, seal a bid, open it. The subscriber
board shows what the chain knows at each moment; during the commit phase it shows a column of
hashes and nothing else. The **attack probe** lets a member try to open a bid at a different number
after seeing a rival's, which the contract rejects.

**4 · Settlement** — the 2-of-3 approval panel, the settlement arithmetic, the dividend and arrears
ledger. Try releasing below quorum, or approving as an outsider; both are refused.

**5 · Attack Lab** — five adversarial scenarios, each executed twice against two contracts deployed
fresh for that run.

### Demo order that reads well in a review

1. Walkthrough tab: one minute on the shape of the problem.
2. Identity tab as **Registrar**: enrol all five subscribers, then run the Sybil probe with an
   already-enrolled document.
3. Auction tab as **ChitCo**: start the round. Switch to each subscriber and deposit.
4. As **ChitCo**: open sealed bidding. Have each subscriber seal a bid. Pause on the board: five
   commitments, no amounts.
5. As **ChitCo**: open the opening window. As one subscriber, run the altered-opening probe first,
   then open honestly. Open the rest, then close bidding round 1. The standing bid is published.
6. Bidding round 2: have someone beat it. Type a number *above* the standing bid first so the panel
   watches the input refuse it, then bid below it and seal. Open and close round 2.
7. Bidding round 3: let it attract nothing. Open the window, close it, and the auction settles on
   the standing bid without using the third round.
8. Settlement tab: approve as **Mallory** (refused), approve as **ChitCo**, attempt release at 1-of-2
   (refused), approve as the **Registrar**, release. Leave the Auditor unticked so the threshold
   stays visible.
9. Attack lab: run all five.

---

## The five attack scenarios

Each runs on a throwaway pair of contracts, so it can be replayed in any order and never disturbs
the walkthrough.

| | Attack | Gap | Prior art | This work |
|---|---|---|---|---|
| A1 | Bid sniping on an open auction | G1 | succeeds | blocked |
| A2 | Sybil re-entry with a second wallet | G3 | succeeds | blocked |
| A3 | Operator seizes the escrow | G4 | succeeds | blocked |
| A4 | Replaying someone else's sealed bid | G1 | n/a, nothing is sealed | blocked |
| A5 | Discount past the statutory ceiling | compliance | succeeds | blocked |

A step that is meant to fail is executed against the deployed contract read-only, so it runs the
same bytecode against the same state and returns the contract's own revert string without leaving a
failed transaction on the demo chain. Every step that is meant to succeed is a mined transaction.
The same outcomes are asserted as passing tests in `test/AttackComparison.test.js`.

---

## Mechanisms

### G1 · Auction integrity — commit-reveal

`commitBid(bytes32)` stores `keccak256(abi.encodePacked(amount, salt, msg.sender))`. The amount is
not written to state in any form, so there is nothing for a rival to read; this is structural
absence, not an access modifier. `revealBid(amount, salt)` recomputes the hash and rejects a
mismatch, so a bidder cannot change a number after seeing someone else's.

Binding `msg.sender` into the preimage means a commitment copied off the chain can never be opened
by the copier, which is attack A4.

### G2 · Default handling — bounded, not solved

`openBidding()` records a missed deposit as one `missedPayment` and `monthlyContribution` of
arrears. At `DEFAULT_THRESHOLD` (3) misses the member is marked defaulted **against the nullifier**,
so a fresh wallet does not wash the record, and may no longer bid. At settlement a member carrying
arrears has their dividend applied to the debt first.

This softens the loss; it does not remove it. Collateral large enough to cover a late default would
exclude the subscribers the platform exists for, so the design bounds the exposure and says so.

### G3 · Sybil resistance — nullifier identity (Route B)

The Registrar of Chits verifies documents off-chain and calls
`registerMember(wallet, keccak256(document ‖ platformSalt))`. The contract stores the 32-byte
nullifier and refuses a second enrolment that recomputes the same value. No identifier, hashed or
otherwise, maps back to a person on the chain, and the operator never sees an identity at all.

The nullifier check runs **before** the group-capacity check: re-registration by an already-enrolled
person is an identity violation and is refused whether or not the group has room.

### G4 · Custody — 2-of-3 distributed authority

`approvePayout()` is callable only by the registrar, the operator or the auditor.
`releasePayout()` requires `REQUIRED_APPROVALS` (2). With exactly three approvers, **every valid
pair contains an organisation other than the operator**, so ChitCo can stall a payout but can never
compel one. No function in the contract sends value to a caller-supplied address.

### Compliance

`MAX_DISCOUNT_BPS` is 3000, the 30% ceiling in the Chit Funds Act 1982. It is enforced at reveal,
which is the first moment the number exists. Tied lowest bids go to a draw and a round with no
lawful reveal falls back to a lottery, both of which the Act permits.

---

## Evaluation

`npm run bench` measures gas actually consumed on the EVM, at group sizes from 3 to 50, and
writes the full tables to [`docs/benchmarks.md`](docs/benchmarks.md). Headline figures:

**The security properties cost 33 to 57% more gas than the naive design, and the overhead falls
as the group grows.** Measured like for like at one bidding round, five subscribers cost
1,415,130 gas against 951,111 for `NaiveChitFund`, a penalty of +49%. At fifty it is +33%, and
the per-member overhead drops from 92,804 to 48,346 gas. Sealed bidding, nullifier identity, the
statutory cap, arrears tracking and 2-of-3 custody are a constant-factor cost, not an asymptotic
one.

**Per-member cost improves with group size.** At the shipped three-round configuration a monthly
cycle costs 560,519 gas per member at n=3 and 380,497 at n=50, because the fixed per-round
operations amortise across more subscribers.

**Three operations are O(n)** because they walk the member list: `openBidding` records missed
deposits, `closeBiddingRound` scans revealed bids, and `releasePayout` splits the discount.
`releasePayout` dominates at roughly 27,000 marginal gas per member, which puts the single-block
ceiling near 1,100 subscribers. Real chits run at 10 to 50, so this does not bind in practice,
but it does rule out pooling thousands of subscribers in one contract.

**Price discovery has a measurable price.** Going from one bidding round to two costs +35% gas at
five subscribers and deepens the discount from 15.0% to 20.0% of the pot. A third round costs
+70% over one and reaches 22.5%. The returns diminish while the cost stays linear, which is the
argument for three rounds rather than five.

**The platform choice is a cost argument, not a throughput argument.** A ten-subscriber cycle
costs 4,493,301 gas. On Ethereum mainnet at 20 gwei that is 0.0090 ETH per member per month;
on a rollup at 1 gwei, 0.0004 ETH; on a permissioned chain, nothing. A chit fund whose
subscribers save a thousand rupees a month cannot pass a per-transaction fee to them at all.
That constraint is what should decide the deployment platform, and measuring it is the point of
next semester's Hyperledger Fabric comparison.

---

## The auction

A single sealed round per month defeats sniping but removes price discovery: a bidder has no idea what anyone else will accept, so the winning discount is
whichever blind guess happened to be boldest.

A physical chit auction does not work that way. Subscribers sit in a room, hear the standing bid,
and decide whether to go lower. The contract reproduces that while keeping the
anti-sniping property:

```
bidding round 1:  commit -> reveal -> publish the standing lowest bid
bidding round 2:  commit -> reveal -> publish the standing lowest bid
bidding round 3:  commit -> reveal -> settle
```

Inside a bidding round nobody can see anyone else's number, so attack A1 still fails. Between
rounds the standing bid is public, so the auction converges instead of guessing. A later bid must
come in **strictly below** the standing bid, which makes the auction monotonically descending and
guarantees it terminates. A subscriber who does not want to go lower simply does not commit again,
and if nobody improves the auction settles early without using the remaining rounds.

The number of bidding rounds is a constructor parameter (1 to 5), so the gas-versus-discovery
trade-off is configurable per chit rather than fixed in the contract.

**Two deliberate disclosures.** The standing bidder's address is visible between rounds. That
mirrors the physical auction, and it is unavoidable in any case: contract storage is publicly
readable whatever its declared visibility, so calling it hidden would be a false claim rather than
a security property.

**Tied bids.** An earlier revision broke ties with a draw seeded from `block.prevrandao` and
`block.timestamp`. Because only the operator may close the auction, the
operator picks the moment, and can dry-run the call off-chain for free until the draw favours a
chosen bidder. The contract now seeds the draw from the revealed salts instead. Every salt was
committed before its bidder knew anything, no participant controls the aggregate, and the
operator's choice of timing has no effect on the result. The residual weakness is that the last
bidder to reveal could withhold to change the seed, but withholding forfeits their own bid, which
is a strictly worse trade than the one it replaces. The empty-auction lottery still falls back to
`block.prevrandao`, because with no reveals there are no salts to draw from, and that path remains
demo-grade.

---

## Known limitations

These are stated in the dApp as well, because a review should hear them from us first.

1. **The fiat leg is out of scope.** Contributions are ETH on a local chain. A production deployment
   needs a regulated custody path between rupees and the escrow.
2. **Randomness is only partly solved.** `the multi-round auction` seeds tie-breaks from the revealed
   salts, which removes the operator's ability to grind the outcome. `ChitFund` still uses
   `block.prevrandao` and `block.timestamp` for tie-breaks, and both contracts still use
   `block.prevrandao` for the empty-auction lottery, where no salts exist to draw from.
3. **Default risk is bounded, not solved.** A member who wins early and stops paying still leaves the
   group short.
4. **The number of bidding rounds is a policy choice, not a result.** Three is shipped because the
   gas-versus-discount curve flattens after it, but a deeper discount transfers value from whoever
   needs the pot most urgently to everyone who can wait, which is a question for a regulator rather
   than for this contract.
5. **The registrar is trusted to derive the nullifier honestly** (Route B, role separation). A
   zero-knowledge proof of document possession (Route A) removes that trust and is next semester's
   work, alongside the Hyperledger Fabric implementation and the platform comparison.

---

## Layout

```
contracts/     ChitFund.sol, NaiveChitFund.sol
test/          ChitFund.test.js (49), AttackComparison.test.js (7)
scripts/       deploy.js, demo.js, benchmark.js
docs/          benchmarks.md, benchmarks.json (written by npm run bench)
frontend/      index.html
  src/         App.jsx, chain.js, lab.js, styles.css, main.jsx
  src/components/   TopBar, ActorBar, PhaseStepper, Overview,
                    IdentityTab, RoundTab, PayoutTab, AttackLab, EventLog, ui
  src/generated/    written by npm run deploy, do not edit
```
#   R O S C A  
 