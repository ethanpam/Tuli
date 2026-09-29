# Tuli

A Discord bot for our community server. Tuli keeps the server fun (quotes, points, levels, a shop and daily questions), keeps it safe (scam protection and moderator tools), and keeps it informed (ISU news and opportunities from RSS feeds).

Built with [discord.js](https://discord.js.org), TypeScript and SQLite.

## What Tuli does

|                  | For members                                                                                                              | For staff                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 💬 **Quotes**    | Save funny moments with `/quote add` or right-click → Apps → **Save as quote**, then `/quote random` and browse them all | Delete any quote                                                          |
| 🪙 **Points**    | Daily rewards with streaks, send points to friends, see your history                                                     | Give points for things like coming to a GBM                               |
| 🏆 **Levels**    | Earn XP by chatting, level up for bonus points, climb the leaderboard                                                    | Hand out roles at certain levels                                          |
| 🛍️ **Shop**      | Spend points on roles and prizes                                                                                         | Sell roles (given automatically) or prizes you deliver, like trivia hints |
| ❓ **Questions** | Answer the question of the day/week in its thread for points, and suggest new ones                                       | Queue questions and pick when they post                                   |
| 🛡️ **Safety**    | Scams get cleaned up automatically                                                                                       | Scam reports with one-click ban, plus warnings and purge                  |
| 📰 **Feeds**     | New ISU news and opportunities posted in a channel                                                                       | Follow any website's RSS feed, filtered by keywords                       |

Type `/tuli` in Discord to see every command.

## Getting started

### 1. Create the bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it `Tuli`.
2. **Installation** tab:
   - Set **Install Link** to **None** and save. Discord won't let you make the bot private until you do this.
   - Under **Installation Contexts**, uncheck **User Install** and keep **Guild Install**.
3. **Bot** tab:
   - Click **Reset Token** and copy the token. Treat it like a password: anyone with it can control the bot.
   - Turn off **Public Bot** so only you can add Tuli to servers.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Scam protection needs it to read messages. (If it's off, Tuli still runs, just without scam detection, and tells you how to fix it.)

### 2. Run it

Requires Node 22 or newer.

```sh
npm install
cp .env.example .env   # then paste your token after DISCORD_TOKEN=
npm run dev            # restarts automatically when you save a file
```

You'll see `Logged in as Tuli#1234`, then an **invite link**. Open it to add Tuli to a server. Try it in a private test server before the real one.

If Tuli's commands don't show up in Discord, reload the app with Ctrl+R (Cmd+R on Mac).

### 3. Set it up in your server

Do these once, in order:

1. **Move Tuli's role up.** In **Server Settings → Roles**, drag the **Tuli** role above regular members' roles and above any role you want it to hand out. Tuli can only time out people and give roles that are below its own.
2. **`/admin setup log-channel`**: pick a staff-only channel. Scam reports, shop orders and question suggestions go there.
3. **`/admin setup timezone`**, if you're not on Central time. Daily rewards reset and questions post in this timezone.
4. **`/admin setup overview`**: checks everything. If Tuli is missing permissions, click **Update Tuli's permissions**.
5. Turn on the features you want:
   - **Questions**: add a few with `/admin questions add`, then `/admin questions schedule`.
   - **Shop**: `/admin shop add`. Give an item a role to hand it out automatically, or leave the role empty for prizes staff deliver.
   - **Level rewards**: `/admin levels reward level:5 role:@Regular`.
   - **Feeds**: `/admin feeds add` (see the [ISU feeds below](#feeds)).
6. Try scam protection without posting anything: `/admin protection test message:free nitro https://dlscord.gift/x`.

## Commands

### Everyone

| Command                                          | What it does                                                  |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `/tuli`                                          | See everything Tuli can do                                    |
| `@Tuli`                                          | Tuli says hi                                                  |
| `/quote add text by`                             | Save something someone said                                   |
| Right-click a message → Apps → **Save as quote** | Save that message as a quote, with a link back to it          |
| `/quote random [by]`                             | Share a random quote, optionally from one person              |
| `/quote list [by]`                               | Browse all quotes, 10 per page                                |
| `/quote show number`                             | Show a specific quote                                         |
| `/quote delete number`                           | Delete a quote (the saver, the person quoted, or a moderator) |
| `/points balance [member]`                       | See a points balance, rank and daily streak                   |
| `/points daily`                                  | Claim daily points; consecutive days build a streak           |
| `/points pay member amount [note]`               | Send some of your points to someone                           |
| `/points history`                                | Your recent points activity                                   |
| `/rank [member]`                                 | See a level, XP progress, rank and message count              |
| `/leaderboard [board]`                           | See who's on top by level or points                           |
| `/shop`                                          | Browse the shop, buy things, and check your orders            |
| `/question today`                                | Jump to the latest question                                   |
| `/question suggest`                              | Suggest a question for staff to approve                       |

### Moderators (Moderate Members permission)

| Command                      | What it does                                        |
| ---------------------------- | --------------------------------------------------- |
| `/mod warn member reason`    | Warn someone; they get a DM and it's kept on record |
| `/mod warnings member`       | See someone's warnings                              |
| `/mod unwarn id`             | Remove a warning                                    |
| `/mod purge amount [member]` | Bulk-delete recent messages in this channel         |

### Admins (Manage Server permission)

Everything under `/admin` is hidden from other members. Server owners can change who can use it in **Server Settings → Integrations → Tuli**.

| Command                                                  | What it does                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/admin setup overview`                                  | See every setting and check Tuli's permissions                               |
| `/admin setup log-channel`                               | Where staff alerts go                                                        |
| `/admin setup timezone`                                  | The server's timezone (default: America/Chicago)                             |
| `/admin points give` / `take`                            | Give or take points with a reason, logged to the staff channel               |
| `/admin points history`                                  | See anyone's points activity                                                 |
| `/admin levels reward` / `remove-reward` / `rewards`     | Roles given at certain levels (also given to people already past that level) |
| `/admin levels announcements`                            | Announce level-ups where they happen, in one channel, or not at all          |
| `/admin levels set`                                      | Set someone's level, e.g. to carry it over from another bot                  |
| `/admin shop add` / `edit` / `remove`                    | Manage shop items, prices and stock                                          |
| `/admin shop orders`                                     | Deliver or refund orders waiting for staff                                   |
| `/admin questions schedule` / `pause`                    | Post questions daily or weekly at a set hour, optionally pinging a role      |
| `/admin questions add` / `queue` / `remove` / `post-now` | Manage the question queue (posted oldest first)                              |
| `/admin protection configure` / `test`                   | Turn scam protection on/off, pick the timeout, or test a message             |
| `/admin feeds add` / `list` / `remove` / `preview`       | Follow websites' RSS feeds                                                   |

## How it works

### Points

| How to earn                  | Points                                       |
| ---------------------------- | -------------------------------------------- |
| `/points daily`              | 50, plus 10 for each day in a row, up to 100 |
| Reaching a new level         | 20 × the level (level 5 → 100)               |
| First answer to a question   | 10                                           |
| Staff (`/admin points give`) | Any amount                                   |

Every change is recorded with a reason, so `/points history` and `/admin points history` always add up. Purchases and refunds happen all-or-nothing, so points can't go missing.

### Levels

Chatting earns 15–25 XP, at most once a minute, so spamming doesn't help. Levels use the same curve as MEE6 (100 XP for level 1, then 155, 220, 295...), so `/admin levels set` can carry levels over from it. Members keep every reward role they've earned.

### Questions

Tuli posts the oldest queued question on schedule, opens a thread for answers, and reacts 🪙 to each person's first answer. If Tuli was offline at posting time, it posts once when it's back (not once per missed day). Staff get a heads-up when the queue is almost empty.

### Scam protection

Tuli checks every message from non-moderators:

- **Deleted, with a timeout** (default 1 day) and a report in the staff log with **Ban** and **Remove timeout** buttons:
  - links to fake Discord or Steam sites (`dlscord.gift`, `steamcommunlty.com`...)
  - "free Nitro" / Steam gift bait with a link
  - `@everyone` with a link from someone who can't ping everyone
  - the same message posted in 3+ channels within a minute, which is how hacked accounts spread scams
- **Flagged for staff** with **Delete & time out** / **Looks fine** buttons: "giving away my MacBook / selling tickets, DM me" posts.

People caught get a DM saying their account may be hacked and how to secure it.

### Feeds

Tuli checks each feed every 10 minutes and posts new items, at most 5 at a time so a busy feed can't flood the channel. When you add a feed, only posts from then on are shared. Iowa State feeds that work:

| Feed                    | Link                                        |
| ----------------------- | ------------------------------------------- |
| ISU News                | `https://www.news.iastate.edu/rss.xml`      |
| Inside Iowa State       | `https://www.inside.iastate.edu/rss.xml`    |
| Iowa State Daily        | `https://iowastatedaily.com/feed/`          |
| Career Services         | `https://www.career.iastate.edu/feed/`      |
| College of Engineering  | `https://www.engineering.iastate.edu/feed/` |
| Liberal Arts & Sciences | `https://www.las.iastate.edu/feed/`         |

Most WordPress sites have a feed at `/feed/`, and Drupal sites at `/rss.xml`. Add `keywords` to keep only opportunities, e.g. `internship, scholarship, research, hiring, apply`.

## Keeping Tuli online

Tuli is only online while it's running. On your laptop, that stops when the laptop sleeps. To keep it up around the clock:

- **An always-on computer** (a Raspberry Pi, an old laptop, a small VPS):
  ```sh
  npm ci --omit=dev
  npx pm2 start npm --name tuli -- start   # keeps it running and restarts it if it crashes
  npx pm2 save && npx pm2 startup          # starts it again after a reboot
  ```
- **A hosting service** (Railway, Fly.io, Render...): set `DISCORD_TOKEN` as an environment variable, use `npm start` as the start command, and attach a **persistent volume**, setting `DATABASE_PATH` to a file on it (e.g. `/data/tuli.db`). Without a volume, every redeploy wipes all points, quotes and levels.

Run only one copy of Tuli at a time, or it will answer everything twice. To back up, copy the database file while Tuli is stopped.

## Development

| Command          | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `npm run dev`    | Run with auto-restart on file save                           |
| `npm start`      | Run once                                                     |
| `npm run check`  | Typecheck, test and check formatting (run before committing) |
| `npm run format` | Format the code                                              |

```
src/
  index.ts            Connects to Discord and starts everything
  router.ts           Sends each command, button and message to the right feature
  db.ts               The database and its migrations
  settings.ts         Per-server settings
  ui.ts               Colors, embeds and pagination shared by every feature
  features/
    index.ts          The list of features
    <feature>/        One folder per feature: store.ts (database) and index.ts (commands)
test/                 Tests (run against an in-memory database)
```

To add a feature, create `src/features/<name>/index.ts` exporting a `Feature` (see `src/types.ts`) and add it to `src/features/index.ts`. Its commands, buttons, `/admin` subcommands, permissions and `/admin setup overview` lines are then picked up automatically. Add any database tables as a new entry at the end of the migrations list in `src/db.ts`, and never edit an entry that has already run.
