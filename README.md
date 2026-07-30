# PajRate Bot

Get PAJ's live rate on Telegram — no login required.

## What it does

PajRate Bot checks PAJ's current buy and sell rates and shares them with you,
either instantly when you ask, or automatically posted to a channel at regular intervals.

## How to use it

- Add [@PajRate_bot](https://t.me/PajRate_bot) to a chat, or message it directly
- Send `/rate` any time to get the current buy (onramp) and sell (offramp) rate
- Send `/convert <amount> [unit]` to convert between fiat and crypto at the live rate
  - `/convert 50000` → how much USDT ₦50,000 buys right now
  - `/convert 25 USDT` → how much NGN 25 USDT sells for right now
  - `/convert 5 SOL` → how much NGN 5 SOL is worth right now
  - Supported tokens: NGN, USDT, USDC, USD, SOL, JUP, BONK, ANSEM, PENGU, SKR
- Send `/alert <token> <above|below> <price>` to set a price alert
  - `/alert SOL above 150` → ping when SOL crosses $150
  - `/alert buy above 1650` → ping when PAJ buy rate crosses ₦1,650
- Send `/alerts` to view your active alerts
- Send `/removealert <id>` to cancel an alert
- Send `/help` for the full command guide

## Pajero — natural language assistant

You don't need to use commands. Just talk to the bot naturally:

- _"what's the rate"_
- _"convert 5 sol"_
- _"convert 50000"_
- _"alert me when SOL hits 150"_
- _"show my alerts"_

Works in DMs and in group chats (tag the bot or disable Group Privacy Mode in BotFather).

## Each rate update shows

- 📥 Buy rate (onramp)
- 📤 Sell rate (offramp)
- 🟢▲ / 🔴▼ to show if it moved up or down since the last check
- The time the rate was fetched (WAT)

## Notes

- Rates are pulled live at the moment you ask — always current.
- Token prices (SOL, JUP, BONK, ANSEM, PENGU, SKR) are fetched from CoinGecko and cached for 30 seconds.
- Price alerts are one-time — they fire once and are removed automatically.
