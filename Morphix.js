require("dotenv").config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  StringSelectMenuBuilder,
} = require("discord.js");

/*
  Install:
    npm i discord.js dotenv

  Configure:
    BOT_TOKEN=your_bot_token_here

  Run:
    node Morphix.js
*/

const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const DEBOUNCE_MS = 2500;

const TIER_CONFIG = {
  duo: { display: "duo", baseLimit: 2 },
  trio: { display: "trio", baseLimit: 3 },
  squad: { display: "squad", baseLimit: 4 },
  penta: { display: "penta", baseLimit: 5 },
  hexa: { display: "hexa", baseLimit: 6 },
  raid: { display: "raid", baseLimit: 15 },
};

const TIER_NAME_POOLS = {
  duo: ["Duo 1", "Duo 2", "Duo 3", "Duo 4", "Duo 5"],
  trio: ["Trio I", "Trio II", "Trio III", "Trio IV", "Trio V"],
  squad: ["Squad A", "Squad B", "Squad C", "Squad D", "Squad E"],
  penta: ["Penta Alpha", "Penta Beta", "Penta Gamma", "Penta Delta", "Penta Omega"],
  hexa: ["Hexa One", "Hexa Two", "Hexa Three", "Hexa Four", "Hexa Five"],
  raid: ["Raid Mythic", "Raid Immortal", "Raid Apex", "Raid Legend", "Raid Titan"],
};

const AUTO_SETUP_TRIGGER_CATEGORY_NAME = "Create VC";
const AUTO_SETUP_TEMP_CATEGORY_NAME = "Heavy Dens";
const AUTO_SETUP_TRIGGER_CHANNELS = ["duo", "trio", "squad", "penta", "hexa", "raid"];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const tempChannels = new Map();
const activeTempChannels = tempChannels;
const guildNamePools = new Map();

function ensureGuildPools(guildId) {
  if (!guildNamePools.has(guildId)) {
    guildNamePools.set(guildId, {
      duo: new Set(),
      trio: new Set(),
      squad: new Set(),
      penta: new Set(),
      hexa: new Set(),
      raid: new Set(),
    });
  }

  return guildNamePools.get(guildId);
}

function getUsedNameSet(guildId, tierKey) {
  return ensureGuildPools(guildId)[tierKey];
}

function getTierDisplayName(tierKey) {
  return TIER_CONFIG[tierKey]?.display ?? tierKey;
}

function getBaseLimit(tierKey) {
  return TIER_CONFIG[tierKey]?.baseLimit ?? 4;
}

function resolveTriggerTier(channel) {
  if (!channel?.name) return null;

  const normalized = String(channel.name).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIER_CONFIG, normalized) ? normalized : null;
}

function reserveName(guildId, tierKey) {
  const usedNames = getUsedNameSet(guildId, tierKey);
  const candidates = TIER_NAME_POOLS[tierKey] ?? [];

  for (const candidate of candidates) {
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }

  const fallbackBase = candidates[candidates.length - 1] ?? getTierDisplayName(tierKey);
  let suffix = 2;
  let candidate = `${fallbackBase} ${suffix}`;

  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${fallbackBase} ${suffix}`;
  }

  usedNames.add(candidate);
  return candidate;
}

function releaseName(guildId, tierKey, name) {
  getUsedNameSet(guildId, tierKey).delete(name);
}

function findGuildCategoryByName(guild, categoryName) {
  return (
    guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildCategory && channel.name.trim().toLowerCase() === categoryName.trim().toLowerCase()
    ) ?? null
  );
}

function trackTempChannel(channelId, data) {
  tempChannels.set(channelId, {
    guildId: data.guildId,
    tierKey: data.tierKey,
    name: data.name,
    ownerId: data.ownerId ?? null,
    baseLimit: data.baseLimit ?? 4,
    blockedMemberIds: new Set(),
    timer: null,
    updating: false,
    reschedule: false,
  });
}

async function blockMemberInChannel(voiceChannel, targetMember, reason) {
  await voiceChannel.permissionOverwrites.edit(
    targetMember.id,
    {
      ViewChannel: false,
      Connect: false,
    },
    { reason }
  );
}

async function unblockMemberInChannel(voiceChannel, targetMember, reason) {
  await voiceChannel.permissionOverwrites.delete(targetMember.id, reason);
}

function untrackTempChannel(channelId) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  if (state.timer) clearTimeout(state.timer);
  tempChannels.delete(channelId);
}

function queueChannelRefresh(channelId) {
  const state = tempChannels.get(channelId);
  if (!state) return;

  if (state.timer) clearTimeout(state.timer);

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
      releaseName(state.guildId, state.tierKey, state.name);
      untrackTempChannel(channelId);
      return;
    }

    const memberCount = channel.members.size;

    if (memberCount === 0) {
      await deleteTrackedChannel(channelId, "Temporary voice channel became empty");
      return;
    }

    const desiredLimit = Math.min(99, Math.max(state.baseLimit, memberCount + 1));

    if (channel.userLimit !== desiredLimit) {
      await channel.edit(
        { userLimit: desiredLimit },
        { reason: `Sync temporary voice channel to ${memberCount} member(s)` }
      );
    }
  } finally {
    state.updating = false;

    if (state.reschedule) {
      state.reschedule = false;
      queueChannelRefresh(channelId);
    }
  }
}

async function ensureMorphixServerSetup(guild) {
  const triggerCategory =
    findGuildCategoryByName(guild, AUTO_SETUP_TRIGGER_CATEGORY_NAME) ??
    (await guild.channels.create({
      name: AUTO_SETUP_TRIGGER_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Morphix automatic server setup for trigger channels",
    }));

  const tempCategory =
    findGuildCategoryByName(guild, AUTO_SETUP_TEMP_CATEGORY_NAME) ??
    (await guild.channels.create({
      name: AUTO_SETUP_TEMP_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      reason: "Morphix automatic server setup for temp voice channels",
    }));

  for (const tierName of AUTO_SETUP_TRIGGER_CHANNELS) {
    const existingTrigger = guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildVoice &&
        channel.parentId === triggerCategory.id &&
        String(channel.name).trim().toLowerCase() === tierName
    );

    if (!existingTrigger) {
      await guild.channels.create({
        name: tierName,
        type: ChannelType.GuildVoice,
        parent: triggerCategory.id,
        reason: `Morphix automatic setup for ${tierName}`,
      });
    }
  }

  return { triggerCategory, tempCategory };
}

function buildMemberSelectRows(voiceChannel, ownerId, customIdPrefix, placeholderPrefix) {
  const targets = [...voiceChannel.members.values()].filter((voiceMember) => voiceMember.id !== ownerId);

  if (targets.length === 0) {
    return [];
  }

  const rows = [];
  const chunks = [];

  for (let index = 0; index < targets.length; index += 25) {
    chunks.push(targets.slice(index, index + 25));
  }

  for (let index = 0; index < Math.min(chunks.length, 5); index += 1) {
    const chunk = chunks[index];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${customIdPrefix}:${voiceChannel.id}:${index}`)
      .setPlaceholder(`${placeholderPrefix} (${index + 1}/${chunks.length})`)
      .addOptions(
        chunk.map((voiceMember) => ({
          label: voiceMember.displayName.slice(0, 100),
          value: voiceMember.id,
          description: voiceMember.user.tag.slice(0, 100),
        }))
      );

    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  return rows;
}

async function buildBlockedMemberSelectRows(guild, voiceChannel, channelState, customIdPrefix, placeholderPrefix) {
  const blockedIds = [...channelState.blockedMemberIds];

  if (blockedIds.length === 0) {
    return [];
  }

  const blockedMembers = [];

  for (const memberId of blockedIds) {
    const cachedMember =
      guild.members.cache.get(memberId) ?? (await guild.members.fetch(memberId).catch(() => null));

    if (cachedMember && cachedMember.id !== channelState.ownerId) {
      blockedMembers.push(cachedMember);
    }
  }

  if (blockedMembers.length === 0) {
    return [];
  }

  const rows = [];
  const chunks = [];

  for (let index = 0; index < blockedMembers.length; index += 25) {
    chunks.push(blockedMembers.slice(index, index + 25));
  }

  for (let index = 0; index < Math.min(chunks.length, 5); index += 1) {
    const chunk = chunks[index];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${customIdPrefix}:${voiceChannel.id}:${index}`)
      .setPlaceholder(`${placeholderPrefix} (${index + 1}/${chunks.length})`)
      .addOptions(
        chunk.map((voiceMember) => ({
          label: voiceMember.displayName.slice(0, 100),
          value: voiceMember.id,
          description: voiceMember.user.tag.slice(0, 100),
        }))
      );

    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  return rows;
}

async function sendControlPanel(target) {
  const embed = new EmbedBuilder()
    .setTitle("🎛️ Morphix Control Center")
    .setDescription(
      [
        "Use these controls to manage the active temporary voice channel.",
        "",
        "• **Block Member** - Hide this room from a specific user",
        "• **Unblock Member** - Make the room visible again",
        "• **Kick Member** - Disconnect a selected user",
      ].join("\n")
    )
    .setColor(0x2b2d31);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("block_member")
      .setLabel("Block Member")
      .setEmoji("⛔")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("unblock_member")
      .setLabel("Unblock Member")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("kick_member")
      .setLabel("Kick Member")
      .setEmoji("🚫")
      .setStyle(ButtonStyle.Danger)
  );

  const payload = {
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  };

  if (typeof target.reply === "function") {
    return target.reply(payload);
  }

  return target.send({
    embeds: [embed],
    components: [row],
  });
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);

  void (async () => {
    try {
      const panelCommand = {
        name: "panel",
        description: "Post the Morphix control panel in this channel.",
      };

      for (const guild of client.guilds.cache.values()) {
        await guild.commands.set([panelCommand]);
        await ensureMorphixServerSetup(guild);
      }

      console.log("Morphix slash command registered in connected guilds.");
    } catch (error) {
      console.error("Failed to register Morphix slash command:", error);
    }
  })();
});

client.on("guildCreate", async (guild) => {
  try {
    await guild.commands.set([
      {
        name: "panel",
        description: "Post the Morphix control panel in this channel.",
      },
    ]);

    await ensureMorphixServerSetup(guild);
  } catch (error) {
    console.error(`Failed to register Morphix command in guild ${guild.id}:`, error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "panel") return;

      if (!interaction.inGuild() || !interaction.channel?.isTextBased()) {
        await interaction.reply({
          content: "This command must be used in a server text channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const ownerVoiceChannel = interaction.member?.voice?.channel;
      const ownerTempState = ownerVoiceChannel ? activeTempChannels.get(ownerVoiceChannel.id) : null;

      if (!ownerVoiceChannel || !ownerTempState || ownerTempState.ownerId !== interaction.user.id) {
        await interaction.reply({
          content: "🔒 Only the owner of an active Morphix voice room can use /panel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await sendControlPanel(interaction);
      return;
    }

    if (interaction.isButton()) {
      const member = interaction.member;
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content: "🔒 Only the Owner/Creator of this voice channel can use these controls!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const channelState = activeTempChannels.get(voiceChannel.id);

      if (!channelState || channelState.ownerId !== interaction.user.id) {
        await interaction.reply({
          content: "🔒 Only the Owner/Creator of this voice channel can use these controls!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId === "kick_member") {
        const rows = buildMemberSelectRows(
          voiceChannel,
          channelState.ownerId,
          "kick_member_select",
          "Select a member to disconnect"
        );

        if (rows.length === 0) {
          await interaction.reply({
            content: "There are no members to kick from this voice channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: "Choose a member to kick from the channel:",
          components: rows,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId === "block_member") {
        const rows = buildMemberSelectRows(
          voiceChannel,
          channelState.ownerId,
          "block_member_select",
          "Select a member to block"
        );

        if (rows.length === 0) {
          await interaction.reply({
            content: "There are no members to block in this voice channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: "Choose a member to block from joining this room:",
          components: rows,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId === "unblock_member") {
        const rows = await buildBlockedMemberSelectRows(
          interaction.guild,
          voiceChannel,
          channelState,
          "unblock_member_select",
          "Select a member to unblock"
        );

        if (rows.length === 0) {
          await interaction.reply({
            content: "There are no blocked members in this voice channel.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: "Choose a blocked member to restore access:",
          components: rows,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const isKickSelect = interaction.customId.startsWith("kick_member_select:");
      const isBlockSelect = interaction.customId.startsWith("block_member_select:");
      const isUnblockSelect = interaction.customId.startsWith("unblock_member_select:");

      if (!isKickSelect && !isBlockSelect && !isUnblockSelect) return;

      const [_, voiceChannelId] = interaction.customId.split(":");
      const member = interaction.member;
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel || voiceChannel.id !== voiceChannelId) {
        await interaction.reply({
          content: "🔒 Only the Owner/Creator of this voice channel can use these controls!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const channelState = activeTempChannels.get(voiceChannel.id);

      if (!channelState || channelState.ownerId !== interaction.user.id) {
        await interaction.reply({
          content: "🔒 Only the Owner/Creator of this voice channel can use these controls!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const targetMemberId = interaction.values[0];
      const targetMember = voiceChannel.members.get(targetMemberId) ?? interaction.guild.members.cache.get(targetMemberId);

      if (!targetMember || targetMember.id === channelState.ownerId) {
        await interaction.update({
          content: "That member is no longer available.",
          components: [],
        });
        return;
      }

      if (isKickSelect) {
        if (targetMember.voice?.channelId === voiceChannel.id) {
          await targetMember.voice.disconnect();
        }

        await interaction.update({
          content: `✅ Disconnected <@${targetMember.id}> from the voice channel.`,
          components: [],
        });
        return;
      }

      if (isBlockSelect) {
        try {
          await blockMemberInChannel(
            voiceChannel,
            targetMember,
            `Morphix blocked member by ${interaction.user.tag}`
          );
        } catch (blockError) {
          console.error("Failed to apply block overwrite:", blockError);
        }

        channelState.blockedMemberIds.add(targetMember.id);

        if (targetMember.voice?.channelId === voiceChannel.id) {
          await targetMember.voice.disconnect();
        }

        await interaction.update({
          content: `⛔ Blocked <@${targetMember.id}> from joining this room.`,
          components: [],
        });
        return;
      }

      if (isUnblockSelect) {
        try {
          await unblockMemberInChannel(
            voiceChannel,
            targetMember,
            `Morphix unblocked member by ${interaction.user.tag}`
          );
        } catch (unblockError) {
          console.error("Failed to remove block overwrite:", unblockError);
        }

        channelState.blockedMemberIds.delete(targetMember.id);

        await interaction.update({
          content: `✅ Unblocked <@${targetMember.id}>. They can see and join this room again.`,
          components: [],
        });
      }
    }
  } catch (error) {
    console.error("interactionCreate handler error:", error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "Something went wrong while handling that control.",
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        console.error("Failed to send interaction error reply:", replyError);
      }
    }
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;
    const joinedTier = resolveTriggerTier(newState.channel);

    if (newChannelId && tempChannels.has(newChannelId)) {
      const channelState = tempChannels.get(newChannelId);
      if (channelState?.blockedMemberIds?.has(newState.id) && channelState.ownerId !== newState.id) {
        await newState.setChannel(null, "Blocked from joining this temporary voice channel");
        return;
      }
    }

    if (joinedTier && oldChannelId !== newChannelId) {
      const triggerChannel = newState.channel;
      if (!triggerChannel) return;

      const guildCategories = await ensureMorphixServerSetup(guild);
      const tempCategory = guildCategories.tempCategory;
      const initialName = reserveName(guild.id, joinedTier);
      let tempChannel = null;

      try {
        tempChannel = await guild.channels.create({
          name: initialName,
          type: ChannelType.GuildVoice,
          parent: tempCategory.id,
          userLimit: getBaseLimit(joinedTier),
          reason: `Create temporary ${joinedTier} voice channel`,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
            },
            {
              id: newState.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.Connect,
                PermissionsBitField.Flags.Speak,
                PermissionsBitField.Flags.Stream,
                PermissionsBitField.Flags.UseVAD,
              ],
            },
          ],
        });

        trackTempChannel(tempChannel.id, {
          guildId: guild.id,
          tierKey: joinedTier,
          name: initialName,
          ownerId: newState.id,
          baseLimit: getBaseLimit(joinedTier),
        });

        await newState.setChannel(tempChannel);
      } catch (error) {
        if (tempChannel) {
          try {
            await tempChannel.delete("Failed to move user into temporary voice channel");
            releaseName(guild.id, joinedTier, initialName);
            untrackTempChannel(tempChannel.id);
          } catch (deleteError) {
            console.error("Failed to clean up temp channel after move failure:", deleteError);
          }
        } else {
          releaseName(guild.id, joinedTier, initialName);
        }

        throw error;
      }
    }

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

client.login(BOT_TOKEN);
