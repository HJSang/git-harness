import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CommandExecRequest, CommandExecResult, CommandExecutor } from "../runtime/tools.ts";

export type SandboxBackend = "seatbelt" | "bwrap" | "none";

export interface OsSandboxOptions {
  /** Workspace root permitted for read/write access inside the sandbox. */
  workspaceRoot: string;
  /** Additional host directories permitted for write access (e.g. cache or temp dirs). */
  extraWritablePaths?: string[];
  /** Allow outbound/inbound network access inside sandboxed commands (default: true). */
  allowNetwork?: boolean;
  /** Force a specific backend or auto-detect (`seatbelt` on macOS, `bwrap` on Linux). */
  backend?: "auto" | "seatbelt" | "bwrap";
  /** Fail closed if no OS sandbox backend is available (default: true). */
  required?: boolean;
}

function escapeSbplString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function expandPathVariants(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const resolved = path.resolve(p);
    out.add(resolved);
    try {
      out.add(fs.realpathSync(resolved));
    } catch {
      // Path may not exist yet; keep resolved form.
    }
  }
  return [...out];
}

/**
 * Detect available kernel/OS sandboxing backend on the current host.
 * - macOS: `/usr/bin/sandbox-exec` (Seatbelt SBPL)
 * - Linux: `bwrap` (bubblewrap mount/network namespaces)
 */
export function detectAvailableSandbox(platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return "seatbelt";
  }
  if (platform === "linux") {
    try {
      execFileSync("bwrap", ["--version"], { stdio: "ignore" });
      return "bwrap";
    } catch {
      return "none";
    }
  }
  return "none";
}

/**
 * Build a minimal macOS Seatbelt (SBPL) profile that permits reads broadly for toolchains
 * while restricting filesystem writes strictly to `writablePaths` + `/dev/null` & stdio devices,
 * and optionally denying all network access.
 */
export function buildSeatbeltProfile(options: {
  writablePaths: string[];
  allowNetwork: boolean;
}): string {
  const expanded = expandPathVariants(options.writablePaths);
  const rules: string[] = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))',
  ];
  for (const dir of expanded) {
    rules.push(`(allow file-write* (subpath "${escapeSbplString(dir)}"))`);
  }
  if (!options.allowNetwork) {
    rules.push("(deny network*)");
  }
  return rules.join("\n") + "\n";
}

/**
 * Build Linux `bwrap` (bubblewrap) arguments binding `/` read-only,
 * `workspaceRoot` + `extraWritablePaths` read-write, and optionally unsharing network.
 */
export function buildBwrapArgs(options: {
  workspaceRoot: string;
  cwd: string;
  extraWritablePaths?: string[];
  allowNetwork: boolean;
  shellBin: string;
  command: string;
}): string[] {
  const ws = path.resolve(options.workspaceRoot);
  const cwd = path.resolve(options.cwd);
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    ws,
    ws,
  ];
  for (const extra of options.extraWritablePaths ?? []) {
    const resolved = path.resolve(extra);
    if (resolved !== ws) {
      args.push("--bind", resolved, resolved);
    }
  }
  if (!options.allowNetwork) {
    args.push("--unshare-net");
  }
  args.push("--chdir", cwd, "--", options.shellBin, "-c", options.command);
  return args;
}

function runDirect(req: CommandExecRequest): Promise<CommandExecResult> {
  return new Promise((resolve) => {
    execFile(
      req.shellBin,
      ["-c", req.command],
      {
        cwd: req.cwd,
        timeout: req.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        signal: req.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout,
            stderr,
            exitCode: typeof error.code === "number" ? error.code : 1,
            errorMessage: error.message,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

/**
 * Create a pluggable OS-sandboxed `CommandExecutor` for Layer 2's `bash` tool.
 * Enforces workspace write containment (and optional network isolation) at the OS kernel level
 * using macOS `sandbox-exec` or Linux `bwrap`, with zero external npm dependencies.
 */
export function createOsSandboxExecutor(options: OsSandboxOptions): CommandExecutor {
  const allowNetwork = options.allowNetwork ?? true;
  const required = options.required ?? true;
  const backend: SandboxBackend =
    options.backend && options.backend !== "auto" ? options.backend : detectAvailableSandbox();

  if (backend === "none") {
    if (required) {
      throw new Error(
        `No OS sandbox backend available on platform '${process.platform}' (expected macOS sandbox-exec or Linux bwrap).`,
      );
    }
    return runDirect;
  }

  const workspaceRoot = path.resolve(options.workspaceRoot);
  const extraWritablePaths = (options.extraWritablePaths ?? []).map((p) => path.resolve(p));

  return (req: CommandExecRequest): Promise<CommandExecResult> => {
    const writablePaths = [workspaceRoot, ...extraWritablePaths];

    let bin: string;
    let binArgs: string[];
    if (backend === "seatbelt") {
      const profile = buildSeatbeltProfile({ writablePaths, allowNetwork });
      bin = "/usr/bin/sandbox-exec";
      binArgs = ["-p", profile, req.shellBin, "-c", req.command];
    } else {
      bin = "bwrap";
      binArgs = buildBwrapArgs({
        workspaceRoot,
        cwd: req.cwd,
        extraWritablePaths,
        allowNetwork,
        shellBin: req.shellBin,
        command: req.command,
      });
    }

    return new Promise((resolve) => {
      execFile(
        bin,
        binArgs,
        {
          cwd: req.cwd,
          timeout: req.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          signal: req.signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              stdout,
              stderr,
              exitCode: typeof error.code === "number" ? error.code : 1,
              errorMessage: error.message,
            });
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    });
  };
}
