import { describe, expect, it } from "vitest";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
    } as any;

    const peers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual([
      "user:u123",
      "user:u234",
      "user:u777",
      "user:u999",
    ]);

    const groups = await listSlackDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["channel:c111"]);
  });

  it("lists Telegram peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
    } as any;

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).sort()).toEqual(["123", "456", "@alice", "@bob"]);

    const groups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["-1001"]);
  });
});
