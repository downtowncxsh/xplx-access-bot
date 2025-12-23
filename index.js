require("dotenv").config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, MessageFlags } = require("discord.js");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("XPLX Access Bot is running ✅");
});

app.listen(PORT, () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
});

const { getPaidLineItemsByEmail } = require("./shopify");
const logger = require("./logger");
const fs = require("fs");
const path = require("path");

/* =======================
   CONFIG
======================= */
const VERIFY_CHANNEL_NAME = "🔐│verify-access";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";
const MASK_EMAILS = process.env.MASK_EMAILS === "true";
const LOG_DEBUG = process.env.LOG_DEBUG === "true";

/* =======================
   EMAIL ↔ DISCORD STORAGE
======================= */
const DATA_DIR = path.join(__dirname, "data");
const EMAIL_MAP_PATH = path.join(DATA_DIR, "email-map.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadEmailMap() {
  ensureDataDir();
  if (!fs.existsSync(EMAIL_MAP_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(EMAIL_MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveEmailMap(map) {
  ensureDataDir();
  fs.writeFileSync(EMAIL_MAP_PATH, JSON.stringify(map, null, 2));
}

function normEmail(email) {
  return (email || "").trim().toLowerCase();
}

/* =======================
   TIERS (HIGH → LOW)
======================= */
const TIERS = [
  { product: "ELITE TRADER MENTORSHIP", role: "Elite Member" },
  { product: "MARKET EXECUTION PROGRAM", role: "Execution Member" },
  { product: "MARKET FOUNDATION PROGRAM", role: "Foundation Member" },
  { product: "VIP ACCESS", role: "VIP" },
  { product: "FREE DISCORD ACCESS", role: "Members" },
];

const BASE_ROLE_NAME = "Members";
const ALL_ROLE_NAMES = TIERS.map((t) => t.role);

function normalize(s) {
  return (s || "").trim().toLowerCase();
}

function pickHighestTier(titles) {
  const normTitles = titles.map(normalize);
  for (const t of TIERS) {
    if (normTitles.some((x) => x.includes(normalize(t.product)))) return t;
  }
  return null;
}

/* =======================
   UI (CONSISTENT MESSAGES)
======================= */
function ui(title, lines = []) {
  const body = lines.filter(Boolean).join("\n");
  return `**${title}**\n${body}`;
}
const bullet = (t) => `• ${t}`;
const ok = (t) => `✅ ${t}`;
const warn = (t) => `⚠️ ${t}`;
const bad = (t) => `❌ ${t}`;
const hint = (t) => `> 💡 ${t}`;
const fmtEmail = (e) => `\`${e}\``;
const fmtRole = (r) => `**${r}**`;

/* =======================
   PERMISSIONS
======================= */
function isAdmin(interaction) {
  return interaction.memberPermissions?.has("Administrator");
}

/* =======================
   ROLE HANDLER
======================= */
async function setExclusiveTierRole(member, guild, roleName) {
  const rolesByName = new Map(guild.roles.cache.map((r) => [r.name, r]));
  const base = rolesByName.get(BASE_ROLE_NAME);
  const target = rolesByName.get(roleName);

  if (!base) throw new Error(`Base role not found: ${BASE_ROLE_NAME}`);
  if (!target) throw new Error(`Target role not found: ${roleName}`);

  // Always keep Members
  await member.roles.add(base);

  // Add target tier role
  await member.roles.add(target);

  // Remove other tiers (not Members, not target)
  const toRemove = ALL_ROLE_NAMES
    .filter((n) => n !== BASE_ROLE_NAME && n !== roleName)
    .map((n) => rolesByName.get(n))
    .filter(Boolean);

  if (toRemove.length) await member.roles.remove(toRemove);
}

/* =======================
   LOGS (CLEAN EMBEDS)
======================= */
function maskEmail(email) {
  if (!email || !email.includes("@")) return email || "";
  const [u, d] = email.split("@");
  const safeU = u.length <= 2 ? `${u[0]}*` : `${u.slice(0, 2)}***`;
  const d0 = (d || "").split(".")[0] || "";
  const safeD = d0 ? `${d0.slice(0, 2)}***` : "***";
  const tld = (d || "").split(".").slice(1).join(".");
  return `${safeU}@${safeD}${tld ? "." + tld : ""}`;
}

function levelColor(level) {
  switch ((level || "").toUpperCase()) {
    case "SUCCESS":
      return 0x57F287;
    case "WARN":
      return 0xFEE75C;
    case "ERROR":
      return 0xED4245;
    default:
      return 0x5865F2;
  }
}

function prettyItems(items = []) {
  return items.slice(0, 3).map((i) => {
    const sub = i.isSubscription ? `✅ Sub (${i.sellingPlanName || "plan"})` : "💳 One-time";
    return `• ${i.title} — ${sub}`;
  }).join("\n");
}

async function postBotLog(client, event, payload = {}, level = "INFO") {
  if (!LOG_CHANNEL_ID) return;

  const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const safePayload = { ...payload };
  if (MASK_EMAILS && safePayload.email) safePayload.email = maskEmail(safePayload.email);

  const fields = [];
  if (safePayload.email) fields.push({ name: "Email", value: `\`${safePayload.email}\``, inline: true });
  if (safePayload.userTag || safePayload.userId) {
    fields.push({
      name: "User",
      value: `${safePayload.userTag || "unknown"}\n\`${safePayload.userId || "unknown"}\``,
      inline: true,
    });
  }
  if (safePayload.grantedRole) fields.push({ name: "Granted", value: `**${safePayload.grantedRole}**`, inline: true });
  if (safePayload.matchedRole) fields.push({ name: "Matched", value: `**${safePayload.matchedRole}**`, inline: true });
  if (typeof safePayload.subscription === "boolean") {
    fields.push({ name: "Subscription", value: safePayload.subscription ? "✅ Yes" : "❌ No", inline: true });
  }
  if (typeof safePayload.count === "number") fields.push({ name: "Count", value: `\`${safePayload.count}\``, inline: true });

  let summary = "";
  if (Array.isArray(safePayload.items) && safePayload.items.length) {
    summary = prettyItems(safePayload.items);
    if (safePayload.items.length > 3) summary += `\n… +${safePayload.items.length - 3} more`;
  } else if (Array.isArray(safePayload.titles) && safePayload.titles.length) {
    const shown = safePayload.titles.slice(0, 5).map((t) => `\`${t}\``).join(", ");
    summary = shown + (safePayload.titles.length > 5 ? `, … +${safePayload.titles.length - 5} more` : "");
  } else if (safePayload.error) {
    summary = `❌ ${safePayload.error}`;
  } else if (safePayload.message) {
    summary = safePayload.message;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${(level || "INFO").toUpperCase()} • ${event}`)
    .setColor(levelColor(level))
    .setTimestamp(new Date());

  if (fields.length) embed.addFields(fields);
  if (summary) embed.setDescription(summary);

  if (LOG_DEBUG) {
    const raw = JSON.stringify(payload, null, 2);
    embed.addFields({
      name: "Debug (raw)",
      value: "```json\n" + (raw.length > 900 ? raw.slice(0, 900) + "\n…truncated" : raw) + "\n```",
      inline: false,
    });
  }

  await channel.send({ embeds: [embed] }).catch(() => {});
}

/* =======================
   DISCORD CLIENT
======================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await postBotLog(client, "bot_online", { userTag: c.user.tag, userId: c.user.id }, "INFO");
});

/* =======================
   COMMAND HANDLER
======================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  if (cmd !== "verify" && cmd !== "lookup" && cmd !== "status") return;

  // Admin commands: logs channel only + admins only
  if (cmd === "lookup" || cmd === "status") {
    if (LOG_CHANNEL_ID && interaction.channelId !== LOG_CHANNEL_ID) {
      return interaction.reply({
        content: ui("Restricted command", [
          bad("Use this command in the bot logs channel only."),
        ]),
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!isAdmin(interaction)) {
      return interaction.reply({
        content: ui("Restricted command", [
          bad("Admin only."),
        ]),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  /* =====================
     /lookup (ADMIN)
  ===================== */
  if (cmd === "lookup") {
    const email = normEmail(interaction.options.getString("email"));
    const map = loadEmailMap();
    const entry = map[email];

    await postBotLog(client, "admin_lookup", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      found: Boolean(entry),
    }, "INFO");

    if (!entry) {
      return interaction.reply({
        content: ui("Lookup result", [
          warn(`No record found for ${fmtEmail(email)}.`),
          hint("That email may not have verified yet."),
        ]),
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: ui("Lookup result", [
        ok("Record found."),
        bullet(`Email: ${fmtEmail(email)}`),
        bullet(`Discord User ID: \`${entry.discordUserId}\``),
        bullet(`User Tag: **${entry.userTag || "unknown"}**`),
        bullet(`Tier: ${fmtRole(entry.tier || "unknown")}`),
        bullet(`Updated: \`${entry.updatedAt || "unknown"}\``),
      ]),
      flags: MessageFlags.Ephemeral,
    });
  }

  /* =====================
     /status (ADMIN)
  ===================== */
  if (cmd === "status") {
    const statusEmail = normEmail(interaction.options.getString("email"));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const items = await getPaidLineItemsByEmail(statusEmail);
      const titles = items.map((i) => i.title);
      const tier = pickHighestTier(titles);

      await postBotLog(client, "admin_status", {
        email: statusEmail,
        userTag: interaction.user.tag,
        userId: interaction.user.id,
        items,
        titles,
        matchedRole: tier?.role ?? null,
        subscription: items.some((x) => x.isSubscription),
        count: items.length,
      }, "INFO");

      return interaction.editReply(
        ui("Shopify status", [
          bullet(`Email: ${fmtEmail(statusEmail)}`),
          bullet(`Items: \`${items.length}\``),
          bullet(`Matched Tier: ${fmtRole(tier?.role ?? "none")}`),
          bullet(`Subscription: ${items.some((x) => x.isSubscription) ? "✅ yes" : "❌ no"}`),
          hint("If tier is wrong, update the TIERS mapping in index.js."),
        ])
      );
    } catch (err) {
      await postBotLog(client, "admin_status_error", {
        email: statusEmail,
        userTag: interaction.user.tag,
        userId: interaction.user.id,
        error: err?.message || String(err),
      }, "ERROR");

      return interaction.editReply(
        ui("Shopify status failed", [
          bad("Shopify lookup failed."),
          hint("Try again in 30 seconds."),
        ])
      );
    }
  }

  /* =====================
     /verify (EVERYONE)
  ===================== */
  const email = normEmail(interaction.options.getString("email"));
  const emailMap = loadEmailMap();

  logger.info({
    event: "verify_requested",
    email,
    userTag: interaction.user.tag,
    userId: interaction.user.id,
    guildId: interaction.guild?.id,
    at: new Date().toISOString(),
  });

  await postBotLog(client, "verify_requested", {
    email,
    userTag: interaction.user.tag,
    userId: interaction.user.id,
    guildId: interaction.guild?.id,
  }, "INFO");

  // Invalid email
  if (!email || !email.includes("@")) {
    await postBotLog(client, "verify_invalid_email", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
    }, "WARN");

    return interaction.reply({
      content: ui("Email not valid", [
        bad("That doesn’t look like a real email."),
        hint("Use the exact email you used at Shopify checkout."),
      ]),
      flags: MessageFlags.Ephemeral,
    });
  }

  // Email already linked to someone else (allow same user re-verify)
  if (emailMap[email] && emailMap[email].discordUserId !== interaction.user.id) {
    await postBotLog(client, "verify_email_already_linked", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      existingUserId: emailMap[email].discordUserId,
    }, "WARN");

    return interaction.reply({
      content: ui("Email already linked", [
        bad("That email is already linked to another Discord account."),
        bullet("If this is your email, open a support ticket."),
        hint("We can unlink it after confirming ownership."),
      ]),
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: ui("Checking your purchase…", [
      bullet("Searching Shopify for a **paid** order"),
      hint("This usually takes a few seconds."),
    ]),
    flags: MessageFlags.Ephemeral,
  });

  try {
    const items = await getPaidLineItemsByEmail(email);
    const titles = items.map((i) => i.title);

    await postBotLog(client, "shopify_line_items", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      items,
      subscription: items.some((x) => x.isSubscription),
      count: items.length,
    }, "INFO");

    if (!titles.length) {
      await postBotLog(client, "verify_no_paid_orders", {
        email,
        userTag: interaction.user.tag,
        userId: interaction.user.id,
      }, "WARN");

      return interaction.editReply(
        ui("No paid order found", [
          bad("I couldn’t find a **paid** order for that email."),
          bullet("Make sure you used the same checkout email."),
          bullet("If you paid recently, wait 1–2 minutes then try again."),
        ])
      );
    }

    const tier = pickHighestTier(titles);

    await postBotLog(client, "tier_matched", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      matchedRole: tier?.role ?? null,
    }, "INFO");

    if (!tier) {
      await postBotLog(client, "verify_paid_but_no_tier_match", {
        email,
        userTag: interaction.user.tag,
        userId: interaction.user.id,
        titles,
      }, "WARN");

      return interaction.editReply(
        ui("Paid order found, but tier mismatch", [
          warn("I found a paid order, but couldn’t match it to a tier."),
          bullet("This usually means the Shopify product title doesn’t match the bot mapping."),
          hint("Admin can check `/status` in the logs channel."),
        ])
      );
    }

    await setExclusiveTierRole(interaction.member, interaction.guild, tier.role);

    // Save email ↔ user after success
    emailMap[email] = {
      discordUserId: interaction.user.id,
      userTag: interaction.user.tag,
      tier: tier.role,
      updatedAt: new Date().toISOString(),
    };
    saveEmailMap(emailMap);

    logger.info({
      event: "verify_success",
      email,
      tier: tier.role,
      userId: interaction.user.id,
      guildId: interaction.guild?.id,
      at: new Date().toISOString(),
    });

    await postBotLog(client, "verify_success", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      grantedRole: tier.role,
    }, "SUCCESS");

    return interaction.editReply(
      ui("Verification complete", [
        ok(`Access granted: ${fmtRole(tier.role)}`),
        bullet("If you upgraded, your lower tier role was removed automatically."),
        hint("You can now access your channels."),
      ])
    );
  } catch (err) {
    console.error("VERIFY_ERROR:", err);

    logger.error({
      event: "verify_error",
      email,
      error: err?.message || String(err),
      userId: interaction.user.id,
      guildId: interaction.guild?.id,
      at: new Date().toISOString(),
    });

    await postBotLog(client, "verify_error", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      error: err?.message || String(err),
    }, "ERROR");

    return interaction.editReply(
      ui("Verification failed", [
        warn("Something went wrong on our side."),
        bullet("Please try again in 60 seconds."),
        hint("If it keeps failing, contact support."),
      ])
    );
  }
});

/* =======================
   VERIFY CHANNEL CLEANUP
======================= */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== VERIFY_CHANNEL_NAME) return;
  await message.delete().catch(() => {});
});

client.login(process.env.DISCORD_TOKEN);

