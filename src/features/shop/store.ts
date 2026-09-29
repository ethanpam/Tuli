import { db, transaction } from "../../db.js";
import { changePoints } from "../economy/store.js";

export interface ShopItem {
  id: number;
  guild_id: string;
  name: string;
  description: string;
  price: number;
  role_id: string | null;
  stock: number | null;
  created_at: number;
}

export type OrderStatus = "pending" | "delivered" | "refunded";

export interface Order {
  id: number;
  guild_id: string;
  user_id: string;
  item_id: number | null;
  item_name: string;
  price: number;
  status: OrderStatus;
  handled_by: string | null;
  created_at: number;
  handled_at: number | null;
}

export class ShopError extends Error {}

const insertItem = db.prepare(`
  INSERT INTO shop_items (guild_id, name, description, price, role_id, stock, created_at)
  VALUES ($guildId, $name, $description, $price, $roleId, $stock, $now) RETURNING *`);
const updateItemRow = db.prepare(`
  UPDATE shop_items SET name = $name, description = $description, price = $price, stock = $stock
  WHERE guild_id = $guildId AND id = $id RETURNING *`);
const deleteItem = db.prepare("DELETE FROM shop_items WHERE guild_id = $guildId AND id = $id");
const selectItem = db.prepare("SELECT * FROM shop_items WHERE guild_id = $guildId AND id = $id");
const selectItemByName = db.prepare("SELECT * FROM shop_items WHERE guild_id = $guildId AND name = $name COLLATE NOCASE");
const selectItems = db.prepare("SELECT * FROM shop_items WHERE guild_id = $guildId ORDER BY price, name LIMIT $limit OFFSET $offset");
const selectItemCount = db.prepare("SELECT COUNT(*) AS count FROM shop_items WHERE guild_id = $guildId");
const searchItemRows = db.prepare(
  "SELECT * FROM shop_items WHERE guild_id = $guildId AND name LIKE $pattern ESCAPE '\\' ORDER BY name LIMIT $limit",
);
const decrementStock = db.prepare("UPDATE shop_items SET stock = stock - 1 WHERE id = $id AND stock IS NOT NULL");
const incrementStock = db.prepare("UPDATE shop_items SET stock = stock + 1 WHERE id = $id AND stock IS NOT NULL");

const insertOrder = db.prepare(`
  INSERT INTO shop_orders (guild_id, user_id, item_id, item_name, price, status, created_at)
  VALUES ($guildId, $userId, $itemId, $itemName, $price, $status, $now) RETURNING *`);
const selectOrder = db.prepare("SELECT * FROM shop_orders WHERE guild_id = $guildId AND id = $id");
const finishOrder = db.prepare(`
  UPDATE shop_orders SET status = $status, handled_by = $handledBy, handled_at = $now
  WHERE guild_id = $guildId AND id = $id RETURNING *`);
const selectMemberOrders = db.prepare(
  "SELECT * FROM shop_orders WHERE guild_id = $guildId AND user_id = $userId ORDER BY id DESC LIMIT $limit",
);
const selectPendingOrders = db.prepare(
  "SELECT * FROM shop_orders WHERE guild_id = $guildId AND status = 'pending' ORDER BY id LIMIT $limit",
);
const selectPendingCount = db.prepare("SELECT COUNT(*) AS count FROM shop_orders WHERE guild_id = $guildId AND status = 'pending'");

export interface ItemFields {
  name: string;
  description: string;
  price: number;
  roleId: string | null;
  stock: number | null;
}

function isDuplicateName(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}

export function addItem(guildId: string, fields: ItemFields): ShopItem {
  try {
    return insertItem.get({ guildId, ...fields, now: Date.now() }) as unknown as ShopItem;
  } catch (error) {
    if (isDuplicateName(error)) throw new ShopError(`There's already an item called "${fields.name}".`);
    throw error;
  }
}

export function updateItem(guildId: string, id: number, changes: Partial<Omit<ItemFields, "roleId">>): ShopItem {
  const item = getItem(guildId, id);
  if (!item) throw new ShopError("That item no longer exists.");
  try {
    return updateItemRow.get({
      guildId,
      id,
      name: changes.name ?? item.name,
      description: changes.description ?? item.description,
      price: changes.price ?? item.price,
      stock: changes.stock === undefined ? item.stock : changes.stock,
    }) as unknown as ShopItem;
  } catch (error) {
    if (isDuplicateName(error)) throw new ShopError(`There's already an item called "${changes.name}".`);
    throw error;
  }
}

export function removeItem(guildId: string, id: number): void {
  deleteItem.run({ guildId, id });
}

export function getItem(guildId: string, id: number): ShopItem | undefined {
  return selectItem.get({ guildId, id }) as ShopItem | undefined;
}

/** Finds an item by ID (what autocomplete sends) or by name (what people type). */
export function findItem(guildId: string, idOrName: string): ShopItem | undefined {
  const byId = /^\d+$/.test(idOrName) ? getItem(guildId, Number(idOrName)) : undefined;
  return byId ?? (selectItemByName.get({ guildId, name: idOrName.trim() }) as ShopItem | undefined);
}

export function listItems(guildId: string, limit: number, offset: number): ShopItem[] {
  return selectItems.all({ guildId, limit, offset }) as unknown as ShopItem[];
}

export function countItems(guildId: string): number {
  return (selectItemCount.get({ guildId }) as { count: number }).count;
}

export function searchItems(guildId: string, query: string, limit = 25): ShopItem[] {
  // Escape LIKE's wildcards so "%" or "_" in a search are matched literally.
  const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  return searchItemRows.all({ guildId, pattern, limit }) as unknown as ShopItem[];
}

/**
 * Buys an item: takes the points, uses up one of the stock and records the order, all
 * together. Role items are marked delivered (the caller gives the role); everything else
 * waits for staff.
 */
export function purchase(guildId: string, userId: string, displayName: string, itemId: number): Order {
  return transaction(() => {
    const item = getItem(guildId, itemId);
    if (!item) throw new ShopError("That item isn't in the shop anymore.");
    if (item.stock !== null && item.stock <= 0) throw new ShopError(`**${item.name}** is sold out.`);
    changePoints({ guildId, userId, amount: -item.price, reason: `Bought ${item.name}`, displayName });
    decrementStock.run({ id: item.id });
    return insertOrder.get({
      guildId,
      userId,
      itemId: item.id,
      itemName: item.name,
      price: item.price,
      status: item.role_id ? "delivered" : "pending",
      now: Date.now(),
    }) as unknown as Order;
  });
}

export function getOrder(guildId: string, id: number): Order | undefined {
  return selectOrder.get({ guildId, id }) as Order | undefined;
}

/** Marks a waiting order as delivered. Returns undefined if it was already handled. */
export function markDelivered(guildId: string, id: number, handledBy: string): Order | undefined {
  return transaction(() => {
    if (getOrder(guildId, id)?.status !== "pending") return undefined;
    return finishOrder.get({ guildId, id, status: "delivered", handledBy, now: Date.now() }) as unknown as Order;
  });
}

/** Gives the points back and restocks the item. Returns undefined if it was already refunded. */
export function refundOrder(guildId: string, id: number, handledBy: string): Order | undefined {
  return transaction(() => {
    const order = getOrder(guildId, id);
    if (!order || order.status === "refunded") return undefined;
    changePoints({ guildId, userId: order.user_id, amount: order.price, reason: `Refund: ${order.item_name}`, actorId: handledBy });
    if (order.item_id !== null) incrementStock.run({ id: order.item_id });
    return finishOrder.get({ guildId, id, status: "refunded", handledBy, now: Date.now() }) as unknown as Order;
  });
}

export function memberOrders(guildId: string, userId: string, limit: number): Order[] {
  return selectMemberOrders.all({ guildId, userId, limit }) as unknown as Order[];
}

export function pendingOrders(guildId: string, limit: number): Order[] {
  return selectPendingOrders.all({ guildId, limit }) as unknown as Order[];
}

export function countPendingOrders(guildId: string): number {
  return (selectPendingCount.get({ guildId }) as { count: number }).count;
}
