import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { gatewayAction, registerGatewayCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("gateway").action(action);
  });
  return { gatewayAction: action, registerGatewayCli: register };
});

const { cronAction, registerCronCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const cron = program.command("cron");
    cron.command("status").action(action);
  });
  return { cronAction: action, registerCronCli: register };
});

const hiddenRegistrars = vi.hoisted(() => ({
  registerDaemonCli: vi.fn((program: Command) => program.command("daemon")),
  registerNodesCli: vi.fn((program: Command) => program.command("nodes")),
  registerNodeCli: vi.fn((program: Command) => program.command("node")),
  registerDevicesCli: vi.fn((program: Command) => program.command("devices")),
  registerDnsCli: vi.fn((program: Command) => program.command("dns")),
  registerPairingCli: vi.fn((program: Command) => program.command("pairing")),
  registerPluginCliCommands: vi.fn(),
  loadConfig: vi.fn(async () => ({})),
}));

vi.mock("../gateway-cli.js", () => ({ registerGatewayCli }));
vi.mock("../cron-cli.js", () => ({ registerCronCli }));
vi.mock("../daemon-cli.js", () => ({ registerDaemonCli: hiddenRegistrars.registerDaemonCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli: hiddenRegistrars.registerNodesCli }));
vi.mock("../node-cli.js", () => ({ registerNodeCli: hiddenRegistrars.registerNodeCli }));
vi.mock("../devices-cli.js", () => ({ registerDevicesCli: hiddenRegistrars.registerDevicesCli }));
vi.mock("../dns-cli.js", () => ({ registerDnsCli: hiddenRegistrars.registerDnsCli }));
vi.mock("../pairing-cli.js", () => ({ registerPairingCli: hiddenRegistrars.registerPairingCli }));
vi.mock("../../plugins/cli.js", () => ({
  registerPluginCliCommands: hiddenRegistrars.registerPluginCliCommands,
}));
vi.mock("../../config/config.js", () => ({ loadConfig: hiddenRegistrars.loadConfig }));

const { registerSubCliByName, registerSubCliCommands } = await import("./register.subclis.js");

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAWDBOT_DISABLE_LAZY_SUBCOMMANDS;
    registerGatewayCli.mockClear();
    gatewayAction.mockClear();
    registerCronCli.mockClear();
    cronAction.mockClear();
    Object.values(hiddenRegistrars).forEach((mock) => mock.mockClear());
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
        "daemon",
        "devices",
        "directory",
        "dns",
        "docs",
        "hooks",
        "node",
        "nodes",
        "pairing",
        "plugins",
        "tui",
        "webhooks",
      ]),
    );
    expect(registerGatewayCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    process.argv = ["node", "moltbot", "cron", "status"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["cron"]);

    await program.parseAsync(["cron", "status"], { from: "user" });

    expect(registerCronCli).toHaveBeenCalledTimes(1);
    expect(cronAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    process.argv = ["node", "moltbot", "gateway", "--help"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    await registerSubCliByName(program, "gateway");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "gateway")).toHaveLength(1);

    await program.parseAsync(["gateway"], { from: "user" });
    expect(registerGatewayCli).toHaveBeenCalledTimes(1);
    expect(gatewayAction).toHaveBeenCalledTimes(1);
  });

  it("does not register hidden Stage 2G commands by name", async () => {
    const program = new Command();

    await expect(registerSubCliByName(program, "acp")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "tui")).resolves.toBe(false);
    await expect(registerSubCliByName(program, "channels")).resolves.toBe(false);
  });

  it("does not register hidden Stage 2H commands by default, but loads them by name", async () => {
    process.argv = ["node", "moltbot"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    const hiddenNames = ["daemon", "nodes", "node", "devices", "dns", "pairing"];
    expect(program.commands.map((cmd) => cmd.name())).not.toEqual(
      expect.arrayContaining(hiddenNames),
    );

    for (const name of hiddenNames) {
      await expect(registerSubCliByName(program, name)).resolves.toBe(true);
    }

    expect(program.commands.map((cmd) => cmd.name())).toEqual(expect.arrayContaining(hiddenNames));
  });

  it("does not register the deleted sandbox CLI", async () => {
    process.argv = ["node", "moltbot"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).not.toContain("sandbox");
    await expect(registerSubCliByName(program, "sandbox")).resolves.toBe(false);
  });
});
