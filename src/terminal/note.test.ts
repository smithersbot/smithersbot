import { afterEach, describe, expect, it, vi } from "vitest";

const { clackNote } = vi.hoisted(() => ({ clackNote: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  note: clackNote,
}));

import { setJsonOutputMode } from "../globals.js";
import { note } from "./note.js";

describe("note", () => {
  afterEach(() => {
    setJsonOutputMode(false);
    clackNote.mockReset();
    vi.restoreAllMocks();
  });

  it("writes notes to stderr in JSON output mode without touching stdout", () => {
    setJsonOutputMode(true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    note("Doctor config needs attention", "Doctor");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Doctor config needs attention");
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Doctor");
    expect(stdout).not.toHaveBeenCalled();
    expect(clackNote).not.toHaveBeenCalled();
  });

  it("keeps human notes on the clack stdout path when JSON output mode is off", () => {
    setJsonOutputMode(false);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    note("Human-readable warning", "Doctor");

    expect(stderr).not.toHaveBeenCalled();
    expect(clackNote).toHaveBeenCalledWith("Human-readable warning", "Doctor");
  });
});
