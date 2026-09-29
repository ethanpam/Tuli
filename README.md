# Tuli

A Discord bot for our community server, built with [discord.js](https://discord.js.org) and TypeScript.

## One-time setup

### 1. Create the bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it `Tuli`.
2. Open the **Installation** tab:
   - Set **Install Link** to **None** and save. Discord won't let you make the bot private until you do this.
   - Under **Installation Contexts**, uncheck **User Install** and keep **Guild Install** checked. Tuli is a server bot.
3. Open the **Bot** tab:
   - Click **Reset Token** and copy the token. Treat it like a password: anyone with it can control the bot.
   - Turn off **Public Bot** so only you can add Tuli to servers.
   - Leave the **Privileged Gateway Intents** off for now.
4. Invite Tuli: run the bot (next section) and open the `Invite link:` it prints. Add Tuli to a private test server first, not the real community one.

### 2. Run it locally

Requires Node 22 or newer.

```sh
npm install
cp .env.example .env   # then paste your token after DISCORD_TOKEN=
npm run dev            # restarts automatically when you save a file
```

You should see `Logged in as Tuli#1234` and an invite link. Mention `@Tuli` in a channel it can see.

| Command             | What it does                        |
| ------------------- | ----------------------------------- |
| `npm run dev`       | Run with auto-restart on file save  |
| `npm start`         | Run once                            |
| `npm run typecheck` | Check types without running the bot |
| `npm test`          | Run the tests                       |
| `npm run check`     | Typecheck and test                  |

Tuli stores its data in `data/tuli.db` (SQLite, gitignored). Set `DATABASE_PATH` in `.env` to keep it somewhere else.

## Commands

| Command                                 | What it does                                        |
| --------------------------------------- | --------------------------------------------------- |
| `/tuli`                                 | List everything Tuli can do (only you see it)       |
| `@Tuli`                                 | Tuli says hi                                        |
| `/quote add text by`                    | Save something someone said                         |
| Right-click a message → Apps → **Save as quote** | Save that message as a quote, with a link back to it |
| `/quote random [by]`                    | Share a random quote, optionally from one person    |
| `/quote list [by]`                      | Browse all quotes, 10 per page (only you see it)    |
| `/quote show number`                    | Show a specific quote                               |
| `/quote delete number`                  | Delete a quote (the saver, the person quoted, or anyone with Manage Messages) |

Quote numbers are per server. Tuli won't save the same thing from the same person twice (ignoring capitalization, extra spaces, and quote marks). Commands register automatically when Tuli starts; if they don't appear, reload Discord with Ctrl+R (Cmd+R on Mac).

## Roadmap

- [x] Greet people who mention Tuli
- [x] Quotes: save quotes and share random ones
- [ ] Daily/weekly custom questions
- [ ] Moderation (scammer protection)
- [ ] External feeds (ISU opportunities)
- [ ] Currency: points tied to each member's Discord ID
- [ ] Item shop: redeem points for roles and other rewards
- [ ] Levels: XP from chatting, roles at XP milestones
