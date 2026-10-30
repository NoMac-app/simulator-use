import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { storeKitProblem } from "../src/engine/storekit.ts";
import { appControl } from "../src/tools/app-control.ts";

test("a .storekit file is checked before StoreKit takes it (it takes any bytes, then answers with no products)", () => {
  const dir = mkdtempSync(join(tmpdir(), "storekit-"));
  const file = (name: string, body: string) => (writeFileSync(join(dir, name), body), join(dir, name));
  const good = { identifier: "A", products: [{ productID: "com.example.pro", type: "NonConsumable" }], settings: {}, version: { major: 4, minor: 0 } };
  assert.equal(storeKitProblem(file("good.storekit", JSON.stringify(good))), undefined);
  assert.equal(storeKitProblem(file("subs.storekit", JSON.stringify({ version: { major: 4 }, subscriptionGroups: [{ id: "1" }] }))), undefined);
  assert.equal(storeKitProblem(join(dir, "missing.storekit")), "there is no such file");
  assert.match(storeKitProblem(file("text.storekit", "products: pro"))!, /^it is not a StoreKit configuration \(one is JSON/);
  assert.equal(storeKitProblem(file("bare.storekit", "{}")), "it is not a StoreKit configuration (it has no version)");
  assert.equal(storeKitProblem(file("empty.storekit", JSON.stringify({ version: { major: 4 }, products: [] }))), "it has no products or subscriptions");
});

test("StoreKit is an app_control action", () => {
  const actions = (appControl.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum!;
  assert.ok(actions.includes("storekit"));
});
