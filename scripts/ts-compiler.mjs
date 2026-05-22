import fs from "node:fs";
import path from "node:path";

const executableExtensions = (platform, env) => {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT || env.PathExt || ".COM;.EXE;.BAT;.CMD";
  const extensions = raw
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return ["", ...extensions];
};

const isExecutableFile = (filePath, platform) => {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const candidatePaths = (command, directory, platform, env) => {
  const hasExtension = path.extname(command) !== "";
  const extensions = hasExtension ? [""] : executableExtensions(platform, env);
  return extensions.map((extension) => path.join(directory, `${command}${extension}`));
};

export const resolveExecutable = (command, { cwd, env = process.env, platform = process.platform }) => {
  if (!command) return null;

  const hasPathSeparator =
    command.includes("/") || command.includes("\\") || path.isAbsolute(command);

  if (hasPathSeparator) {
    const commandPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    const directory = path.dirname(commandPath);
    const basename = path.basename(commandPath);
    for (const candidatePath of candidatePaths(basename, directory, platform, env)) {
      if (isExecutableFile(candidatePath, platform)) return candidatePath;
    }
    return null;
  }

  const localBin = path.join(cwd, "node_modules", ".bin");
  const pathValue = env.PATH || env.Path || env.path || "";
  const pathEntries = pathValue
    .split(path.delimiter)
    .filter(Boolean);

  for (const directory of [localBin, ...pathEntries]) {
    for (const candidatePath of candidatePaths(command, directory, platform, env)) {
      if (isExecutableFile(candidatePath, platform)) return candidatePath;
    }
  }

  return null;
};

export const resolveTypeScriptCompiler = ({
  cwd,
  env = process.env,
  platform = process.platform,
}) => {
  const explicitCompiler = env.CLAWDBOT_TS_COMPILER;
  if (explicitCompiler) {
    const resolvedPath = resolveExecutable(explicitCompiler, { cwd, env, platform });
    if (!resolvedPath) {
      return {
        ok: false,
        compiler: explicitCompiler,
        explicit: true,
        message:
          `TypeScript compiler "${explicitCompiler}" was requested via ` +
          "CLAWDBOT_TS_COMPILER, but it was not found in node_modules/.bin or PATH.",
      };
    }
    return { ok: true, compiler: explicitCompiler, explicit: true, resolvedPath };
  }

  const tsgoPath = resolveExecutable("tsgo", { cwd, env, platform });
  if (tsgoPath) {
    return { ok: true, compiler: "tsgo", explicit: false, resolvedPath: tsgoPath };
  }

  return {
    ok: true,
    compiler: "tsc",
    explicit: false,
    resolvedPath: resolveExecutable("tsc", { cwd, env, platform }),
  };
};
