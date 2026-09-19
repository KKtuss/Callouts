# Callout Snap

Private snapshot engine for **one coin** with a **broadcast-only** Telegram channel.

Viewers can watch snapshot announcements, the roulette animation, and distribution confirmations. They cannot configure the bot, trigger rounds, change allocations, pause the system, or influence recipient selection.

## Architecture

```text
PUBLIC
  Pump.fun app/web  →  callouts on the configured mint
  Telegram channel  →  broadcast messages only

PRIVATE
  Pump poller (mint-locked) → unique collector (1 per wallet/username)
       ↓
  Snapshot engine (random 5–15 min window)
       ↓
  Recipients: last unique callout + one CSPRNG unique callout
       ↓
  Treasury sendout (both wallets)
       ↓
  Telegram broadcast
```

Telegram is an output layer. It is never the control plane for the treasury. The engine is locked to one mint (`CALLOUT_MINT`). Aiden is the current test mint; swap the env for launch.

## What the public channel publishes

Each round edits a small set of messages instead of flooding the channel:

1. **Snapshot announcement** — callout count and window, then selection begins.
2. **Roulette** — one message edited through a visual spin, then the pre-selected winner.
3. **Recipients** — last valid callout plus roulette winner.
4. **Treasury sendout** — pending, then confirmed, with explorer links.
5. **Final confirmation** — signatures, amounts, next randomized window.

The roulette animation is cosmetic. The winner is committed with `node:crypto.randomInt` **before** the first spin frame is published. The first allocation is deterministic: the last valid callout before the snapshot timestamp.

## Run locally

```bash
npm install
cp .env.example .env.local
npm test
npm run dev
```

Open [http://127.0.0.1:43147](http://127.0.0.1:43147).

The page is the **private operations console**. Live mode (`DEMO_FEED=false`, `PUMP_INGEST=true`) polls Pump.fun for the configured mint and stores the first callout per username or wallet in the current window. Snapshots fire at a random time between 5 and 15 minutes, freeze that window, and send treasury allocations to the last unique caller and one random unique caller. Use **Run snapshot now** to fire a round immediately.

## Optional live Telegram publishing

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in `.env.local`. The engine will:

- send/edit the same lifecycle messages in that channel
- call `deleteMyCommands` / `setMyCommands []` so the bot has no public command menu
- ignore inbound updates at `POST /api/telegram/webhook`

Do **not** add a command menu, group privacy commands, or a control webhook. Channel permissions should allow only the bot to post; viewers should only be able to read.

Without those env vars, the in-app channel is the public surface and the engine still runs end to end with a mocked treasury.

## Private ingest

Callouts enter through the collector, not Telegram:

```bash
curl -X POST http://127.0.0.1:43147/api/ingest/callout \
  -H 'content-type: application/json' \
  -d '{"callerUsername":"alpha","wallet":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU","source":"private-ingest"}'
```

The engine is locked to a single coin (`CALLOUT_TOKEN` / `CALLOUT_MINT`, default `$AIDEN` / `4i5FqkfYDAPcEVcXyuVyaaBcz3bpwJPqDkmaF36kpump`). Other tickers are rejected. Live ingest polls `GET https://frontend-api-v3.pump.fun/home-feed/new` (Pump’s chronological “new” callouts across all coins) and keeps only rows for the watched mint. Pump’s `/callout/top/{mint}` ranks by peak multiple, not time, so it is not used for live capture. Callouts older than the current window are ignored for snapshots, but all accepted callouts since mint watch count toward the bonding bonus (≥3 accepted → eligible). On Pump bonding/migration, one random still-holding eligible wallet receives the configured migration bonus (default 10M = 1% of 1B supply).

If `ADMIN_KEY` is set, send it as `x-admin-key` (or a `admin_key` cookie). Pause, resume, snapshot, and config endpoints live under `/api/admin/*` and are not exposed as Telegram commands.

## Audit trail

Every snapshot stores:

- snapshot timestamp and previous snapshot timestamp
- callout count and the frozen window
- last callout
- roulette candidate pool, index, winner
- CSPRNG entropy hex and `node:crypto.randomInt`
- recipient wallets and allocation amounts
- transaction signatures, explorer URLs, and confirmation status

Public messages show amounts, truncated wallets, and clickable signatures. They never include private keys or treasury secrets.

## Channel setup notes

1. Create a broadcast channel.
2. Add the bot as an administrator that can post (and edit) messages.
3. Turn off user comments / discussion if you want a strictly read-only view.
4. Do not enable a bot command list.
5. Point any webhook at `/api/telegram/webhook` only if you must — inbound updates are discarded.
