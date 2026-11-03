import mongoose from "mongoose";
import * as models from "@/models";
import { SYNC_TRACKED_COLLECTIONS } from "./collections";

/**
 * Maps a MongoDB collection name ("sales", "inventorymovements", …) to the
 * compiled mongoose model, so the sync worker can materialise a document and
 * the center can apply one without a hand-written switch per collection.
 *
 * Only collections that appear in the replication policy are registered; the
 * sync bookkeeping collections themselves are deliberately absent.
 */
export type SyncableModel = mongoose.Model<mongoose.Document>;

let cache: Map<string, SyncableModel> | null = null;

export function getModelRegistry(): Map<string, SyncableModel> {
  if (cache) return cache;

  const registry = new Map<string, SyncableModel>();
  for (const candidate of Object.values(models)) {
    if (typeof candidate !== "function") continue;
    const model = candidate as unknown as SyncableModel & { collection?: { name?: string } };
    const name = model.collection?.name;
    if (!name) continue;
    if (!SYNC_TRACKED_COLLECTIONS.includes(name)) continue;
    if (!registry.has(name)) registry.set(name, model);
  }

  cache = registry;
  return registry;
}

export function getModelForCollection(collection: string): SyncableModel | null {
  return getModelRegistry().get(collection) ?? null;
}

export function trackedCollectionNames(): string[] {
  return [...getModelRegistry().keys()];
}

/** Every collection the policy knows about, whether or not a model exists. */
export function knownPolicyCollections(): string[] {
  return SYNC_TRACKED_COLLECTIONS;
}
