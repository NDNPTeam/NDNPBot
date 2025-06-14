import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();
import cron from "node-cron";

import { Client, GatewayIntentBits, ChannelType, Partials } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});
// MAIN STUFF HERE

// Validation helpers
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.toLowerCase());
}
function isValidPhoneNumber(phone) {
  return /^\d{10}$/.test(phone);
}
function isValidZipCode(zip) {
  return /^\d{5}(-\d{4})?$/.test(zip);
}

// Onboarding questions
const questions = {
  first_name: {
    prompt: "What’s your first name?",
    required: true,
  },
  last_name: {
    prompt: "What’s your last name?",
    required: true,
  },
  email: {
    prompt: "What’s your email address?",
    required: true,
    validator: isValidEmail,
    validationErrorMsg: "Please enter a valid email (e.g., user@example.com).",
  },
  phone: {
    prompt: "What’s your phone number? (10 digits only)",
    required: true,
    validator: isValidPhoneNumber,
    validationErrorMsg: "Phone number must be 10 digits.",
  },
  zip: {
    prompt: "What’s your zip code?",
    required: true,
    validator: isValidZipCode,
    validationErrorMsg: "ZIP must be 12345 or 12345-6789.",
  },
  interests: {
    prompt: "What are your interests? (Separate by commas)",
    isArray: true,
  },
};

// Helper to ask a question and validate
async function ask(dmChannel, user, question, options = {}) {
  const {
    isArray = false,
    required = false,
    validator = null,
    validationErrorMsg = "Invalid input, please try again.",
    fieldName = "answer",
  } = options;

  const filter = (m) => m.author.id === user.id;

  while (true) {
    await dmChannel.send(
      `${question}${required ? " (required)" : ""}${
        isArray ? " (list separated by commas)" : ""
      }`
    );

    try {
      const collected = await dmChannel.awaitMessages({
        filter,
        max: 1,
        time: 60000,
        errors: ["time"],
      });

      const message = collected.first();
      let answer = message.content.trim();

      // Commands inside the ask flow
      if (answer.toLowerCase() === "!exit") throw "exit";
      if (answer.toLowerCase() === "!edit") throw "edit";
      if (answer.toLowerCase() === "!start") throw "start";

      if (!answer && required) {
        await dmChannel.send(`❌ You must provide a valid ${fieldName}.`);
        continue;
      }

      if (answer.toLowerCase() === "skip" && !required) {
        return isArray ? [] : "";
      } else if (answer.toLowerCase() === "skip" && required) {
        await dmChannel.send(`❌ You cannot skip the required ${fieldName}.`);
        continue;
      }

      if (validator && !validator(answer)) {
        await dmChannel.send(`❌ ${validationErrorMsg}`);
        continue;
      }

      if (isArray) {
        return answer
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }

      return answer;
    } catch (err) {
      if (err === "exit" || err === "edit" || err === "start") throw err;
      if (required) {
        await dmChannel.send(`⌛ Time’s up! Please answer the ${fieldName}.`);
      } else {
        await dmChannel.send(`⌛ Skipping ${fieldName}.`);
        return isArray ? [] : "";
      }
    }
  }
}

// Ask all questions
async function askQuestions(dmChannel, user, data = {}) {
  for (const key of Object.keys(questions)) {
    if (!data[key]) {
      const q = questions[key];
      try {
        data[key] = await ask(dmChannel, user, q.prompt, {
          ...q,
          fieldName: key.replace("_", " "),
        });
      } catch (cmd) {
        throw cmd; // bubble up commands like exit/edit/start
      }
    }
  }

  // Here is the fix:
  // Use only the username (no discriminator or #) as requested
  data.discord_username = user.username;
  data.discord_id = user.id;

  return data;
}

// Send collected data to webhook
async function sendToWebhook(data) {
  try {
    const res = await fetch(process.env.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      throw new Error(`Webhook responded with status ${res.status}`);
    }
  } catch (err) {
    console.error("❌ Error sending to webhook:", err);
    throw err;
  }
}

// Onboarding process
async function startOnboarding(dmChannel, user) {
  await dmChannel.send(
    `Hey there! Welcome to NDNP — where connections go beyond college! 🎉\n\n` +
      "Before we start, do you consent to answer a few onboarding questions? (yes/no)\n" +
      "You can type `!exit` anytime to cancel."
  );

  const filter = (m) => m.author.id === user.id;

  try {
    const consentCollected = await dmChannel.awaitMessages({
      filter,
      max: 1,
      time: 120000,
      errors: ["time"],
    });

    const consent = consentCollected.first().content.toLowerCase();
    console.log(`📝 Consent response from ${user.tag}: ${consent}`);

    if (consent === "!exit" || consent === "no") {
      await dmChannel.send(
        "No worries! You can join and share info anytime. Have a great day! 👋"
      );
      return;
    }

    if (consent !== "yes") {
      await dmChannel.send(
        "Please reply with `yes` to proceed or `no` to cancel."
      );
      return startOnboarding(dmChannel, user);
    }

    await dmChannel.send(
      "Awesome! We'll ask you some quick questions to get to know you better.\n" +
        "Commands you can use anytime:\n" +
        "`!exit` — cancel onboarding\n" +
        "`!edit` — update a specific answer\n" +
        "`!start` — restart onboarding from the beginning\n" +
        "Let's begin!"
    );

    let onboardingData = {};

    while (true) {
      try {
        onboardingData = await askQuestions(dmChannel, user, onboardingData);
        await sendToWebhook(onboardingData);
        console.log(`📤 Data sent to webhook for user ${user.tag}`);

        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const welcomeChannel = guild.channels.cache.get(
          process.env.WELCOME_CHANNEL_ID
        );

        if (!welcomeChannel) {
          console.error("❌ Onboarding channel not found.");
          await dmChannel.send(
            "⚠️ Couldn't find the welcome channel. Contact an admin."
          );
          return;
        }

        console.log(
          `📨 Sending confirmation in channel: ${welcomeChannel.name}`
        );

        const confirmationMessage = await welcomeChannel.send({
          content: `<@${user.id}> Your info has been submitted! 🎉 Click ✅ below to get access.`,
        });

        await confirmationMessage.react("✅");
        console.log("✅ Reaction added to confirmation message.");

        const reactionFilter = (reaction, reactingUser) =>
          reaction.emoji.name === "✅" && reactingUser.id === user.id;

        const collector = confirmationMessage.createReactionCollector({
          filter: reactionFilter,
          max: 1,
          time: 60000,
        });

        console.log("⏳ Waiting for reaction from user...");
        collector.on("collect", async () => {
          try {
            const member = await guild.members.fetch(user.id);
            const starterRole = guild.roles.cache.get(process.env.STARTER_ROLE);
            const onboardingRole = guild.roles.cache.get(
              process.env.ONBOARDING_ROLE_ID
            );

            if (!starterRole) {
              console.error("❌ Starter role not found.");
              return dmChannel.send(
                "⚠️ Starter role not found. Contact an admin."
              );
            }
            if (!onboardingRole) {
              console.error("❌ Onboarding role not found.");
              return dmChannel.send(
                "⚠️ Onboarding role not found. Contact an admin."
              );
            }

            // Remove the starter role
            await member.roles.remove(starterRole);

            // Add the onboarding role
            await member.roles.add(onboardingRole);

            await dmChannel.send("✅ You’ve been given access to the server!");
          } catch (err) {
            console.error("❌ Error updating roles:", err);
            await dmChannel.send("⚠️ There was an error updating your roles.");
          }
        });

        break;
      } catch (cmd) {
        console.log(`⚠️ Caught command: ${cmd}`);
        // your existing !exit / !start / !edit handling here
      }
    }
  } catch (e) {
    console.error("❌ Onboarding failed:", e);
    await dmChannel.send(
      "⌛ Timeout reached. Onboarding cancelled. You can start anytime by typing `!start`."
    );
  }
}

// MORE COMMANDS

// Listen for DM commands
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Handle DM commands
  if (message.channel.type === 1 /* DM */) {
    const content = message.content.trim().toLowerCase();

    if (!content.startsWith("!")) return;

    if (content === "!start") {
      try {
        await startOnboarding(message.channel, message.author);
      } catch (err) {
        console.error("❌ Error in !start:", err);
      }
    } else if (content === "!exit") {
      await message.channel.send(
        "Onboarding cancelled. You can resume anytime by typing `!start`."
      );
    } else if (content === "!edit") {
      await message.channel.send(
        "You need to start onboarding first with `!start` before editing your answers."
      );
    } else if (content === "!ping") {
      await message.channel.send("🏓 Pong!");
    }
  }

  // Handle guild commands
  else if (message.content.startsWith("!welcome")) {
    const user = message.mentions.users.first();
    if (!user) {
      message.channel.send(
        "Please mention a user to welcome, e.g. `!welcome @user`."
      );
      return;
    }

    try {
      const dmChannel = await user.createDM();
      await startOnboarding(dmChannel, user);
    } catch (error) {
      console.error("❌ Could not DM user:", error.message);
      message.channel.send(`❌ Could not DM ${user.tag}.`);
    }
  } else if (message.content.toLowerCase() === "!ping") {
    // Allow !ping globally in guild channels too
    message.reply("🏓 Pong!");
  } else if (message.content.toLowerCase() === "!jessica") {
    // Allow !ping globally in guild channels too
    message.reply("Damn Jessica");
  } else if (message.content.toLowerCase() === "!evil") {
    // Allow !ping globally in guild channels too
    message.reply("Evil Jessica");
  }
  // Levi
  else if (message.content.toLowerCase() === "!levi") {
    // Allow !ping globally in guild channels too
    const leviID = "754817698168569946";
    // Mentioning the user by their ID
    message.channel.send(`<@${leviID}> You're evil! Shut Up!`);
  }
  // Jackson
  else if (message.content.toLowerCase() === "!jackson") {
    // Allow !jackson globally in guild channels too
    const jackId = "575045955565387787";

    // Send the message mentioning the user
    const confirmationMessage = await message.channel.send(
      `<@${jackId}> Shut up! Keep it swf!`
    );

    // React to the sent message
    await confirmationMessage.react("✅");
  }

  // Glen
  else if (message.content.toLowerCase() === "!geln") {
    // Allow !ping globally in guild channels too
    const gelnId = "712001184801751044";
    // Mentioning the user by their ID
    message.channel.send(`<@${gelnId}> You're stinky! Shut Up!`);
  }
  //Bubs
  else if (message.content.toLowerCase() === "!boobles") {
    // Allow !ping globally in guild channels too
    const bubId = "708461299390218283";
    // Mentioning the user by their ID
    message.channel.send(
      `<@${bubId}> You're the most amazing man ever! Stud with a massive muscles!`
    );
  }
  // Griffin
  else if (message.content.toLowerCase() === "!griffin") {
    // Allow !ping globally in guild channels too
    const griffinId = "700924444553642044";
    // Mentioning the user by their ID
    message.channel.send(
      `<@${griffinId}> Shut up! You're not the main character!`
    );
  }
  // Ricket
  else if (message.content.toLowerCase() === "!ricket") {
    // Allow !ping globally in guild channels too
    const ricketId = "1381149179568590848";
    // Mentioning the user by their ID
    message.channel.send(`<@${ricketId}> You're the main character!`);
  }
  // DavidF
  else if (message.content.toLowerCase() === "!david") {
    // Allow !ping globally in guild channels too
    message.reply("Why do you hate me!?");
  }

  // Allow !ping globally in guild channels too
  else if (message.content.toLowerCase() === "!help") {
    // Allow !ping globally in guild channels too
    message.channel.send(
      "Here are the commands you can use:\n" +
        "`!start` - Start the onboarding process\n" +
        "`!exit` - Cancel onboarding\n" +
        "`!edit` - Edit your answers (after starting onboarding)\n" +
        "`!welcome @user` - Welcome a user and start their onboarding\n" +
        "`!ping` - Check if the bot is online\n" +
        "`!jessica` - Say something about Jessica\n" +
        "`!evil` - Say something evil about Jessica\n" +
        "`!levi` - Mention Levi\n" +
        "`!jackson` - Mention Jackson\n" +
        "`!geln` - Mention Glen\n" +
        "`!boobles` - Compliment Bubs\n" +
        "`!griffin` - Mention Griffin\n" +
        "`!ricket` - Mention Ricket"
    );
  }
});

// Auto DM on guild member join
client.on("guildMemberAdd", async (member) => {
  try {
    const dmChannel = await member.createDM();
    await startOnboarding(dmChannel, member.user);
  } catch (error) {
    console.error("❌ DM error:", error.message);
  }
});
client.on("guildMemberAdd", async (member) => {
  try {
    const starterRole = member.guild.roles.cache.get(process.env.STARTER_ROLE);
    if (starterRole) {
      await member.roles.add(starterRole);
      console.log(`Assigned starter role to ${member.user.tag}`);
    } else {
      console.warn(`Starter role ID invalid or not found.`);
    }

    const dmChannel = await member.createDM();
    await startOnboarding(dmChannel, member.user);
  } catch (error) {
    console.error("❌ Error during guildMemberAdd:", error.message);
  }
});

// HELP IN DM's
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Handle DM commands
  if (message.channel.type === ChannelType.DM) {
    const content = message.content.trim().toLowerCase();

    if (content === "!help") {
      await message.channel.send(
        "Here are the commands you can use:\n" +
          "`!start` - Start the onboarding process\n" +
          "`!exit` - Cancel onboarding\n" +
          "`!edit` - Edit your answers (after starting onboarding)\n" +
          "`!resume` - Review and get feedback on your resume!\n"
      );
    }
  }
});

// START OF RESUME BOT

const resumeRequests = new Map();

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isResumeCommand = message.content.toLowerCase() === "!resume";

  // ✅ If in a server, send instructions in DM
  if (
    isResumeCommand &&
    message.channel.type !== ChannelType.DM // This is from a server or group
  ) {
    try {
      await message.author.send(
        "📄 Thanks for using `!resume`! Please upload your resume as a file (PDF, DOC, or DOCX)."
      );
      resumeRequests.set(message.author.id, true);
      message.reply("📬 Check your DMs for instructions!");
    } catch (err) {
      message.reply(
        "❌ I couldn't DM you. Please make sure your DMs are open."
      );
    }
    return;
  }

  // ✅ If in a DM and command was used
  if (isResumeCommand && message.channel.type === ChannelType.DM) {
    message.reply(
      "📄 Please upload your resume as a file (PDF, DOC, or DOCX)."
    );
    resumeRequests.set(message.author.id, true);
    return;
  }

  // ✅ If in a DM and they send a file
  if (
    message.channel.type === ChannelType.DM &&
    message.attachments.size > 0 &&
    resumeRequests.get(message.author.id)
  ) {
    const attachment = message.attachments.first();

    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedTypes.includes(attachment.contentType)) {
      message.reply("❌ Please upload a valid resume file (PDF, DOC, DOCX).");
      return;
    }

    // Send to webhook
    await fetch(process.env.RESUME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: message.author.username,
        userId: message.author.id,
        fileName: attachment.name,
        fileUrl: attachment.url,
      }),
    });
    client.message.id = message.id; // Store the message ID for reference
    message.reply("✅ Resume received! We'll review it soon.");
    resumeRequests.delete(message.author.id);
  }
});

import cron from "node-cron";

cron.schedule(
  "0 7 * * *",
  async () => {
    try {
      const response = await fetch("https://zenquotes.io/api/random");
      const data = await response.json();

      if (!data || !data[0]) {
        console.log("No quote received.");
        return;
      }

      const quote = data[0].q;
      const author = data[0].a;

      const channel = await client.channels.fetch(process.env.QUOTE_CHANNEL_ID);
      if (channel) {
        channel.send(`📜 "${quote}" — *${author}*`);
        console.log("Daily quote sent.");
      } else {
        console.log("Channel not found.");
      }
    } catch (error) {
      console.error("Error fetching or sending daily quote:", error);
    }
  },
  {
    timezone: "America/Denver", // Denver timezone (MST/MDT with DST)
  }
);

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);
