import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addEvent,
  findUpcomingEvents,
  removeEvent,
  STILL_HAPPENING_MS,
  upcomingEvents,
} from "../src/features/events/store.js";

const event = (title: string, startsAt: number) => ({
  title,
  starts_at: startsAt,
  location: "MU",
  description: "",
  link: "",
  created_by: "staff",
});

test("upcoming events are soonest first and include ones still happening", () => {
  const now = Date.parse("2026-10-06T14:00:00Z");
  addEvent("e1", event("Later", now + 7 * 86_400_000));
  addEvent("e1", event("Sooner", now + 86_400_000));
  addEvent("e1", event("Happening now", now - 60 * 60 * 1000));
  addEvent("e1", event("Long over", now - STILL_HAPPENING_MS - 1));
  addEvent("e2", event("Other server", now + 1000));
  assert.deepEqual(
    upcomingEvents("e1", 10, now).map((e) => e.title),
    ["Happening now", "Sooner", "Later"],
  );
  assert.deepEqual(
    upcomingEvents("e1", 1, now).map((e) => e.title),
    ["Happening now"],
  );
});

test("events can be found by title and removed", () => {
  const now = Date.now();
  const gbm = addEvent("e3", event("GBM #3: Mooncake Night", now + 86_400_000));
  addEvent("e3", event("Boba social", now + 2 * 86_400_000));
  assert.deepEqual(
    findUpcomingEvents("e3", "mooncake").map((e) => e.id),
    [gbm.id],
  );
  assert.equal(findUpcomingEvents("e3", "%").length, 0, "wildcards are matched literally");
  removeEvent("e3", gbm.id);
  assert.deepEqual(
    upcomingEvents("e3").map((e) => e.title),
    ["Boba social"],
  );
});
