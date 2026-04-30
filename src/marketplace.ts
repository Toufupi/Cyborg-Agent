import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addTool, readToolFile } from "./registry.js";

const MarketplaceEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().max(240).optional(),
  category: z.string().min(1).default("general"),
  registration: z.string().min(1),
  tags: z.array(z.string().min(1)).default([])
});

const MarketplaceSchema = z.object({
  schema: z.literal("cyborg.marketplace.v0.1"),
  name: z.string().min(1),
  description: z.string().max(500).optional(),
  tools: z.array(MarketplaceEntrySchema).default([])
});

export type Marketplace = z.output<typeof MarketplaceSchema>;
export type MarketplaceEntry = z.output<typeof MarketplaceEntrySchema>;

export async function loadMarketplace(file: string) {
  const marketplaceFile = path.resolve(file);
  const marketplace = MarketplaceSchema.parse(JSON.parse(await readFile(marketplaceFile, "utf8")));
  return { file: marketplaceFile, marketplace };
}

export async function listMarketplaceTools(file: string) {
  const loaded = await loadMarketplace(file);
  return loaded.marketplace.tools.map((entry) => ({
    ...entry,
    registration: resolveRegistrationPath(loaded.file, entry.registration)
  }));
}

export async function installMarketplaceTool(file: string, name: string, root = process.cwd(), alias?: string) {
  const loaded = await loadMarketplace(file);
  const entry = loaded.marketplace.tools.find((item) => item.name === name);
  if (!entry) {
    throw new Error(`Marketplace '${loaded.marketplace.name}' does not contain tool '${name}'.`);
  }
  if (/^https?:\/\//i.test(entry.registration)) {
    throw new Error("Remote marketplace registration URLs are not supported yet. Use a local registration path.");
  }
  const registrationFile = resolveRegistrationPath(loaded.file, entry.registration);
  const registration = await readToolFile(registrationFile);
  const added = await addTool(registrationFile, root, alias);
  return {
    marketplace: loaded.marketplace.name,
    entry,
    registration,
    added
  };
}

function resolveRegistrationPath(marketplaceFile: string, registration: string) {
  if (path.isAbsolute(registration) || /^https?:\/\//i.test(registration)) {
    return registration;
  }
  return path.resolve(path.dirname(marketplaceFile), registration);
}
