# PajRate Bot

Get PAJ's live rate on Telegram — no login required.

## What it does

PajRate Bot checks PAJ's current rate and shares it with you, either
instantly when you ask, or automatically posted to the group at regular
intervals.

## How to use it

- Add [@PajRate_bot](https://t.me/PajRate_bot) to a chat, or message it directly
- Send `/rate` any time to get the current buy (onramp) and sell (offramp) rate
- Send `/convert <amount> [unit]` to convert between fiat and crypto at the live rate
  - `/convert 50000` → how much crypto 50,000 NGN buys right now
  - `/convert 25 USDT` → how much NGN 25 USDT sells for right now
- Send `/start` for a quick intro

Each rate update shows:
- 📥 Buy rate (onramp)
- 📤 Sell rate (offramp)
- 🟢▲ / 🔴▼ to show if it moved up or down since the last check
- The time the rate was fetched (WAT)

## Notes

- Rates are pulled live at the moment you ask — always current.
