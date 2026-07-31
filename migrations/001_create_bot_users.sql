-- Migration: 001_create_bot_users
-- Creates the bot_users table for tracking every Telegram user
-- who has interacted with PajRate bot.

create table if not exists bot_users (
  id             bigserial primary key,
  chat_id        text        not null unique,   -- Telegram chat/user ID (stored as string)
  username       text,                          -- Telegram @username, may be null or change
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  wallet_address text                           -- Solana wallet for USDC delivery
);

-- Fast lookup by chat_id (most common query)
create index if not exists bot_users_chat_id_idx on bot_users (chat_id);
