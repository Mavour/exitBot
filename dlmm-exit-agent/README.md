# DLMM Exit Agent

Production-ready autonomous exit agent for Meteora DLMM positions on Solana.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your RPC URL and wallet private key

# 3. Test with dry run (default)
npm run dev

# 4. When satisfied, set DRY_RUN=false and deploy
npm run build
pm2 start dist/index.js --name dlmm-exit-agent
pm2 logs dlmm-exit-agent
```

## How It Works

The agent polls every 60 seconds. For each active DLMM position in your wallet, it:

1. Fetches the last 60 x 15-minute candles for the pool's base token from DexScreener
2. Calculates RSI(14) and Bollinger Bands(20, 2σ)
3. If RSI ≥ 90 AND price > Upper BB → executes full exit automatically

### Exit Sequence

1. Claim all unclaimed swap fees
2. Remove all liquidity from every bin
3. Close the position account (recovers rent SOL)

## Risk Notes

- Always test with `DRY_RUN=true` first
- RSI 90 + above BB is an extreme condition — may trigger rarely or during genuine price spikes
- The agent exits ALL active positions when triggered — it does not distinguish between pools
- Keep enough SOL in wallet for priority fees (~0.01 SOL buffer recommended)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | — | Solana RPC endpoint |
| `WALLET_PRIVATE_KEY` | — | Base58 or JSON uint8 array private key |
| `POLL_INTERVAL_MS` | 60000 | Check interval in milliseconds |
| `DRY_RUN` | true | Simulate only when true |
| `RSI_PERIOD` | 14 | RSI calculation period |
| `RSI_THRESHOLD` | 90 | RSI exit trigger level |
| `BB_PERIOD` | 20 | Bollinger Band SMA period |
| `BB_STD_DEV` | 2 | Bollinger Band standard deviation multiplier |
| `PRIORITY_FEE_MICROLAMPORTS` | 100000 | Compute unit price in microlamports |
| `SLIPPAGE_BPS` | 100 | Slippage tolerance in basis points (1%) |
| `COMMITMENT` | confirmed | Solana transaction commitment level |
