import { describe, expect, it } from "vitest";
import { renderMermaidToPng } from "./mermaid-png.js";

// PNG rendering requires mmdc + a headless Chrome/Chromium install.
// Gate behind MOLTBOT_TEST_MERMAID_PNG=1 so CI doesn't fail without Chromium.
const canRender = process.env.MOLTBOT_TEST_MERMAID_PNG === "1";

describe("renderMermaidToPng", () => {
  it.skipIf(!canRender)("renders a simple graph to a PNG buffer", () => {
    const mermaid = "graph TD\n  A --> B";
    const result = renderMermaidToPng(mermaid);
    expect(result).not.toBeNull();
    // PNG magic bytes: \x89PNG
    expect(result![0]).toBe(0x89);
    expect(result![1]).toBe(0x50); // P
    expect(result![2]).toBe(0x4e); // N
    expect(result![3]).toBe(0x47); // G
  });

  it("returns null on failure (no Chromium or invalid syntax)", () => {
    const result = renderMermaidToPng("not a valid mermaid diagram {{{{");
    expect(result).toBeNull();
  });
});
