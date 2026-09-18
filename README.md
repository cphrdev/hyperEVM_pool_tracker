# hyperEVM_pool_tracker

Small Node.js monitor that checks configured DeFi position APIs and sends a Telegram message when a concentrated-liquidity position goes out of range.

It is intentionally defensive: the three apps can change their frontend/API shape, so the monitor accepts configurable endpoints and detects range status from common fields such as `currentTick`, `tickLower`, `tickUpper`, `minTick`, `maxTick`, `inRange`, `outOfRange`, or textual status labels.

## Setup

1. Copy the examples:

```bash
cp .env.example .env
cp config.example.json config.json
```

2. Edit `.env` with your Telegram bot token and chat id.

3. Edit `config.json` and enable each source after adding its positions endpoint. Endpoints may use `{wallet}` as a placeholder.

4. Test once:

```bash
npm run check
```

5. Run continuously:

```bash
npm run monitor
```


## Source Types

Sources can be simple JSON APIs or GraphQL subgraphs. For Uniswap V3-style subgraphs, use:

```json
{
  "name": "Project X",
  "type": "subgraph",
  "enabled": true,
  "url": "https://api.goldsky.com/api/public/project_cmbbm2iwckb1b01t39xed236t/subgraphs/uniswap-v3-hyperevm-position/prod/gn"
}
```

The monitor sends a default positions query using the configured wallet as the lowercase `owner` variable and reads `tickLower.tickIdx`, `tickUpper.tickIdx`, and `pool.tick` to decide whether each position is out of range.

For Nest, it also includes Ichi/Automatic positions when the asset accepted for a one-sided deposit is `UBTC`, `WHYPE`, or `HYPE`. These are marked `AUTOMATIC` in the report and are included in the value, APR, and holdings totals. Automatic pools do not have a user-defined price range, so they do not trigger out-of-range alerts.

## Telegram

Create a bot with `@BotFather`, then get your chat id by sending the bot any message and opening:

```text
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

## Alert Behavior

Every check sends every currently out-of-range position. Positions that were in range on the previous check and are out of range now are labeled `NEW Pool OUT OF RANGE`. The default check interval is 5 minutes.

## What Counts As Out Of Range

For V3/concentrated liquidity positions, the monitor marks a position out of range when:

```text
currentTick < lowerTick OR currentTick >= upperTick
```

If ticks are not present, it falls back to common API flags and strings like `outOfRange`, `inRange`, `status: "out of range"`, or `rangeStatus`.

## Notes

The current workspace did not contain existing code. I inspected the public app bundles enough to confirm Nest uses a helper-style `GET /user-positions/{wallet}` call; Project X and HyperSwap may require their exact public helper/subgraph endpoint to be filled into `config.json`.
