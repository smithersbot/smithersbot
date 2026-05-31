import { randomUUID } from "node:crypto";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  listSystemPresence,
  refreshSelfPresence,
  updateSystemPresence,
  upsertPresence,
} from "./system-presence.js";

describe("system-presence", () => {
  it("refreshes self-presence without crashing when os.networkInterfaces() throws (sandbox isolation)", () => {
    const spy = vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses returned Unknown system error 1");
    });
    try {
      // resolvePrimaryIPv4() runs through the safe wrapper and degrades to the
      // hostname instead of throwing; presence stays available.
      expect(() => refreshSelfPresence()).not.toThrow();
      expect(() => listSystemPresence()).not.toThrow();
      expect(listSystemPresence().length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("dedupes entries across sources by case-insensitive instanceId key", () => {
    const instanceIdUpper = `AaBb-${randomUUID()}`.toUpperCase();
    const instanceIdLower = instanceIdUpper.toLowerCase();

    upsertPresence(instanceIdUpper, {
      host: "moltbot",
      mode: "ui",
      instanceId: instanceIdUpper,
      reason: "connect",
    });

    updateSystemPresence({
      text: "Node: Peter-Mac-Studio (10.0.0.1) · ui 2.0.0 · last input 5s ago · mode ui · reason beacon",
      instanceId: instanceIdLower,
      host: "Peter-Mac-Studio",
      ip: "10.0.0.1",
      mode: "ui",
      version: "2.0.0",
      lastInputSeconds: 5,
      reason: "beacon",
    });

    const matches = listSystemPresence().filter(
      (e) => (e.instanceId ?? "").toLowerCase() === instanceIdLower,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.host).toBe("Peter-Mac-Studio");
    expect(matches[0]?.ip).toBe("10.0.0.1");
    expect(matches[0]?.lastInputSeconds).toBe(5);
  });

  it("merges roles and scopes for the same device", () => {
    const deviceId = randomUUID();

    upsertPresence(deviceId, {
      deviceId,
      host: "moltbot",
      roles: ["operator"],
      scopes: ["operator.admin"],
      reason: "connect",
    });

    upsertPresence(deviceId, {
      deviceId,
      roles: ["node"],
      scopes: ["system.run"],
      reason: "connect",
    });

    const entry = listSystemPresence().find((e) => e.deviceId === deviceId);
    expect(entry?.roles).toEqual(expect.arrayContaining(["operator", "node"]));
    expect(entry?.scopes).toEqual(expect.arrayContaining(["operator.admin", "system.run"]));
  });
});
