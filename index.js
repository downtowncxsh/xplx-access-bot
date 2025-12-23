require("dotenv").config();
const { Client, GatewayIntentBits, Events, EmbedBuilder, MessageFlags } = require("discord.js");
const express = require("express");
const fs = require("fs");
const path = require("path");

const logger = require("./logger");

// ✅ IMPORTANT: updated import (see shopify.js patch at bottom)
const { getPaidLineItemsByEmail } = require("./shopify");

const app = express();
const PORT = process.env.PORT || 10000;

/* =======================
   CONFIG
======================= */
const VERIFY_CHANNEL_NAME = "🔐│verify-access";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";
const MASK_EMAILS = process.env.MASK_EMAILS === "true";
const LOG_DEBUG = process.env.LOG_DEBUG === "true";

// ✅ Audit config (Subscription-only enforcement)
const AUDIT_ENABLED = (process.env.AUDIT_ENABLED ?? "true") === "true";
const AUDIT_DRY_RUN = (process.env.AUDIT_DRY_RUN ?? "false") === "true"; // set true first if you want "logs only"
const AUDIT_INTERVAL_HOURS = Number(process.env.AUDIT_INTERVAL_HOURS ?? "24"); // daily by default
const AUDIT_GRACE_DAYS = Number(process.env.AUDIT_GRACE_DAYS ?? "35"); // your Day-35 rule

/* =======================
   EXPRESS (Render health)
======================= */
app.get("/", (req, res) => {
  res.send("XPLX Access Bot is running ✅");
});

app.listen(PORT, () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
});

/* =======================
   EMAIL ↔ DISCORD STORAGE
   (Render + GitHub friendly)
======================= */
// ✅ Recommended on Render with Persistent Disk:
// set EMAIL_MAP_PATH=/var/data/email-map.json
// and mount disk at /var/data
const DEFAULT_EMAIL_MAP_PATH = path.join(__dirname, "data", "email-map.json");
const EMAIL_MAP_PATH = process.env.EMAIL_MAP_PATH || DEFAULT_EMAIL_MAP_PATH;

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadEmailMap() {
  ensureDirForFile(EMAIL_MAP_PATH);
  if (!fs.existsSync(EMAIL_MAP_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(EMAIL_MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveEmailMap(map) {
  ensureDirForFile(EMAIL_MAP_PATH);
  fs.writeFileSync(EMAIL_MAP_PATH, JSON.stringify(map, null, 2));
}

function normEmail(email) {
  return (email || "").trim().toLowerCase();
}

function daysBetween(now, past) {
  return Math.floor((now.getTime() - past.getTime()) / (1000 * 60 * 60 * 24));
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

function isTierTitleMatch(lineItemTitle, tierProductName) {
  return normalize(lineItemTitle).includes(normalize(tierProductName));
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

// ✅ Used by audit to remove access
async function downgradeToMembers(member, guild) {
  const rolesByName = new Map(guild.roles.cache.map((r) => [r.name, r]));
  const base = rolesByName.get(BASE_ROLE_NAME);
  if (!base) throw new Error(`Base role not found: ${BASE_ROLE_NAME}`);

  // keep Members
  await member.roles.add(base);

  // remove all paid tiers except Members
  const toRemove = ALL_ROLE_NAMES
    .filter((n) => n !== BASE_ROLE_NAME)
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
  return items
    .slice(0, 3)
    .map((i) => {
      const sub = i.isSubscription ? `✅ Sub (${i.sellingPlanName || "plan"})` : "💳 One-time";
      const paidAt = i.paidAt ? ` • 🕒 ${i.paidAt}` : "";
      return `• ${i.title} — ${sub}${paidAt}`;
    })
    .join("\n");
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
  if (safePayload.daysSincePaid != null) fields.push({ name: "Days Since Paid", value: `\`${safePayload.daysSincePaid}\``, inline: true });
  if (safePayload.lastPaidAt) fields.push({ name: "Last Paid", value: `\`${safePayload.lastPaidAt}\``, inline: true });
  if (safePayload.dryRun != null) fields.push({ name: "Dry Run", value: safePayload.dryRun ? "✅ Yes" : "❌ No", inline: true });

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

/* =======================
   SUBSCRIPTION AUDIT LOOP
   (Day 35 enforcement)
======================= */
function startSubscriptionAuditLoop() {
  if (!AUDIT_ENABLED) {
    logger.info({ event: "audit_disabled" });
    return;
  }

  const run = () => runSubscriptionAudit().catch((err) => {
    logger.error({ event: "audit_loop_error", err: String(err) });
  });

  // Run 60 seconds after startup, then repeat
  setTimeout(run, 60_000);
  setInterval(run, AUDIT_INTERVAL_HOURS * 60 * 60 * 1000);

  logger.info({
    event: "audit_loop_started",
    intervalHours: AUDIT_INTERVAL_HOURS,
    graceDays: AUDIT_GRACE_DAYS,
    dryRun: AUDIT_DRY_RUN,
  });
}

async function runSubscriptionAudit() {
  const map = loadEmailMap();
  const now = new Date();

  await postBotLog(client, "audit_start", {
    message: `Audit started • grace=${AUDIT_GRACE_DAYS}d • interval=${AUDIT_INTERVAL_HOURS}h • dryRun=${AUDIT_DRY_RUN}`,
  }, "INFO");

  for (const [email, rec] of Object.entries(map)) {
    try {
      // ✅ subscription-only gate
      if (!rec || rec.isSubscription !== true) continue;
      if (!rec.discordUserId) continue;

      // If lastPaidAt is missing, skip (don’t accidentally remove anyone)
      if (!rec.lastPaidAt) {
        await postBotLog(client, "audit_skip_missing_lastPaidAt", {
          email,
          userId: rec.discordUserId,
          userTag: rec.userTag,
          message: "Record missing lastPaidAt; skipping for safety.",
        }, "WARN");
        continue;
      }

      const lastPaidDate = new Date(rec.lastPaidAt);
      if (Number.isNaN(lastPaidDate.getTime())) {
        await postBotLog(client, "audit_skip_invalid_lastPaidAt", {
          email,
          userId: rec.discordUserId,
          userTag: rec.userTag,
          lastPaidAt: rec.lastPaidAt,
          message: "Invalid lastPaidAt format; skipping for safety.",
        }, "WARN");
        continue;
      }

      const daysSincePaid = daysBetween(now, lastPaidDate);

      if (daysSincePaid < AUDIT_GRACE_DAYS) {
        // optional: log only when close to expiry (reduce noise)
        continue;
      }

      // Fetch member live
      const guild = client.guilds.cache.first();
      if (!guild) continue;

      const member = await guild.members.fetch(rec.discordUserId).catch(() => null);
      if (!member) {
        await postBotLog(client, "audit_member_not_found", {
          email,
          userId: rec.discordUserId,
          userTag: rec.userTag,
          daysSincePaid,
          lastPaidAt: rec.lastPaidAt,
        }, "WARN");
        continue;
      }

      await postBotLog(client, "audit_overdue_detected", {
        email,
        userId: rec.discordUserId,
        userTag: rec.userTag,
        daysSincePaid,
        lastPaidAt: rec.lastPaidAt,
        dryRun: AUDIT_DRY_RUN,
      }, "WARN");

      if (AUDIT_DRY_RUN) continue;

      await downgradeToMembers(member, guild);

      // Update record so you can see audit actions
      map[email] = {
        ...rec,
        tier: BASE_ROLE_NAME,
        lastAuditAt: new Date().toISOString(),
        lastAuditReason: `overdue_${daysSincePaid}d`,
        updatedAt: new Date().toISOString(),
      };
      saveEmailMap(map);

      await postBotLog(client, "audit_downgrade_success", {
        email,
        userId: rec.discordUserId,
        userTag: rec.userTag,
        daysSincePaid,
        lastPaidAt: rec.lastPaidAt,
        grantedRole: BASE_ROLE_NAME,
      }, "SUCCESS");

    } catch (err) {
      await postBotLog(client, "audit_error", {
        email,
        userId: rec?.discordUserId,
        userTag: rec?.userTag,
        error: err?.message || String(err),
      }, "ERROR");
    }
  }

  await postBotLog(client, "audit_end", {
    message: "Audit finished ✅",
  }, "INFO");
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await postBotLog(client, "bot_online", { userTag: c.user.tag, userId: c.user.id }, "INFO");

  // ✅ Start audit loop after bot is online
  startSubscriptionAuditLoop();
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
        bullet(`Subscription: ${entry.isSubscription ? "✅ yes" : "❌ no"}`),
        bullet(`Last Paid: \`${entry.lastPaidAt || "unknown"}\``),
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
    // ✅ IMPORTANT: shopify helper now returns items that MAY include paidAt on each item (see patch below)
    const items = await getPaidLineItemsByEmail(email);

    const titles = items.map((i) => i.title);

    const tier = pickHighestTier(titles);

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

    // ✅ Determine subscription ONLY for the matched tier line item
    const matchedIsSubscription = items.some((li) =>
      isTierTitleMatch(li.title, tier.product) && li.isSubscription === true
    );

    // ✅ lastPaidAt: take newest paidAt we can find (requires shopify.js patch)
    const paidDates = items.map((x) => x.paidAt).filter(Boolean).map((d) => new Date(d));
    const newestPaid = paidDates.length ? new Date(Math.max(...paidDates.map((d) => d.getTime()))) : null;

    // If we can't detect paid date, fall back to "now" but mark it (safer is to NOT enforce audit until it's correct)
    const lastPaidAtIso = newestPaid && !Number.isNaN(newestPaid.getTime())
      ? newestPaid.toISOString()
      : null;

    await setExclusiveTierRole(interaction.member, interaction.guild, tier.role);

    // ✅ Save email ↔ user after success + subscription audit fields
    emailMap[email] = {
      discordUserId: interaction.user.id,
      userTag: interaction.user.tag,
      tier: tier.role,

      // 🔥 NEW fields (critical for audit)
      isSubscription: matchedIsSubscription,
      lastPaidAt: lastPaidAtIso, // null if shopify.js doesn't supply paidAt yet

      updatedAt: new Date().toISOString(),
    };
    saveEmailMap(emailMap);

    logger.info({
      event: "verify_success",
      email,
      tier: tier.role,
      isSubscription: matchedIsSubscription,
      lastPaidAt: lastPaidAtIso,
      userId: interaction.user.id,
      guildId: interaction.guild?.id,
      at: new Date().toISOString(),
    });

    await postBotLog(client, "verify_success", {
      email,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      grantedRole: tier.role,
      subscription: matchedIsSubscription,
      lastPaidAt: lastPaidAtIso || "missing",
      message: lastPaidAtIso ? "Saved lastPaidAt for audit ✅" : "⚠️ lastPaidAt missing (fix shopify.js to include paidAt)",
    }, lastPaidAtIso ? "SUCCESS" : "WARN");

    return interaction.editReply(
      ui("Verification complete", [
        ok(`Access granted: ${fmtRole(tier.role)}`),
        bullet("If you upgraded, your lower tier role was removed automatically."),
        matchedIsSubscription ? ok("Subscription detected ✅ (audit applies)") : warn("Not a subscription (audit will ignore you)"),
        lastPaidAtIso ? ok(`Last paid recorded ✅`) : warn("Last paid missing ⚠️ (admin must patch shopify.js)"),
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

