import type { Feature } from "../types.js";
import { createAdminFeature } from "./admin.js";
import { greetFeature } from "./greet.js";
import { helpFeature } from "./help.js";
import { quotesFeature } from "./quotes/index.js";

// Every part of Tuli, in the order they see each message.
const baseFeatures: Feature[] = [helpFeature, greetFeature, quotesFeature];

const adminGroups = baseFeatures.flatMap((feature) => (feature.admin ? [feature.admin] : []));

export const features: Feature[] = adminGroups.length
  ? [...baseFeatures, createAdminFeature(adminGroups)]
  : baseFeatures;
