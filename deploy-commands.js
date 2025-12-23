require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing .env variables");
  process.exit(1);
}

const commands = [
  // =====================
  // /verify (everyone)
  // =====================
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify your purchase and unlock the correct role.")
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("email")
        .setDescription("The email used at checkout")
        .setRequired(true)
    ),

  // =====================
  // /lookup (ADMIN only)
  // =====================
  new SlashCommandBuilder()
    .setName("lookup")
    .setDescription("Admin: lookup who owns an email in the bot database")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("email")
        .setDescription("Email to lookup")
        .setRequired(true)
    ),

  // =====================
  // /status (ADMIN only)
  // =====================
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Admin: check Shopify purchases for an email")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName("email")
        .setDescription("Email to check")
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands registered successfully");
  } catch (error) {
    console.error(error);
  }
})();

