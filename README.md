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
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent** so scam protection can read messages. (If it's off, Tuli still runs, just without scam detection.)
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

| Command                                          | What it does                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `/tuli`                                          | List everything Tuli can do (only you see it)                                      |
| `@Tuli`                                          | Tuli says hi                                                                       |
| `/quote add text by`                             | Save something someone said                                                        |
| Right-click a message → Apps → **Save as quote** | Save that message as a quote, with a link back to it                               |
| `/quote random [by]`                             | Share a random quote, optionally from one person                                   |
| `/quote list [by]`                               | Browse all quotes, 10 per page (only you see it)                                   |
| `/quote show number`                             | Show a specific quote                                                              |
| `/quote delete number`                           | Delete a quote (the saver, the person quoted, or anyone with Manage Messages)      |
| `/points balance [member]`                       | See a points balance, rank and daily streak                                        |
| `/points daily`                                  | Claim daily points; claiming on consecutive days builds a streak (50 → 100 points) |
| `/points pay member amount [note]`               | Send some of your points to someone                                                |
| `/points history`                                | Your recent points activity (only you see it)                                      |
| `/rank [member]`                                 | See a level, XP progress, rank and message count                                   |
| `/leaderboard [board]`                           | See who's on top by level or points                                                |
| `/shop`                                          | Browse the shop, buy things with points, and check your orders                     |
| `/question today`                                | Jump to the latest daily/weekly question                                           |
| `/question suggest`                              | Suggest a question; staff approve it from the staff log                            |
| `/mod warn`, `warnings`, `unwarn`                | Warn members (they get a DM) and review their record (moderators only)             |
| `/mod purge amount [member]`                     | Bulk-delete recent messages in a channel (moderators only)                         |

### Staff commands

Staff commands live under `/admin`, which only members with **Manage Server** can see. Server owners can change who can use it in **Server Settings → Integrations → Tuli**.

| Command                                   | What it does                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/admin setup overview`                   | See all of Tuli's settings and check that it has the permissions it needs                                                           |
| `/admin setup log-channel`                | Pick a staff-only channel for alerts (scam reports, shop orders, suggestions)                                                       |
| `/admin setup timezone`                   | Your server's timezone, for daily resets and question schedules (default: America/Chicago)                                          |
| `/admin points give/take`                 | Give or take points with a reason (e.g. for coming to a GBM); logged to the staff channel                                           |
| `/admin points history`                   | See anyone's points activity                                                                                                        |
| `/admin levels reward level role`         | Give a role at a level (also given to people already past it)                                                                       |
| `/admin levels remove-reward`, `rewards`  | Manage level reward roles                                                                                                           |
| `/admin levels announcements`             | Announce level-ups where they happen, in one channel, or not at all                                                                 |
| `/admin levels set member level`          | Set someone's level, e.g. to carry it over from another bot                                                                         |
| `/admin shop add`                         | Add an item: give it a role to hand out automatically, or leave the role empty for prizes staff deliver (real prizes, trivia hints) |
| `/admin shop edit`, `remove`              | Change prices, descriptions and stock, or remove an item                                                                            |
| `/admin shop orders`                      | Deliver or refund orders waiting for staff (also possible from the buttons in the staff log)                                        |
| `/admin questions schedule`               | Post questions in a channel every day or once a week, at a set hour, optionally pinging a role                                      |
| `/admin questions add`, `queue`, `remove` | Manage the queue of questions (posted oldest first)                                                                                 |
| `/admin questions post-now`, `pause`      | Post the next question right away, or stop posting                                                                                  |
| `/admin protection configure`             | Turn scam protection on or off and pick the timeout length (default: on, 1 day)                                                     |
| `/admin protection test`                  | See what Tuli would do with a message, without posting it                                                                           |
| `/admin feeds add url channel [keywords]` | Post new items from a website's RSS/Atom feed, optionally only ones mentioning certain words                                        |
| `/admin feeds list`, `remove`, `preview`  | Manage feeds and see how their posts will look                                                                                      |

### Feeds

Tuli checks each feed every 10 minutes and posts new items (at most 5 at a time, so a busy feed can't flood the channel). When you add a feed, only posts from then on are shared. Iowa State feeds that work:

| Feed                    | Link                                        |
| ----------------------- | ------------------------------------------- |
| ISU News                | `https://www.news.iastate.edu/rss.xml`      |
| Inside Iowa State       | `https://www.inside.iastate.edu/rss.xml`    |
| Iowa State Daily        | `https://iowastatedaily.com/feed/`          |
| Career Services         | `https://www.career.iastate.edu/feed/`      |
| College of Engineering  | `https://www.engineering.iastate.edu/feed/` |
| Liberal Arts & Sciences | `https://www.las.iastate.edu/feed/`         |

Most WordPress sites have a feed at `/feed/`, and Drupal sites at `/rss.xml`. Use `keywords` to keep only opportunities, e.g. `internship, scholarship, research, hiring, apply`.

### Scam protection

Tuli watches every message and acts on the patterns that hit community servers:

- **Deletes and times out** (then reports to the staff log with Ban / Remove timeout buttons):
  - links to fake Discord or Steam sites (`dlscord.gift`, `steamcommunlty.com`...)
  - "free Nitro" / Steam gift bait with a link
  - `@everyone` with a link from someone who can't ping everyone
  - the same message posted in 3+ channels within a minute (how hacked accounts spread scams)
- **Flags for staff** (Delete & time out / Looks fine buttons): "giving away my MacBook / selling tickets, DM me" posts.

Moderators (anyone with Manage Messages) are never checked. People caught get a DM explaining their account may be hacked and how to secure it.

Quote numbers are per server. Tuli won't save the same thing from the same person twice (ignoring capitalization, extra spaces, and quote marks). Commands register automatically when Tuli starts; if they don't appear, reload Discord with Ctrl+R (Cmd+R on Mac).

## Roadmap

- [x] Greet people who mention Tuli
- [x] Quotes: save quotes and share random ones
- [x] Daily/weekly custom questions
- [x] Moderation (scammer protection)
- [x] External feeds (ISU opportunities)
- [x] Currency: points tied to each member's Discord ID
- [x] Item shop: redeem points for roles and other rewards
- [x] Levels: XP from chatting, roles at XP milestones
