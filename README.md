# Callout Snap

Private snapshot engine with a **broadcast-only** Telegram channel.

Viewers can watch snapshot announcements, the roulette animation, and distribution confirmations. They cannot configure the bot, trigger rounds, change allocations, pause the system, or influence recipient selection.

## Architecture

```text
PUBLIC
  Telegram channel  →  broadcast messages only

PRIVATE
  Callout collector
       ↓
  Snapshot engine
       ↓
  Recipient selection (CSPRNG)
       ↓
  Treasury
       ↓
  Blockchain
       ↓
  Telegram broadcast
```

Telegram is an output layer. It is never the control plane for the treasury.

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

The page is the **private operations console**. The left pane is a live preview of the public broadcast channel, including edited messages. Use **Run snapshot now** to fire a round immediately. In demo mode a first snapshot also runs shortly after boot; later rounds are randomized between 5–15 minutes.

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
  -d '{"token":"$BONK","callerUsername":"alpha","wallet":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU","source":"private-ingest"}'
```

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
