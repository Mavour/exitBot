# DLMM Exit Agent

Production-ready autonomous exit agent for Meteora DLMM positions on Solana.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env: add RPC_URL and WALLET_PRIVATE_KEY

# 3. Test with dry run (DRY_RUN=true by default)
npm run dev

# 4. Deploy to VPS
npm run build
pm2 start ecosystem.config.js
pm2 logs dlmm-exit-agent
```

## How It Works

The agent polls every 60 seconds. For each active DLMM position in the wallet, it:

1. Fetches the last 60 x 15-minute candles from DexScreener (free, no API key)
2. Calculates **Smoothed RSI**: raw RSI(2) → smoothed with SMA(14)
3. Calculates **Bollinger Bands**: BB(20, 2σ) on close prices
4. If smoothed RSI ≥ 90 **AND** price > Upper BB → executes full exit automatically

### Exit Sequence

1. Claim all unclaimed swap fees
2. Remove all liquidity from every bin
3. Close the position account (recovers rent SOL)

### Indicator Logic (matches TradingView exactly)

```
RSI Settings:   Length=2, Smoothing Line=SMA, Smoothing Length=14
BB Settings:    Length=20, StdDev=2
Exit Trigger:   SmoothedRSI >= 90 AND Close > BB_Upper (both on same 15m candle)
```

## Risk Notes

- Always verify with `DRY_RUN=true` before going live
- RSI(2)+SMA(14) ≥ 90 is very sensitive — can trigger more frequently than RSI(14)
- The agent exits ALL active DLMM positions when triggered
- Keep ≥ 0.01 SOL in wallet for priority fees

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | — | Solana RPC endpoint |
| `WALLET_PRIVATE_KEY` | — | Base58 or JSON uint8 array private key |
| `POLL_INTERVAL_MS` | 60000 | Check interval in milliseconds |
| `DRY_RUN` | true | Simulate only when true |
| `RSI_PERIOD` | 2 | Raw RSI length |
| `RSI_SMOOTHING_LENGTH` | 14 | SMA smoothing length applied to raw RSI |
| `RSI_THRESHOLD` | 90 | Smoothed RSI exit trigger level |
| `BB_PERIOD` | 20 | Bollinger Band SMA period |
| `BB_STD_DEV` | 2 | Bollinger Band standard deviation multiplier |
| `PRIORITY_FEE_MICROLAMPORTS` | 100000 | Compute unit price in microlamports |
| `SLIPPAGE_BPS` | 100 | Slippage tolerance in basis points (1%) |
| `COMMITMENT` | confirmed | Solana transaction commitment level |
