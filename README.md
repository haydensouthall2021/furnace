# The Furnace

**Supply only goes one way.**

Every trade pays a creator fee. That fee buys this token on the open market and
burns it. On a loop, forever.

**There is no tax on your trade.** No buy tax, no sell tax, no transfer tax.
Nothing is deducted from anyone, and no wallet is exempt — because there is
nothing to be exempt from. The fuel is the creator fee the launchpad already
charges, which would otherwise sit in a wallet doing nothing.

**Watch it:** [the live supply counter](https://haydensouthall2021.github.io/furnace/)

---

## What actually happens

1. Someone trades the token. The launchpad pays a creator fee, as it does for
   every token.
2. A keeper sweeps that SOL out of the fee wallet.
3. It **buys the token on the open market** through Jupiter — a real buy, at
   the real price, alongside everyone else.
4. It **burns everything it just bought** with a `burn` instruction against the
   mint.
5. Repeat.

More volume means more fees means more buying and burning. The supply figure
falls faster the busier it gets.

---

## Why there is no on-chain program

There does not need to be one, and saying so is more honest than shipping one
for show.

A burn is irreversible and a token supply is public. The proof is not a clever
contract — it is the mint's own supply field going down, and a burn transaction
you can open on any explorer.

So: no program to deploy, no rent locked up, no upgrade authority that could be
misused later, and nothing to audit. The keeper can buy and it can burn. It
cannot mint, cannot freeze, and cannot take anything, because burned tokens are
gone for everybody including whoever runs it.

---

## Verify it, do not trust it

**Total supply.** Open the mint on any explorer and read the supply. It should
match the site and be lower than it was yesterday.

**The burns.** Every burn in the feed links to its transaction. Open one — you
will see a burn instruction against the mint with the amount.

**Mint authority.** Revoked at launch, so no more can ever be created. The
supply can only fall. Check the authority field yourself.

**The furnace wallet.** Public. Its entire history is buys followed by burns and
nothing else.

---

## Running it

```bash
npm install
MINT=<mint> RPC=<your rpc> WALLET=./wallet.json npx tsx scripts/furnace.ts
```

| Variable | Default | |
|---|---|---|
| `EVERY_MS` | 90000 | How often to sweep and burn |
| `FLOAT` | 0.05 | SOL left behind for transaction fees |
| `MIN_BURN` | 0.01 | Do not bother below this |
| `SLIPPAGE` | 300 | 3%, in basis points |

Writes every burn to `burns.json`, which the site reads for the live feed.

---

## Honest limits

**The sweep is not trustless.** Creator fees land in a wallet before being spent
on buying and burning. Nothing on-chain forces that to happen. The wallet
address is published so anyone can check it is actually happening — and if the
sweeps stopped, the supply chart would flatten and everyone would see it
immediately.

**Slippage is real.** The keeper buys at market. In thin liquidity a buy moves
the price, and that is a cost paid by the burn rather than by traders.

**Burning is not a price guarantee.** It reduces supply. What that does to
price depends entirely on demand, and nobody can promise anything about that.

**Nothing here is financial advice or an offer of anything.**

## Licence

MIT.
