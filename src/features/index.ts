import type { Feature } from "../types.js";
import { createAdminFeature } from "./admin.js";
import { economyFeature, pointsBoard } from "./economy/index.js";
import { greetFeature } from "./greet.js";
import { helpFeature } from "./help.js";
import { createLeaderboardFeature } from "./leaderboard.js";
import { levelsBoard, levelsFeature } from "./levels/index.js";
import { questionsFeature } from "./questions/index.js";
import { quotesFeature } from "./quotes/index.js";
import { createSetupFeature } from "./setup.js";
import { shopFeature } from "./shop/index.js";

// Every part of Tuli, in the order they see each message.
const baseFeatures: Feature[] = [
  createSetupFeature(() => features),
  helpFeature,
  greetFeature,
  quotesFeature,
  economyFeature,
  levelsFeature,
  shopFeature,
  questionsFeature,
  createLeaderboardFeature([levelsBoard, pointsBoard]),
];

const adminGroups = baseFeatures.flatMap((feature) => (feature.admin ? [feature.admin] : []));

export const features: Feature[] = [...baseFeatures, createAdminFeature(adminGroups)];
