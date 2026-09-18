/**
 * The Furnace.
 *
 *   MINT=<mint> npx tsx scripts/furnace.ts
 *
 * Sweeps SOL from the fee wallet, buys the token on the open market through
 * Jupiter, and burns what it buys against the mint. On a loop, forever.
 *
 * There is no tax on anyone's trade. Nothing is deducted from a buy or a sell.
 * The SOL comes from creator fees the launchpad already pays, which would
 * otherwise sit in a wallet doing nothing.
 *
 * Every burn is a public transaction. Total supply on the mint is the proof —
 * it only ever goes down, and anybody can check it against any explorer without
 * trusting a word of this.
 *
 * Deliberately has no on-chain program. There is nothing to deploy, no rent
 * locked up, no upgrade authority, and nothing to audit. The keeper cannot take
 * anything: it buys and burns, and a burn is irreversible.
 */
import {
  Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, createBurnInstruction, getAccount,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint,
} from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const MINT = new PublicKey(process.env.MINT!);
const KEYFILE = process.env.WALLET ?? "./wallet.json";

const EVERY_MS   = Number(process.env.EVERY_MS ?? 90_000);  // how often to sweep
const FLOAT      = Number(process.env.FLOAT ?? 0.05) * LAMPORTS_PER_SOL;  // leave for gas
const MIN_BURN   = Number(process.env.MIN_BURN ?? 0.01) * LAMPORTS_PER_SOL;
const SLIPPAGE   = Number(process.env.SLIPPAGE ?? 300);      // 3%
const LOG        = "./burns.json";

function load(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function record(entry: any) {
  let all: any[] = [];
  try { all = JSON.parse(fs.readFileSync(LOG, "utf8")); } catch {}
  all.unshift(entry);
  fs.writeFileSync(LOG, JSON.stringify(all.slice(0, 500), null, 2));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = load(KEYFILE);
  const me = kp.publicKey;

  const mintAcct = await conn.getAccountInfo(MINT);
  if (!mintAcct) throw new Error("No mint at that address.");
  const TOKPROG = mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const info = await getMint(conn, MINT, undefined, TOKPROG);

  console.log("furnace lit");
  console.log("  rpc     ", RPC.split("?")[0]);
  console.log("  mint    ", MINT.toBase58());
  console.log("  program ", TOKPROG.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "classic SPL");
  console.log("  wallet  ", me.toBase58());
  console.log("  supply  ", (Number(info.supply) / 10 ** info.decimals).toLocaleString());
  console.log("  sweeping every", EVERY_MS / 1000, "s\n");

  let busy = false;
  let lifetimeSol = 0, lifetimeTokens = 0n, burns = 0;

  async function cycle() {
    if (busy) return;
    busy = true;
    try {
      const bal = await conn.getBalance(me);
      const spend = bal - FLOAT;
      if (spend < MIN_BURN) return;

      // 1. quote SOL -> token on the open market
      const q = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112` +
        `&outputMint=${MINT.toBase58()}&amount=${spend}&slippageBps=${SLIPPAGE}`
      ).then(r => r.json());
      if (!q || q.error || !q.outAmount) {
        console.error(stamp(), "no route yet:", q?.error ?? "empty quote");
        return;
      }

      // 2. swap
      const sw = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: q,
          userPublicKey: me.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      }).then(r => r.json());
      if (!sw?.swapTransaction) { console.error(stamp(), "swap build failed"); return; }

      const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
      tx.sign([kp]);
      const buySig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction(buySig, "confirmed");

      // 3. burn every token now held — the whole point
      const ata = await getAssociatedTokenAddress(MINT, me, false, TOKPROG);
      const acct = await getAccount(conn, ata, "confirmed", TOKPROG);
      const amount = acct.amount;
      if (amount === 0n) { console.error(stamp(), "bought nothing to burn"); return; }

      const { Transaction } = await import("@solana/web3.js");
      const burnTx = new Transaction().add(
        createBurnInstruction(ata, MINT, me, amount, [], TOKPROG)
      );
      burnTx.feePayer = me;
      burnTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      burnTx.sign(kp);
      const burnSig = await conn.sendRawTransaction(burnTx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction(burnSig, "confirmed");

      const after = await getMint(conn, MINT, "confirmed", TOKPROG);
      lifetimeSol += spend / LAMPORTS_PER_SOL;
      lifetimeTokens += amount;
      burns++;

      const tokens = Number(amount) / 10 ** info.decimals;
      console.log(
        stamp(),
        `burned ${tokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens` +
        ` for ${(spend / LAMPORTS_PER_SOL).toFixed(4)} SOL` +
        ` · supply now ${(Number(after.supply) / 10 ** info.decimals).toLocaleString()}`
      );
      console.log(`          buy ${buySig}`);
      console.log(`          burn ${burnSig}`);

      record({
        at: new Date().toISOString(),
        sol: spend / LAMPORTS_PER_SOL,
        tokens,
        supplyAfter: Number(after.supply) / 10 ** info.decimals,
        buySig, burnSig,
      });
    } catch (e: any) {
      console.error(stamp(), "cycle failed:", String(e?.message ?? e).slice(0, 140));
    } finally {
      busy = false;
    }
  }

  const stamp = () => new Date().toISOString().slice(11, 19);

  await cycle();
  setInterval(cycle, EVERY_MS);

  process.on("SIGINT", () => {
    console.log(`\nfurnace out. ${burns} burns, ${lifetimeSol.toFixed(3)} SOL spent.`);
    console.log("nothing is held — every token bought was destroyed.");
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
