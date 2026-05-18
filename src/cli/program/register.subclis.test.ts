import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { gatewayAction, registerGatewayCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("gateway").action(action);
  });
  return { gatewayAction: action, registerGatewayCli: register };
});

const { nodesAction, registerNodesCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const nodes = program.command("nodes");
    nodes.command("list").action(action);
  });
  return { nodesAction: action, registerNodesCli: register };
});

vi.mock("../gateway-cli.js", () => ({ registerGatewayCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));

const { registerSubCliByName, registerSubCliCommands } = await import("./register.subclis.js");

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAWDBOT_DISABLE_LAZY_SUBCOMMANDS;
    registerGatewayCli.mockClear();
    gatewayAction.mockClear();
    registerNodesCli.mockClear();
    nodesAction.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  it("registers only the primary placeholder and dispatches", async () => {
    process.argv = ["node", "moltbot", "gateway"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["gateway"]);

    await program.parseAsync(process.argv);

    expect(registerGatewayCli).toHaveBeenCalledTimes(1);
    expect(gatewayAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    process.argv = ["node", "moltbot"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("gateway");
    expect(names).not.toEqual(
      expect.arrayContaining([
        "acp",
        "channels",
        "directory",
        "docs",
        "hooks",
        "plugins",
        "tui",
        "webhooks",
      ]),
    );
    expect(registerGatewayCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    process.argv = ["node", "moltbot", "nodes", "list"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    process.argv = ["node", "moltbot", "gateway", "--help"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    await registerSubCliByName(program, "gateway");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "gateway")).toHaveLength(1);

    await program.parseAsync(["node", "moltbot", "gateway"], { from: "user" });
    expect(registerGatewayCli).toHaveBeenCalledTimes(1);
    expect(gatewayAction).toHaveBeenCalledTimes(1);
  });

  it("does not register hidden Stage 2G commands by name", async () => {
    const program = new Command();

    await expect(registerSubCliByName(program, "acp")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "tui")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "channels")).resolves.toBe(false);
  });

  it("does not register the deleted sandbox CLI", async () => {
    process.argv = ["node", "moltbot"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).not.toContain("sandbox");
    await expect(registerSubCliByName(program, "sandbox")).resolves.toBe(false);
  });
});
