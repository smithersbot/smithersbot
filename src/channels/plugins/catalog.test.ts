import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries } from "./catalog.js";

describe("channel plugin catalog", () => {
  it("resolves a single entry from an external catalog", () => {
    // msteams is no longer a bundled channel plugin; entries like it now come
    // from external catalog files rather than built-in discovery.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-catalog-"));
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@moltbot/msteams",
            moltbot: {
              channel: {
                id: "msteams",
                label: "Microsoft Teams",
                selectionLabel: "Microsoft Teams (Bot Framework)",
                docsPath: "/channels/msteams",
                blurb: "Bot Framework; enterprise support.",
                aliases: ["teams"],
              },
              install: {
                npmSpec: "@moltbot/msteams",
              },
            },
          },
        ],
      }),
    );

    const entry = getChannelPluginCatalogEntry("msteams", { catalogPaths: [catalogPath] });
    expect(entry?.install.npmSpec).toBe("@moltbot/msteams");
    expect(entry?.meta.aliases).toContain("teams");
  });

  it("includes external catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-catalog-"));
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@moltbot/demo-channel",
            moltbot: {
              channel: {
                id: "demo-channel",
                label: "Demo Channel",
                selectionLabel: "Demo Channel",
                docsPath: "/channels/demo-channel",
                blurb: "Demo entry",
                order: 999,
              },
              install: {
                npmSpec: "@moltbot/demo-channel",
              },
            },
          },
        ],
      }),
    );

    const ids = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] }).map(
      (entry) => entry.id,
    );
    expect(ids).toContain("demo-channel");
  });
});
