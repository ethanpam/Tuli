import assert from "node:assert/strict";
import { test } from "node:test";
import { changePoints, getBalance, NotEnoughPointsError } from "../src/features/economy/store.js";
import {
  addItem,
  countPendingOrders,
  findItem,
  getItem,
  markDelivered,
  memberOrders,
  purchase,
  refundOrder,
  searchItems,
  ShopError,
  updateItem,
} from "../src/features/shop/store.js";

const hint = { name: "Trivia hint", description: "One hint at the next GBM", price: 100, roleId: null, stock: null };

test("item names are unique per server, ignoring case", () => {
  addItem("s1", hint);
  assert.throws(() => addItem("s1", { ...hint, name: "TRIVIA HINT" }), ShopError);
  addItem("s2", hint); // other servers are fine
  const other = addItem("s1", { ...hint, name: "Sticker" });
  assert.throws(() => updateItem("s1", other.id, { name: "trivia hint" }), ShopError);
});

test("findItem accepts an ID or a name, and search matches part of a name", () => {
  const item = addItem("s3", { ...hint, name: "VIP Role", roleId: "r1" });
  assert.equal(findItem("s3", String(item.id))?.name, "VIP Role");
  assert.equal(findItem("s3", "vip role")?.id, item.id);
  assert.equal(findItem("s3", "nope"), undefined);
  assert.deepEqual(searchItems("s3", "vip").map((i) => i.id), [item.id]);
  assert.deepEqual(searchItems("s3", "%"), [], "LIKE wildcards are treated as text");
});

test("buying takes points, uses up stock and records the order", () => {
  changePoints({ guildId: "s4", userId: "a", amount: 250, reason: "Start" });
  const item = addItem("s4", { ...hint, stock: 2 });
  const order = purchase("s4", "a", "Alex", item.id);
  assert.equal(order.status, "pending", "prizes wait for staff");
  assert.equal(getBalance("s4", "a"), 150);
  assert.equal(getItem("s4", item.id)?.stock, 1);

  purchase("s4", "a", "Alex", item.id);
  assert.throws(() => purchase("s4", "a", "Alex", item.id), /sold out/);
  assert.equal(getBalance("s4", "a"), 50, "a failed purchase costs nothing");
  assert.equal(countPendingOrders("s4"), 2);
});

test("role items are delivered straight away; you can't buy what you can't afford", () => {
  changePoints({ guildId: "s5", userId: "a", amount: 100, reason: "Start" });
  const role = addItem("s5", { ...hint, name: "Cool role", roleId: "r1", price: 100 });
  assert.equal(purchase("s5", "a", "Alex", role.id).status, "delivered");
  assert.throws(() => purchase("s5", "a", "Alex", role.id), NotEnoughPointsError);
  assert.throws(() => purchase("s5", "a", "Alex", 99999), ShopError);
});

test("refunds return points and stock once; delivered orders can't be delivered again", () => {
  changePoints({ guildId: "s6", userId: "a", amount: 300, reason: "Start" });
  const item = addItem("s6", { ...hint, stock: 5 });
  const first = purchase("s6", "a", "Alex", item.id);
  const second = purchase("s6", "a", "Alex", item.id);

  assert.equal(markDelivered("s6", first.id, "staff")?.status, "delivered");
  assert.equal(markDelivered("s6", first.id, "staff"), undefined, "already handled");

  assert.equal(refundOrder("s6", second.id, "staff")?.status, "refunded");
  assert.equal(refundOrder("s6", second.id, "staff"), undefined, "can't refund twice");
  assert.equal(getBalance("s6", "a"), 200);
  assert.equal(getItem("s6", item.id)?.stock, 4);
  assert.deepEqual(memberOrders("s6", "a", 10).map((o) => o.status), ["refunded", "delivered"]);
});

test("editing keeps unchanged fields and can make stock unlimited", () => {
  const item = addItem("s7", { ...hint, stock: 3 });
  const edited = updateItem("s7", item.id, { price: 150, stock: null });
  assert.deepEqual([edited.name, edited.price, edited.stock, edited.description], ["Trivia hint", 150, null, hint.description]);
});
