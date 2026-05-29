# Morphix

Morphix is a Discord.js v14 temporary voice channel bot that creates private room instances from trigger voice channels.

## Features

- Creates a temp voice channel when a user joins a trigger channel
- Moves the user into the new channel automatically
- Recycles names per tier so each tier keeps its own room list
- Dynamically raises and lowers the user limit
- Debounces updates to reduce Discord API rate-limit pressure
- Deletes empty temp channels immediately and recycles their names
- Posts an owner-only control panel with `/panel`
- Lets the owner lock, block, unblock, or kick in the room
- Automatically creates two categories on join:
  - `Create VC` for the trigger channels
  - `Heavy Dens` for the spawned temp rooms
- Uses plain tier names for the created temp rooms

## Trigger Channels

Create voice channels in the category you want and name them exactly:

- `duo`
- `trio`
- `squad`
- `penta`
- `hexa`
- `raid`

Morphix can also auto-create both categories and these trigger channels when it joins a server.

## Requirements

- Node.js 18 or newer
- A Discord bot token

## Install

```bash
npm install
```

## Configure

Create a `.env` file in this folder:

```env
BOT_TOKEN=your_bot_token_here
```

## Run

```bash
npm start
```

## Commands

- `/panel` posts the Morphix control panel as an ephemeral message only the command user can see.

## Files

- `Morphix.js` - bot entry file
- `package.json` - dependencies and scripts
- `.env.example` - sample environment file

## Notes

- The bot only needs the `Guilds` and `GuildVoiceStates` intents.
- Make sure the bot has permission to manage channels, move members, and edit voice channel permissions.
- The control panel is private because it is sent ephemerally to the owner who runs `/panel`.
