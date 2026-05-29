require("dotenv").config();

const {
  Client,
  ChannelType,
  GatewayIntentBits,
} = require("discord.js");

/*
  Install:
    npm i discord.js dotenv

  Configure:
    BOT_TOKEN=your_bot_token_here
    HUB_CHANNEL_ID=your_hub_voice_channel_id_here

  Run:
    node Morphix.js
*/

const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const HUB_CHANNEL_ID = process.env.HUB_CHANNEL_ID || "PUT_HUB_CHANNEL_ID_HERE";
const DEBOUNCE_MS = 2500;

// Source-of-truth tier pools. Each guild gets its own active-name Set per tier.
// A name is reserved while a temp channel is alive and freed immediately on delete
// or when the channel upgrades into another tier.
const TIER_NAME_POOLS = {
  duo: ["Duo I", "Duo II", "Duo III", "Duo IV", "Duo V"],
  trio: ["Trio 1", "Trio 2", "Trio 3", "Trio 4", "Trio 5"],
  squad: ["Squad Alpha", "Squad Bravo", "Squad Charlie", "Squad Delta", "Squad Echo"],
  penta: ["Penta Alpha", "Penta Beta", "Penta Gamma", "Penta Omega"],
  raid: ["Raid Mythic", "Raid Immortal", "Raid Apex"],
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// In-memory state only. The bot tracks every temp channel it created so it can
// debounce edits, recycle names, and delete empty channels cleanly.
const tempChannels = new Map(); // channelId -> { guildId, tierKey, name, spawnLocked, timer, updating, reschedule }
const guildNamePools = new Map(); // guildId -> { duo:Set, trio:Set, squad:Set, penta:Set, raid:Set }

function ensureGuildPools(guildId) {
  if (!guildNamePools.has(guildId)) {
    guildNamePools.set(guildId, {
      duo: new Set(),
      trio: new Set(),
      squad: new Set(),
      penta: new Set(),
      raid: new Set(),
    });
  }

  return guildNamePools.get(guildId);
}

function getUsedNameSet(guildId, tierKey) {
  return ensureGuildPools(guildId)[tierKey];
}

function reserveName(guildId, tierKey) {
  const usedNames = getUsedNameSet(guildId, tierKey);
  const candidates = TIER_NAME_POOLS[tierKey];

  for (const candidate of candidates) {
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }

  // Fallback when the base array is exhausted:
  // keep extending the last base name with incrementing numbers.
  const fallbackBase = candidates[candidates.length - 1];
  let suffix = 2;
  while (usedNames.has(`${fallbackBase} ${suffix}`)) {
    suffix += 1;
  }

  const generatedName = `${fallbackBase} ${suffix}`;
  usedNames.add(generatedName);
  return generatedName;
}

function releaseName(guildId, tierKey, name) {
  const usedNames = getUsedNameSet(guildId, tierKey);
  usedNames.delete(name);
}

function getTierKey(memberCount) {
  if (memberCount <= 2) return "duo";
  if (memberCount === 3) return "trio";
  if (memberCount === 4) return "squad";
  if (memberCount === 5) return "penta";
  return "raid";
}

function getDesiredLimit(memberCount) {
  if (memberCount <= 2) return 3;
  if (memberCount === 3) return 4;
  if (memberCount === 4) return 5;
  if (memberCount === 5) return 6;
  return Math.min(memberCount + 1, 99);
}

function trackTempChannel(channelId, data) {
  tempChannels.set(channelId, {
    guildId: data.guildId,
    tierKey: data.tierKey,
    name: data.name,
    spawnLocked: data.spawnLocked ?? false,
    timer: null,
    updating: false,
    reschedule: false,
  });
}

function untrackTempChannel(channelId) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  if (state.timer) {
    clearTimeout(state.timer);
  }

  tempChannels.delete(channelId);
}

function queueChannelRefresh(channelId) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    void refreshTempChannel(channelId).catch((error) => {
      console.error(`Failed to refresh temp channel ${channelId}:`, error);
    });
  }, DEBOUNCE_MS);
}

async function deleteTrackedChannel(channelId, reason) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  const guild = client.guilds.cache.get(state.guildId);
  const channel = guild?.channels.cache.get(channelId);

  if (!channel) {
    releaseName(state.guildId, state.tierKey, state.name);
    untrackTempChannel(channelId);
    return;
  }

  await channel.delete(reason);
  releaseName(state.guildId, state.tierKey, state.name);
  untrackTempChannel(channelId);
}

async function refreshTempChannel(channelId) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  if (state.updating) {
    state.reschedule = true;
    return;
  }

  state.updating = true;

  try {
    const guild = client.guilds.cache.get(state.guildId);
    const channel = guild?.channels.cache.get(channelId);

    if (!channel) {
      // If the channel was removed manually, free the name and forget it.
      releaseName(state.guildId, state.tierKey, state.name);
      untrackTempChannel(channelId);
      return;
    }

    const memberCount = channel.members.size;

    if (memberCount === 0) {
      // Empty channels are deleted immediately, and their names go back into the pool.
      await deleteTrackedChannel(channelId, "Temporary voice channel became empty");
      return;
    }

    // The channel is created with a 4-slot Squad starter state.
    // Keep that first visual style while the channel is still solo.
    if (state.spawnLocked && memberCount === 1) {
      if (channel.userLimit !== 4) {
        await channel.edit(
          {
            userLimit: 4,
          },
          { reason: "Keep freshly created temp channel at its Squad starter limit" }
        );
      }

      return;
    }

    if (state.spawnLocked && memberCount > 1) {
      state.spawnLocked = false;
    }

    const desiredTier = getTierKey(memberCount);
    const desiredLimit = getDesiredLimit(memberCount);

    let desiredName = state.name;
    let tierChanged = desiredTier !== state.tierKey;
    let reservedNewName = null;

    if (tierChanged) {
      reservedNewName = reserveName(state.guildId, desiredTier);
      desiredName = reservedNewName;
    }

    const payload = {};

    if (channel.name !== desiredName) {
      payload.name = desiredName;
    }

    if (channel.userLimit !== desiredLimit) {
      payload.userLimit = desiredLimit;
    }

    if (Object.keys(payload).length > 0) {
      try {
        await channel.edit(payload, {
          reason: `Sync temporary voice channel to ${memberCount} member(s)`,
        });
      } catch (error) {
        if (tierChanged && reservedNewName) {
          releaseName(state.guildId, desiredTier, reservedNewName);
        }

        throw error;
      }
    }

    if (tierChanged) {
      releaseName(state.guildId, state.tierKey, state.name);
      state.tierKey = desiredTier;
      state.name = desiredName;
    }
  } finally {
    state.updating = false;

    if (state.reschedule) {
      state.reschedule = false;
      queueChannelRefresh(channelId);
    }
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // Hub trigger: join the hub, get a fresh temporary channel under the same category,
    // start it at 4 users, and move the user into the new channel.
    if (newChannelId === HUB_CHANNEL_ID && oldChannelId !== HUB_CHANNEL_ID) {
      const hubChannel = newState.channel;
      if (!hubChannel) return;

      const initialName = reserveName(guild.id, "squad");
      let tempChannel = null;

      try {
        tempChannel = await guild.channels.create({
          name: initialName,
          type: ChannelType.GuildVoice,
          parent: hubChannel.parentId ?? null,
          userLimit: 4,
          reason: "Create temporary voice channel from hub",
        });

        trackTempChannel(tempChannel.id, {
          guildId: guild.id,
          tierKey: "squad",
          name: initialName,
          spawnLocked: true,
        });

        await newState.setChannel(tempChannel);
      } catch (error) {
        if (tempChannel) {
          try {
            await tempChannel.delete("Failed to move user into temporary voice channel");
            releaseName(guild.id, "squad", initialName);
            untrackTempChannel(tempChannel.id);
          } catch (deleteError) {
            console.error("Failed to clean up temp channel after move failure:", deleteError);
          }
        } else {
          releaseName(guild.id, "squad", initialName);
        }

        throw error;
      }
    }

    // Any time a tracked temp channel changes membership, debounce its update.
    if (oldChannelId && tempChannels.has(oldChannelId)) {
      const oldChannel = guild.channels.cache.get(oldChannelId);
      if (oldChannel && oldChannel.members.size === 0) {
        await deleteTrackedChannel(oldChannelId, "Temporary voice channel emptied");
      } else {
        queueChannelRefresh(oldChannelId);
      }
    }

    if (newChannelId && newChannelId !== oldChannelId && tempChannels.has(newChannelId)) {
      queueChannelRefresh(newChannelId);
    }
  } catch (error) {
    console.error("voiceStateUpdate handler error:", error);
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

if (!BOT_TOKEN || BOT_TOKEN === "YOUR_BOT_TOKEN_HERE") {
  throw new Error("Missing BOT_TOKEN. Set it in your environment or .env file.");
}

if (!HUB_CHANNEL_ID || HUB_CHANNEL_ID === "PUT_HUB_CHANNEL_ID_HERE") {
  throw new Error("Missing HUB_CHANNEL_ID. Set it in your environment or .env file.");
}

client.login(BOT_TOKEN);
