/**
 * The Furnace — transfer-fee edition.
 *
 *   MINT=<mint> WALLET=./wallet.json npx tsx scripts/harvest.ts
 *
 * For a Token-2022 mint with a transfer fee. Every transfer withholds a slice
 * of tokens automatically, enforced by the token program itself. This process
 * sweeps those withheld tokens together and burns them.
 *
 * Nothing is bought and no SOL is spent beyond transaction fees. The tokens are
 * already tokens — they just get destroyed.
 *
 * REQUIREMENT: the wallet running this must hold the mint's
 * withdrawWithheldAuthority. If the launchpad kept that authority, this cannot
 * work and the fee goes wherever they send it instead. Check before launching.
 */
import {
  Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferFeeConfig,
  getAssociatedTokenAddress, getAccount, createBurnInstruction,
  withdrawWithheldTokensFromAccounts, withdrawWithheldTokensFromMint,
  getTransferFeeAmount, unpackAccount,
} from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const MINT = new PublicKey(process.env.MINT!);
const KEYFILE = process.env.WALLET ?? "./wallet.json";
const EVERY_MS = Number(process.env.EVERY_MS ?? 30_000);
const MIN_BURN_RAW = BigInt(process.env.MIN_BURN_RAW ?? "1000000"); // 1 token at 6dp

const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const stamp = () => new Date().toISOString().slice(11, 19);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = load(KEYFILE);
  const me = kp.publicKey;

  const mint = await getMint(conn, MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(mint);
  if (!feeCfg) throw new Error("That mint has no transfer fee. Use scripts/furnace.ts instead.");

  const wa = feeCfg.withdrawWithheldAuthority;
  console.log("furnace lit (transfer-fee mode)");
  console.log("  mint     ", MINT.toBase58());
  console.log("  fee      ", feeCfg.newerTransferFee.transferFeeBasisPoints / 100 + "%");
  console.log("  max fee  ", feeCfg.newerTransferFee.maximumFee.toString());
  console.log("  withdraw authority", wa?.toBase58() ?? "none");
  console.log("  this wallet       ", me.toBase58());
  if (!wa || !wa.equals(me)) {
    console.log("\n  ⚠  This wallet does NOT hold the withdraw-withheld authority.");
    console.log("     Withheld fees cannot be harvested here. Nothing will burn.");
    console.log("     Ask the launchpad to assign it, or launch the mint yourself.\n");
  }

  const ata = await getAssociatedTokenAddress(MINT, me, false, TOKEN_2022_PROGRAM_ID);
  let burns = 0, lifetime = 0n;

  async function cycle() {
    try {
      // 1. find every account currently holding withheld fees
      const accs = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: MINT.toBase58() } }],
      });

      const holding: PublicKey[] = [];
      let pending = 0n;
      for (const a of accs) {
        try {
          const acct = unpackAccount(a.pubkey, a.account, TOKEN_2022_PROGRAM_ID);
          const withheld = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;
          if (withheld > 0n) { holding.push(a.pubkey); pending += withheld; }
        } catch {}
      }

      // fees can also collect on the mint itself
      const m = await getMint(conn, MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
      const onMint = getTransferFeeConfig(m)?.withheldAmount ?? 0n;

      if (pending + onMint < MIN_BURN_RAW) return;

      // 2. pull them into our account (batched — the tx has a size limit)
      if (holding.length) {
        for (let i = 0; i < holding.length; i += 20) {
          await withdrawWithheldTokensFromAccounts(
            conn, kp, MINT, ata, me, [], holding.slice(i, i + 20), undefined, TOKEN_2022_PROGRAM_ID);
        }
      }
      if (onMint > 0n) {
        await withdrawWithheldTokensFromMint(
          conn, kp, MINT, ata, me, [], undefined, TOKEN_2022_PROGRAM_ID);
      }

      // 3. burn the lot
      const acct = await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (acct.amount === 0n) return;

      const tx = new Transaction().add(
        createBurnInstruction(ata, MINT, me, acct.amount, [], TOKEN_2022_PROGRAM_ID));
      tx.feePayer = me;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction(sig, "confirmed");

      const after = await getMint(conn, MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
      burns++; lifetime += acct.amount;
      const t = Number(acct.amount) / 10 ** mint.decimals;
      console.log(`${stamp()}  burned ${t.toLocaleString(undefined,{maximumFractionDigits:0})}` +
        ` from ${holding.length} accounts · supply now ` +
        `${(Number(after.supply)/10**mint.decimals).toLocaleString()}`);
      console.log(`          ${sig}`);
    } catch (e: any) {
      console.error(stamp(), "cycle failed:", String(e?.message ?? e).slice(0, 150));
    }
  }

  await cycle();
  setInterval(cycle, EVERY_MS);
  process.on("SIGINT", () => {
    console.log(`\nfurnace out. ${burns} burns, ` +
      `${(Number(lifetime)/10**mint.decimals).toLocaleString()} tokens destroyed.`);
    process.exit(0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
