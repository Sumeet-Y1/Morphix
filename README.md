# Morphix

Morphix is a Discord.js v14 temporary voice channel bot that creates dynamic private voice channels from a hub channel.

## Features

- Creates a temp voice channel when a user joins the hub channel
- Moves the user into the new channel automatically
- Dynamically changes channel names by player count tier
- Dynamically raises and lowers the user limit
- Debounces updates to reduce Discord API rate-limit pressure
- Deletes empty temp channels immediately and recycles their names

## Requirements

- Node.js 18 or newer
- A Discord bot token
- The hub voice channel ID

## Install

```bash
npm install
```

## Configure

Create a `.env` file in this folder:

```env
BOT_TOKEN=your_bot_token_here
HUB_CHANNEL_ID=your_hub_voice_channel_id_here
```

## Run

```bash
npm start
```

## Files

- `Morphix.js` - bot entry file
- `package.json` - dependencies and scripts
- `.env.example` - sample environment file

## Notes

- The bot only needs the `Guilds` and `GuildVoiceStates` intents.
- Make sure the bot has permission to manage channels and move members in the server.
- The hub channel should be a voice channel inside the category where temp channels should be created.
