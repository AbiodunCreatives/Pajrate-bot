# pajrate-bot

Telegram bot that posts PAJ Cash's live rate to a channel every 10 minutes,
and replies on demand with `/rate`.

## Status: fully working

The rate source is PAJ's real public endpoint (`GET https://api.paj.cash/pub/rate`) —
the same one their official `paj_ramp` npm SDK uses. No login, no API key.
It returns both the onramp (buy) and offramp (sell) rates, and the bot shows both.

## 1. Create the bot in Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow prompts.
2. Copy the token it gives you.
3. Create (or use) a Telegram channel, add your bot as an **admin** of it
   (needed so it can post there).
4. Get the channel ID: easiest way is the channel's `@username`
   (e.g. `@my_paj_rates`) if it's public. If it's private, forward any
   message from the channel to [@userinfobot](https://t.me/userinfobot) to
   get the numeric `-100...` ID.

## 2. Run locally

```bash
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID
npm install
npm start
```

Message your bot `/start` or `/rate` on Telegram to test.

## 3. Deploy to Fly.io

```bash
# install flyctl if you haven't: https://fly.io/docs/flyctl/install/
fly auth login

# edit fly.toml first: change `app = "pajrate-bot-CHANGE-ME"` to something unique
fly launch --no-deploy   # detects the existing fly.toml, creates the app

# set your secrets (these replace .env in production)
fly secrets set TELEGRAM_BOT_TOKEN=xxx
fly secrets set TELEGRAM_CHANNEL_ID=@your_channel

fly deploy
```

Check logs with `fly logs`.

## Config reference

| Env var | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | from BotFather |
| `TELEGRAM_CHANNEL_ID` | no | — | if unset, scheduled broadcast is skipped; `/rate` still works |
| `CRON_SCHEDULE` | no | `*/10 * * * *` | cron syntax, how often to auto-post |
| `PAJ_ENV` | no | `production` | set to `staging` to hit `api-staging.paj.cash` instead |

## Notes

- The bot shows a 🟢▲ / 🔴▼ arrow per rate (onramp and offramp move
  independently) compared to the last post, so people can see direction at
  a glance.
- If PAJ ever rate-limits this, dial back `CRON_SCHEDULE` (e.g. every
  15–30 min) rather than hammering their endpoint.
- Since this hits a real production endpoint of a company you're not
  affiliated with, it's worth keeping the poll interval reasonable and not
  hammering it — 10 min is fine, don't drop it to every few seconds.
