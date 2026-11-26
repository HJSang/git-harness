import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "./types.ts";

const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface CommandExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  shellBin: string;
}

export interface CommandExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorMessage?: string;
}

/** Optional pluggable command execution boundary (e.g., OS sandbox adapter `sandbox-exec` / `bwrap`). */
export type CommandExecutor = (req: CommandExecRequest) => Promise<CommandExecResult>;

export interface CoreToolsOptions {
  /** Prevent read/write/edit from escaping `workspaceRoot` (default: true). */
  enforceWorkspaceBoundary?: boolean;
  /** Maximum characters returned from read/bash outputs before truncation (default: 32000). */
  maxOutputChars?: number;
  /** Default shell timeout in milliseconds (default: 30000). */
  bashTimeoutMs?: number;
  /** Optional Git blob reader enabling `read({ path: "blob://<sha>", startLine, endLine })`. */
  readBlob?: (sha: string) => Uint8Array;
  /** Optional Git commit file reader enabling `read({ path: "commit://<sha>/<relPath>", startLine, endLine })`. */
  readCommitFile?: (sha: string, relPath: string) => Uint8Array | null;
  /** Optional skill file reader enabling `read({ path: "skill://<name>/SKILL.md", startLine, endLine })`. */
  readSkillFile?: (skillName: string, relPath: string) => Uint8Array | null;
  /** Optional custom command runner for `bash` (e.g. `createOsSandboxExecutor`). */
  execCommand?: CommandExecutor;
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    `\n... [truncated ${text.length - maxChars} chars] ...\n` +
    text.slice(text.length - tail)
  );
}

function resolveSafePath(
  workspaceRoot: string,
  targetPath: string,
  enforceBoundary: boolean,
): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  if (enforceBoundary) {
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace root: ${targetPath}`);
    }
  }
  return resolved;
}

/**
 * Minimal Pi-style 4-tool core (`read`, `write`, `edit`, `bash`).
 * Deliberately concise schemas to keep Turn-0 prompt tax well below P0-7 (< 1,500 tokens).
 */
export function createCoreTools(options?: CoreToolsOptions): Tool[] {
  const enforceBoundary = options?.enforceWorkspaceBoundary ?? true;
  const maxOutputChars = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const defaultTimeoutMs = options?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const readBlob = options?.readBlob;
  const readCommitFile = options?.readCommitFile;
  const readSkillFile = options?.readSkillFile;
  const execCommand = options?.execCommand;
  const shellBin = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

  const readTool: Tool = {
    readOnly: true,
    schema: {
      name: "read",
      description:
        "Read a UTF-8 file, image (.png/.jpg/.webp/.gif), 'blob://<sha>', 'commit://<sha>/<path>', or 'skill://<name>/SKILL.md' with optional 1-based line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, 'blob://<sha>', 'commit://<sha>/<path>', or 'skill://<name>/<path>'" },
          startLine: { type: "number", description: "Optional 1-based start line" },
          endLine: { type: "number", description: "Optional 1-based end line (inclusive)" },
        },
        required: ["path"],
      },
    },
    execute(args, ctx): ToolResult {
      try {
        const rel = String(args.path ?? "");
        let raw: string;
        if (rel.startsWith("blob://")) {
          if (!readBlob) {
            return { output: "read error: blob:// reading is not configured", isError: true };
          }
          const sha = rel.slice("blob://".length).trim();
          raw = Buffer.from(readBlob(sha)).toString("utf8");
        } else if (rel.startsWith("commit://")) {
          if (!readCommitFile) {
            return { output: "read error: commit:// reading is not configured", isError: true };
          }
          const rest = rel.slice("commit://".length);
          const slashIdx = rest.indexOf("/");
          if (slashIdx === -1) {
            return { output: "read error: expected commit://<sha>/<path>", isError: true };
          }
          const sha = rest.slice(0, slashIdx).trim();
          const innerPath = rest.slice(slashIdx + 1).trim();
          const data = readCommitFile(sha, innerPath);
          if (!data) {
            return { output: `read error: path '${innerPath}' not found in commit ${sha}`, isError: true };
          }
          raw = Buffer.from(data).toString("utf8");
        } else if (rel.startsWith("skill://")) {
          if (!readSkillFile) {
            return { output: "read error: skill:// reading is not configured", isError: true };
          }
          const rest = rel.slice("skill://".length).replace(/^\/+/, "");
          const slashIdx = rest.indexOf("/");
          const skillName = (slashIdx === -1 ? rest : rest.slice(0, slashIdx)).trim();
          const innerPath = (slashIdx === -1 ? "SKILL.md" : rest.slice(slashIdx + 1)).trim() || "SKILL.md";
          const data = readSkillFile(skillName, innerPath);
          if (!data) {
            return { output: `read error: skill file '${skillName}/${innerPath}' not found`, isError: true };
          }
          raw = Buffer.from(data).toString("utf8");
        } else {
          const abs = resolveSafePath(ctx.workspaceRoot, rel, enforceBoundary);
          const ext = path.extname(abs).toLowerCase();
          const imageMime = IMAGE_MIME_BY_EXT[ext];
          if (imageMime) {
            const stat = fs.statSync(abs);
            if (stat.size > MAX_IMAGE_READ_BYTES) {
              return {
                output: `read error: image '${rel}' is ${stat.size} bytes (exceeds ${MAX_IMAGE_READ_BYTES} byte limit)`,
                isError: true,
              };
            }
            const buf = fs.readFileSync(abs);
            return {
              output: `[Image file: ${rel} (${imageMime}, ${buf.length} bytes)]`,
              images: [{ mimeType: imageMime, data: buf.toString("base64") }],
            };
          }
          raw = fs.readFileSync(abs, "utf8");
        }
        const lines = raw.split("\n");
        const start = Math.max(1, Number(args.startLine ?? 1));
        const end = Math.min(lines.length, Number(args.endLine ?? lines.length));
        const slice = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}: ${line}`)
          .join("\n");
        return { output: truncateOutput(slice, maxOutputChars) };
      } catch (err) {
        return { output: `read error: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const writeTool: Tool = {
    schema: {
      name: "write",
      description: "Create or overwrite a file with UTF-8 content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
    execute(args, ctx): ToolResult {
      try {
        const rel = String(args.path ?? "");
        const content = String(args.content ?? "");
        const abs = resolveSafePath(ctx.workspaceRoot, rel, enforceBoundary);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        return { output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}` };
      } catch (err) {
        return { output: `write error: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const editTool: Tool = {
    schema: {
      name: "edit",
      description: "Replace an exact text snippet inside an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          oldText: { type: "string", description: "Exact substring to replace" },
          newText: { type: "string", description: "Replacement substring" },
          replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
    execute(args, ctx): ToolResult {
      try {
        const rel = String(args.path ?? "");
        const oldText = String(args.oldText ?? "");
        const newText = String(args.newText ?? "");
        const replaceAll = Boolean(args.replaceAll ?? false);
        if (!oldText) {
          return { output: "edit error: oldText must be non-empty", isError: true };
        }
        const abs = resolveSafePath(ctx.workspaceRoot, rel, enforceBoundary);
        const content = fs.readFileSync(abs, "utf8");
        const firstIdx = content.indexOf(oldText);
        if (firstIdx === -1) {
          return { output: `edit error: oldText not found in ${rel}`, isError: true };
        }
        if (!replaceAll && content.indexOf(oldText, firstIdx + oldText.length) !== -1) {
          return {
            output: `edit error: oldText matched multiple locations in ${rel}; pass replaceAll=true or provide more context`,
            isError: true,
          };
        }
        const updated = replaceAll
          ? content.split(oldText).join(newText)
          : content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length);
        fs.writeFileSync(abs, updated, "utf8");
        return { output: `edited ${rel}` };
      } catch (err) {
        return { output: `edit error: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const bashTool: Tool = {
    schema: {
      name: "bash",
      description: "Run a shell command in the workspace root and return stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeoutMs: { type: "number", description: "Optional timeout in ms" },
        },
        required: ["command"],
      },
    },
    async execute(args, ctx: ToolExecutionContext): Promise<ToolResult> {
      const command = String(args.command ?? "");
      const timeout = Number(args.timeoutMs ?? defaultTimeoutMs);
      if (execCommand) {
        const res = await execCommand({
          command,
          cwd: ctx.workspaceRoot,
          timeoutMs: timeout,
          signal: ctx.signal,
          shellBin,
        });
        const combined = [res.stdout, res.stderr ? `[stderr]\n${res.stderr}` : ""]
          .filter(Boolean)
          .join("\n")
          .trim();
        if (res.exitCode !== 0) {
          return {
            output: truncateOutput(
              `exit ${res.exitCode}${combined ? `\n${combined}` : res.errorMessage ? `\n${res.errorMessage}` : ""}`,
              maxOutputChars,
            ),
            isError: true,
          };
        }
        return {
          output: truncateOutput(combined || "(exit 0, no output)", maxOutputChars),
        };
      }
      return new Promise((resolve) => {
        execFile(
          shellBin,
          ["-c", command],
          {
            cwd: ctx.workspaceRoot,
            timeout,
            maxBuffer: 16 * 1024 * 1024,
            signal: ctx.signal,
          },
          (error, stdout, stderr) => {
            const combined = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
              .filter(Boolean)
              .join("\n")
              .trim();
            if (error) {
              const code = typeof error.code === "number" ? error.code : 1;
              resolve({
                output: truncateOutput(
                  `exit ${code}${combined ? `\n${combined}` : `\n${error.message}`}`,
                  maxOutputChars,
                ),
                isError: true,
              });
              return;
            }
            resolve({
              output: truncateOutput(combined || "(exit 0, no output)", maxOutputChars),
            });
          },
        );
      });
    },
  };

  return [readTool, writeTool, editTool, bashTool];
}
