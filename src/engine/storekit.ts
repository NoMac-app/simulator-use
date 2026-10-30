import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ToolError } from "../errors.ts";
import { simctlAction } from "./apps.ts";

/**
 * StoreKit Testing without Xcode: a .storekit file applied to an app on a phone, as Xcode's Run does, so the app's
 * StoreKit calls (products, purchases, subscriptions) use the file's products in the local "Xcode" environment, with
 * no Apple Account and no change to the app. It lasts until the app is removed: an install over it keeps it.
 * native/skconfig does it from inside the phone (simctl spawn). Purchases complete without iOS's purchase sheet,
 * which is not in the app's accessibility tree. The App Store's sandbox cannot buy in a Simulator (Apple: purchases
 * there need a device), so this is the way to test purchases on one. Checked on iOS 26.5 and 27.0, October 30, 2026.
 */
export function storeKitHelper(): string | undefined {
  const bundled = fileURLToPath(new URL("../../vendor/axe/simulator-use-skconfig", import.meta.url));
  return existsSync(bundled) ? bundled : undefined;
}

/** What is wrong with a .storekit file, or undefined: StoreKit takes any bytes, then answers with no products. */
export function storeKitProblem(path: string): string | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return "there is no such file";
  if (statSync(path).size > 1_000_000) return "it is over 1 MB, more than any StoreKit configuration";
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "it is not a StoreKit configuration (one is JSON, made in Xcode with File > New > File > StoreKit Configuration File)";
  }
  const record = data as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || !("version" in record)) return "it is not a StoreKit configuration (it has no version)";
  if (!["products", "subscriptionGroups", "nonRenewingSubscriptions"].some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length)) {
    return "it has no products or subscriptions";
  }
  return undefined;
}

export async function applyStoreKit(udid: string, bundleId: string, path: string): Promise<void> {
  const helper = storeKitHelper();
  if (!helper) throw new ToolError("This simulator-use has no StoreKit helper.", "Install simulator-use from npm (npx -y simulator-use@latest), which has it.");
  const problem = storeKitProblem(path);
  if (problem) throw new ToolError(`${path}: ${problem}.`, "Pass the .storekit file the app's scheme would use.");
  // The first program a newly booted phone runs can take most of a minute.
  await simctlAction(["spawn", udid, helper, "apply", bundleId, path], "apply the StoreKit configuration", 90_000);
}

export async function removeStoreKit(udid: string, bundleId: string): Promise<void> {
  const helper = storeKitHelper();
  if (!helper) throw new ToolError("This simulator-use has no StoreKit helper.", "Install simulator-use from npm (npx -y simulator-use@latest), which has it.");
  await simctlAction(["spawn", udid, helper, "remove", bundleId], "remove the StoreKit configuration", 90_000);
}
