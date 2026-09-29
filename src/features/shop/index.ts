import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  time,
  TimestampStyles,
  type Guild,
  type GuildMember,
  type InteractionUpdateOptions,
} from "discord.js";
import { giveRole, rewardRoleProblem } from "../../roles.js";
import { getSetting } from "../../settings.js";
import { sendStaffLog } from "../../staff-log.js";
import type { AdminGroup, ComponentHandler, Feature, SlashCommand } from "../../types.js";
import {
  clampPage,
  Colors,
  embed,
  formatPoints,
  notice,
  pageButtons,
  pageCountFor,
  plural,
  replyNotice,
  truncate,
} from "../../ui.js";
import { EARN_HINT } from "../economy/index.js";
import { getBalance, NotEnoughPointsError } from "../economy/store.js";
import {
  addItem,
  countItems,
  countPendingOrders,
  findItem,
  getItem,
  getOrder,
  listItems,
  markDelivered,
  memberOrders,
  pendingOrders,
  purchase,
  refundOrder,
  removeItem,
  searchItems,
  ShopError,
  updateItem,
  type Order,
  type ShopItem,
} from "./store.js";

const PAGE_SIZE = 8;
const MAX_PRICE = 1_000_000;

// ─── What members see ────────────────────────────────────────────────────────

function button(id: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function backRow(page: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button(`shop-page:${page}`, "◀ Back to shop"));
}

function itemTags(item: ShopItem, member: GuildMember): string {
  const tags = [item.role_id ? `🎭 Gives <@&${item.role_id}>` : "📦 Delivered by staff"];
  if (item.stock !== null) tags.push(item.stock > 0 ? `${item.stock} left` : "**Sold out**");
  if (item.role_id && member.roles.cache.has(item.role_id)) tags.push("✓ You have this");
  return tags.join(" · ");
}

/** The storefront: one page of items, a menu to pick one, and page/order buttons. */
function shopView(member: GuildMember, requestedPage: number): InteractionUpdateOptions {
  const { guild } = member;
  const pageCount = pageCountFor(countItems(guild.id), PAGE_SIZE);
  const page = clampPage(requestedPage, pageCount);
  const items = listItems(guild.id, PAGE_SIZE, page * PAGE_SIZE);
  if (items.length === 0)
    return { embeds: [notice("info", "The shop is empty right now. Check back soon!")], components: [] };

  const storefront = embed()
    .setTitle(`🛍️ ${guild.name} shop`)
    .setDescription(
      `You have **${formatPoints(getBalance(guild.id, member.id))}**. Pick an item below to see more or buy it.`,
    )
    .addFields(
      items.map((item) => ({
        name: `${item.name} · ${formatPoints(item.price)}`,
        value: truncate(`${item.description ? `${item.description}\n` : ""}${itemTags(item, member)}`, 1024),
      })),
    )
    .setFooter({ text: `Page ${page + 1} of ${pageCount} · ${EARN_HINT}` });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`shop-pick:${page}`)
    .setPlaceholder("Choose an item…")
    .addOptions(
      items.map((item) => ({
        label: truncate(item.name, 100),
        value: String(item.id),
        description: truncate(`${formatPoints(item.price)} · ${item.role_id ? "Role" : "Delivered by staff"}`, 100),
      })),
    );
  const buttons = pageButtons("shop-page", page, pageCount)[0] ?? new ActionRowBuilder<ButtonBuilder>();
  buttons.addComponents(button(`shop-mine:${page}`, "🧾 My orders"));

  return {
    embeds: [storefront],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons],
  };
}

/** One item up close, with a Buy button if the member can buy it. */
function itemView(member: GuildMember, item: ShopItem, page: number): InteractionUpdateOptions {
  const balance = getBalance(member.guild.id, member.id);
  const owned = item.role_id !== null && member.roles.cache.has(item.role_id);
  const soldOut = item.stock !== null && item.stock <= 0;
  const problem = owned
    ? "You already have this role."
    : soldOut
      ? "This is sold out."
      : balance < item.price
        ? `You need ${formatPoints(item.price - balance)} more. ${EARN_HINT}.`
        : null;

  const details = embed()
    .setTitle(item.name)
    .setDescription(item.description || null)
    .addFields(
      { name: "Price", value: formatPoints(item.price), inline: true },
      { name: "You have", value: formatPoints(balance), inline: true },
      {
        name: "You get",
        value: item.role_id ? `The <@&${item.role_id}> role, right away` : "Staff will deliver it after you buy",
      },
    );
  if (item.stock !== null)
    details.addFields({ name: "Stock", value: soldOut ? "Sold out" : `${item.stock} left`, inline: true });
  if (problem) details.addFields({ name: "Can't buy yet", value: problem });

  const buy = button(
    `shop-buy:${item.id}:${page}`,
    `Buy for ${formatPoints(item.price)}`,
    ButtonStyle.Success,
  ).setDisabled(problem !== null);
  return {
    embeds: [details],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buy, button(`shop-page:${page}`, "◀ Back"))],
  };
}

const STATUS_LABELS: Record<Order["status"], string> = {
  pending: "⏳ Waiting for staff",
  delivered: "✅ Delivered",
  refunded: "↩️ Refunded",
};

function myOrdersView(member: GuildMember, page: number): InteractionUpdateOptions {
  const lines = memberOrders(member.guild.id, member.id, 10).map(
    (order) =>
      `\`#${order.id}\` **${escapeMarkdown(order.item_name)}** · ${formatPoints(order.price)} · ${STATUS_LABELS[order.status]} · ${time(Math.floor(order.created_at / 1000), TimestampStyles.RelativeTime)}`,
  );
  const orders = embed()
    .setTitle("🧾 Your orders")
    .setDescription(lines.join("\n") || "You haven't bought anything yet.")
    .setFooter({ text: "Your 10 most recent orders" });
  return { embeds: [orders], components: [backRow(page)] };
}

// ─── What staff see ──────────────────────────────────────────────────────────

function orderEmbed(order: Order) {
  const color =
    order.status === "pending" ? Colors.warning : order.status === "delivered" ? Colors.success : Colors.danger;
  const status = order.handled_by
    ? `${STATUS_LABELS[order.status]} by <@${order.handled_by}>`
    : STATUS_LABELS[order.status];
  return embed(color)
    .setTitle(`🛍️ Order #${order.id}: ${order.item_name}`)
    .addFields(
      { name: "Member", value: `<@${order.user_id}>`, inline: true },
      { name: "Paid", value: formatPoints(order.price), inline: true },
      { name: "Status", value: status, inline: true },
    )
    .setTimestamp(order.created_at);
}

function orderButtons(order: Order) {
  if (order.status !== "pending") return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(`shop-order:${order.id}:deliver`, "Mark delivered", ButtonStyle.Success),
      button(`shop-order:${order.id}:refund`, "Refund", ButtonStyle.Danger),
    ),
  ];
}

async function dmMember(guild: Guild, userId: string, text: string) {
  const member = await guild.members.fetch(userId).catch(() => null);
  await member?.send({ embeds: [notice("info", text)] }).catch(() => {});
}

// ─── Commands and components ─────────────────────────────────────────────────

const shopCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("shop")
    .setDescription("Spend your points on roles and prizes")
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (countItems(interaction.guildId) === 0) {
      await replyNotice(interaction, "info", "The shop is empty right now. Check back soon!");
      return;
    }
    const { embeds, components } = shopView(interaction.member, 0);
    await interaction.reply({ embeds, components, flags: MessageFlags.Ephemeral });
  },
};

const shopComponents: ComponentHandler[] = [
  {
    prefix: "shop-page",
    async execute(interaction, [page = "0"]) {
      await interaction.update(shopView(interaction.member, Number(page)));
    },
  },
  {
    prefix: "shop-pick",
    async execute(interaction, [page = "0"]) {
      if (!interaction.isStringSelectMenu()) return;
      const item = getItem(interaction.guildId, Number(interaction.values[0]));
      await interaction.update(
        item ? itemView(interaction.member, item, Number(page)) : shopView(interaction.member, Number(page)),
      );
    },
  },
  {
    prefix: "shop-mine",
    async execute(interaction, [page = "0"]) {
      await interaction.update(myOrdersView(interaction.member, Number(page)));
    },
  },
  {
    prefix: "shop-buy",
    async execute(interaction, [itemId = "0", pageArg = "0"]) {
      const { member, guild } = interaction;
      const page = Number(pageArg);
      const fail = (text: string) =>
        interaction.update({ embeds: [notice("error", text)], components: [backRow(page)] });

      const item = getItem(guild.id, Number(itemId));
      if (!item) {
        await fail("That item isn't in the shop anymore.");
        return;
      }
      if (item.role_id && member.roles.cache.has(item.role_id)) {
        await fail("You already have this role.");
        return;
      }

      let order: Order;
      try {
        order = purchase(guild.id, member.id, member.displayName, item.id);
      } catch (error) {
        if (error instanceof NotEnoughPointsError) {
          await fail(`You only have ${formatPoints(error.balance)}.`);
          return;
        }
        if (error instanceof ShopError) {
          await fail(error.message);
          return;
        }
        throw error;
      }

      if (item.role_id) {
        const problem = await giveRole(member, item.role_id, `Bought ${item.name} in the shop`);
        if (problem) {
          refundOrder(guild.id, order.id, interaction.client.user.id);
          await sendStaffLog(guild, {
            embeds: [
              notice(
                "warning",
                `${member} tried to buy **${escapeMarkdown(item.name)}** but Tuli couldn't give the role, so they were refunded. ${problem}`,
              ),
            ],
          });
          await fail("Tuli couldn't give you that role, so your points were refunded. Staff have been told.");
          return;
        }
        await sendStaffLog(guild, {
          embeds: [
            notice(
              "info",
              `${member} bought **${escapeMarkdown(item.name)}** for ${formatPoints(item.price)} and got <@&${item.role_id}>.`,
            ),
          ],
        });
      } else {
        await sendStaffLog(guild, {
          content: "New shop order",
          embeds: [orderEmbed(order)],
          components: orderButtons(order),
        });
      }

      const next = item.role_id
        ? `You now have <@&${item.role_id}>.`
        : getSetting(guild.id, "logChannelId")
          ? `Staff have been notified and will deliver it soon. Your order number is **#${order.id}**.`
          : `Let a staff member know so they can deliver it. Your order number is **#${order.id}**.`;
      const receipt = notice(
        "success",
        `You bought **${escapeMarkdown(item.name)}** for ${formatPoints(item.price)}.\n${next}`,
      ).setFooter({
        text: `Balance: ${getBalance(guild.id, member.id).toLocaleString("en-US")} points`,
      });
      await interaction.update({ embeds: [receipt], components: [backRow(page)] });
    },
  },
  {
    // Staff buttons on an order, in the staff log or /admin shop orders.
    prefix: "shop-order",
    async execute(interaction, [orderId = "0", action]) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        await replyNotice(interaction, "error", "Only staff with Manage Server can handle orders.");
        return;
      }
      const { guild } = interaction;
      const handled =
        action === "deliver"
          ? markDelivered(guild.id, Number(orderId), interaction.user.id)
          : refundOrder(guild.id, Number(orderId), interaction.user.id);
      const order = handled ?? getOrder(guild.id, Number(orderId));
      if (!order) {
        await replyNotice(interaction, "error", "That order doesn't exist anymore.");
        return;
      }
      await interaction.update({ embeds: [orderEmbed(order)], components: orderButtons(order) });
      if (!handled) return; // someone else got to it first; the card now shows what happened

      const where = `in **${escapeMarkdown(guild.name)}**`;
      await dmMember(
        guild,
        order.user_id,
        action === "deliver"
          ? `🎉 Your **${escapeMarkdown(order.item_name)}** order ${where} has been delivered.`
          : `↩️ Your **${escapeMarkdown(order.item_name)}** order ${where} was refunded. ${formatPoints(order.price)} is back in your balance.`,
      );
    },
  },
  {
    // Picking an order from /admin shop orders.
    prefix: "shop-queue",
    async execute(interaction) {
      if (!interaction.isStringSelectMenu()) return;
      const order = getOrder(interaction.guildId, Number(interaction.values[0]));
      if (!order) return;
      await interaction.update({ embeds: [orderEmbed(order)], components: orderButtons(order) });
    },
  },
];

function itemPreview(item: ShopItem) {
  return embed()
    .setTitle(item.name)
    .setDescription(item.description || null)
    .addFields(
      { name: "Price", value: formatPoints(item.price), inline: true },
      { name: "Gives", value: item.role_id ? `<@&${item.role_id}>` : "Delivered by staff", inline: true },
      { name: "Stock", value: item.stock === null ? "Unlimited" : String(item.stock), inline: true },
    );
}

const shopAdmin: AdminGroup = {
  name: "shop",
  description: "Shop items and orders",
  build: (group) =>
    group
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add an item to the shop")
          .addStringOption((o) =>
            o.setName("name").setDescription("What it's called").setRequired(true).setMaxLength(80),
          )
          .addIntegerOption((o) =>
            o.setName("price").setDescription("Cost in points").setRequired(true).setMinValue(1).setMaxValue(MAX_PRICE),
          )
          .addStringOption((o) => o.setName("description").setDescription("What people get").setMaxLength(200))
          .addRoleOption((o) =>
            o.setName("role").setDescription("A role to give automatically (leave empty for staff-delivered prizes)"),
          )
          .addIntegerOption((o) =>
            o.setName("stock").setDescription("How many can be bought (leave empty for unlimited)").setMinValue(0),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Change an item")
          .addStringOption((o) => o.setName("item").setDescription("The item").setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(80))
          .addIntegerOption((o) => o.setName("price").setDescription("New price").setMinValue(1).setMaxValue(MAX_PRICE))
          .addStringOption((o) => o.setName("description").setDescription("New description").setMaxLength(200))
          .addIntegerOption((o) =>
            o.setName("stock").setDescription("How many are left (-1 for unlimited)").setMinValue(-1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Take an item out of the shop")
          .addStringOption((o) => o.setName("item").setDescription("The item").setRequired(true).setAutocomplete(true)),
      )
      .addSubcommand((sub) => sub.setName("orders").setDescription("See orders waiting to be delivered")),

  async execute(interaction) {
    const { guildId } = interaction;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      const role = interaction.options.getRole("role");
      const problem = role && rewardRoleProblem(role);
      if (problem) {
        await replyNotice(interaction, "error", problem);
        return;
      }
      try {
        const item = addItem(guildId, {
          name: interaction.options.getString("name", true).trim(),
          description: interaction.options.getString("description") ?? "",
          price: interaction.options.getInteger("price", true),
          roleId: role?.id ?? null,
          stock: interaction.options.getInteger("stock"),
        });
        const staffNote =
          !role && !getSetting(guildId, "logChannelId")
            ? "\nTip: set a staff log channel with `/admin setup log-channel` so you're told when someone buys it."
            : "";
        await replyNotice(interaction, "success", `Added **${escapeMarkdown(item.name)}** to the shop.${staffNote}`, [
          itemPreview(item),
        ]);
      } catch (error) {
        if (!(error instanceof ShopError)) throw error;
        await replyNotice(interaction, "error", error.message);
      }
      return;
    }

    if (subcommand === "orders") {
      const orders = pendingOrders(guildId, 25);
      if (orders.length === 0) {
        await replyNotice(interaction, "success", "No orders are waiting. 🎉");
        return;
      }
      const list = embed(Colors.warning)
        .setTitle(`🛍️ ${plural(countPendingOrders(guildId), "order")} waiting`)
        .setDescription(
          orders
            .map(
              (order) =>
                `\`#${order.id}\` **${escapeMarkdown(order.item_name)}** for <@${order.user_id}> · ${time(Math.floor(order.created_at / 1000), TimestampStyles.RelativeTime)}`,
            )
            .join("\n"),
        );
      const menu = new StringSelectMenuBuilder()
        .setCustomId("shop-queue")
        .setPlaceholder("Pick an order to handle…")
        .addOptions(
          orders.map((order) => ({ label: truncate(`#${order.id} ${order.item_name}`, 100), value: String(order.id) })),
        );
      await interaction.reply({
        embeds: [list],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const item = findItem(guildId, interaction.options.getString("item", true));
    if (!item) {
      await replyNotice(interaction, "error", "I couldn't find that item. Pick one from the list as you type.");
      return;
    }

    if (subcommand === "remove") {
      removeItem(guildId, item.id);
      await replyNotice(
        interaction,
        "success",
        `Removed **${escapeMarkdown(item.name)}** from the shop. Existing orders aren't affected.`,
      );
      return;
    }

    // edit
    const stock = interaction.options.getInteger("stock");
    try {
      const updated = updateItem(guildId, item.id, {
        name: interaction.options.getString("name")?.trim(),
        price: interaction.options.getInteger("price") ?? undefined,
        description: interaction.options.getString("description") ?? undefined,
        stock: stock === null ? undefined : stock === -1 ? null : stock,
      });
      await replyNotice(interaction, "success", `Updated **${escapeMarkdown(updated.name)}**.`, [itemPreview(updated)]);
    } catch (error) {
      if (!(error instanceof ShopError)) throw error;
      await replyNotice(interaction, "error", error.message);
    }
  },

  async autocomplete(interaction) {
    const items = searchItems(interaction.guildId, interaction.options.getFocused());
    await interaction.respond(
      items.map((item) => ({ name: truncate(`${item.name} · ${item.price} points`, 100), value: String(item.id) })),
    );
  },
};

export const shopFeature: Feature = {
  name: "Shop",
  slashCommands: [shopCommand],
  components: shopComponents,
  admin: shopAdmin,
  permissions: { ManageRoles: "give roles people buy in the shop" },

  describeSettings(guild) {
    const items = listItems(guild.id, 100, 0);
    const warnings = items.flatMap((item) => {
      if (!item.role_id) return [];
      const role = guild.roles.cache.get(item.role_id);
      const problem = role ? rewardRoleProblem(role) : "Its role was deleted.";
      return problem ? [`⚠️ **${item.name}**: ${problem}`] : [];
    });
    if (items.some((item) => !item.role_id) && !getSetting(guild.id, "logChannelId")) {
      warnings.push("⚠️ Set a staff log channel so staff hear about orders to deliver.");
    }
    const pending = countPendingOrders(guild.id);
    return [
      {
        name: "🛍️ Shop",
        value: [`${plural(countItems(guild.id), "item")} · ${plural(pending, "order")} waiting`, ...warnings]
          .join("\n")
          .slice(0, 1024),
      },
    ];
  },
};
