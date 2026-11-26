import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ObjectStore, Sha, TreeEntry } from "../git-store/types.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";
import type {
  SkillGate,
  SkillMeta,
  SkillPromoteResult,
  SkillProposal,
  SkillSourceKind,
  SkillStoreOptions,
  SkillWriteInput,
} from "./types.ts";

export const SKILLS_REF = "refs/harness/skills";
export const SKILL_PROPOSAL_PREFIX = "refs/harness/skill-proposals/";

const decoder = new TextDecoder("utf-8");

function normalizeRelPath(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
  if (!clean || clean.split("/").some((seg) => seg === ".." || seg === ".")) {
    throw new Error(`Invalid skill relative path: ${p}`);
  }
  return clean;
}

function normalizeSkillName(name: string): string {
  const clean = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clean)) {
    throw new Error(`Invalid skill name: "${name}"`);
  }
  return clean;
}

/** Built-in gate: ensures `SKILL.md` exists and has valid `name` + `description` YAML frontmatter. */
export function validSkillFrontmatterGate(): SkillGate {
  return {
    name: "valid-frontmatter",
    check(proposal) {
      const mainFile = proposal.files.find((f) => f.path === "SKILL.md");
      if (!mainFile) {
        return { passed: false, reason: "Skill proposal is missing SKILL.md" };
      }
      const parsed = parseSkillFrontmatter(mainFile.content);
      if (!parsed) {
        return {
          passed: false,
          reason: "SKILL.md must begin with YAML frontmatter containing non-empty 'name' and 'description'",
        };
      }
      if (parsed.name !== proposal.skillName) {
        return {
          passed: false,
          reason: `Frontmatter name "${parsed.name}" does not match skillName "${proposal.skillName}"`,
        };
      }
      return { passed: true };
    },
  };
}

/** Built-in anti-poisoning gate: blocks secrets/keys before entering `refs/harness/skills`. */
export function noSkillSecretsGate(): SkillGate {
  const patterns: Array<{ label: string; regex: RegExp }> = [
    { label: "private key header", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
    { label: "API secret key", regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  ];
  return {
    name: "no-secrets",
    check(proposal) {
      for (const f of proposal.files) {
        for (const p of patterns) {
          if (p.regex.test(f.content)) {
            return { passed: false, reason: `Detected ${p.label} in ${f.path}` };
          }
        }
      }
      return { passed: true };
    },
  };
}

/** Built-in anti-poisoning gate: rejects skill proposals sourced from abandoned/dropped branches. */
export function nonAbandonedSkillSourceGate(store: ObjectStore): SkillGate {
  return {
    name: "non-abandoned-source",
    check(proposal) {
      if (proposal.sourceRef?.startsWith("refs/harness/abandoned/")) {
        return { passed: false, reason: `Source ref is abandoned: ${proposal.sourceRef}` };
      }
      if (proposal.sourceRef && store.readRef(proposal.sourceRef) === null) {
        return { passed: false, reason: `Source ref does not exist: ${proposal.sourceRef}` };
      }
      return { passed: true };
    },
  };
}

/**
 * Layer 4b (`skills`) — Unified Git-native + filesystem `SKILL.md` store.
 *
 * Discovery precedence (first match wins):
 * 1. Git-versioned skills on `refs/harness/skills`
 * 2. Workspace roots (`.agents/skills`, `.claude/skills`, `.skills`) + `extraDirs`
 * 3. Global roots (`~/.git-harness/skills`, `~/.pi/agent/skills`)
 */
export class SkillStore {
  private readonly store: ObjectStore;
  public readonly ref: string;
  private readonly fsRoots: Array<{ dir: string; source: SkillSourceKind }>;

  constructor(store: ObjectStore, options?: SkillStoreOptions) {
    this.store = store;
    this.ref = options?.ref ?? SKILLS_REF;
    this.fsRoots = [];

    if (options?.workspaceRoot) {
      const root = path.resolve(options.workspaceRoot);
      for (const rel of [".agents/skills", ".claude/skills", ".skills"]) {
        this.fsRoots.push({ dir: path.join(root, rel), source: "workspace" });
      }
    }
    for (const extra of options?.extraDirs ?? []) {
      this.fsRoots.push({ dir: path.resolve(extra), source: "workspace" });
    }
    if (options?.includeGlobalDirs ?? true) {
      const home = os.homedir();
      this.fsRoots.push({ dir: path.join(home, ".git-harness", "skills"), source: "global" });
      this.fsRoots.push({ dir: path.join(home, ".pi", "agent", "skills"), source: "global" });
    }
  }

  /** Current commit SHA of `refs/harness/skills`, or null if no Git skills committed yet. */
  readSkillsSha(): Sha | null {
    return this.store.readRef(this.ref);
  }

  /** List all discovered skills (deduplicated by precedence: git > workspace > global). */
  list(): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();

    // 1. Git-backed skills (`refs/harness/skills`)
    const head = this.store.readRef(this.ref);
    if (head) {
      const commit = this.store.readCommit(head);
      for (const entry of this.store.readTree(commit.tree)) {
        if (entry.type !== "tree") continue;
        const skillMd = this.store.resolvePath(entry.sha, "SKILL.md");
        if (!skillMd || skillMd.type !== "blob") continue;
        const parsed = parseSkillFrontmatter(decoder.decode(this.store.readBlob(skillMd.sha)));
        if (!parsed) continue;
        byName.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          source: "git",
          location: this.ref,
          sha: head,
        });
      }
    }

    // 2. Filesystem roots (workspace -> global)
    for (const root of this.fsRoots) {
      if (!fs.existsSync(root.dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const skillDir = path.join(root.dir, ent.name);
        const skillMdPath = path.join(skillDir, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;
        try {
          const parsed = parseSkillFrontmatter(fs.readFileSync(skillMdPath, "utf8"));
          if (!parsed || byName.has(parsed.name)) continue;
          byName.set(parsed.name, {
            name: parsed.name,
            description: parsed.description,
            source: root.source,
            location: skillDir,
          });
        } catch {
          // Skip unreadable skill files cleanly
        }
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read any file inside a skill (`SKILL.md`, `references/...`, `scripts/...`) as bytes. */
  readFileBytes(skillName: string, relPath = "SKILL.md"): Uint8Array | null {
    const cleanRel = normalizeRelPath(relPath);
    const meta = this.list().find((s) => s.name === skillName);
    if (!meta) return null;

    if (meta.source === "git" && meta.sha) {
      const entry = this.store.resolvePath(meta.sha, `${skillName}/${cleanRel}`);
      if (!entry || entry.type !== "blob") return null;
      return this.store.readBlob(entry.sha);
    }

    const base = path.resolve(meta.location);
    const target = path.resolve(base, cleanRel);
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(target)) {
      return null;
    }
    return new Uint8Array(fs.readFileSync(target));
  }

  /** Read a skill file as UTF-8 text. */
  readFile(skillName: string, relPath = "SKILL.md"): string | null {
    const bytes = this.readFileBytes(skillName, relPath);
    return bytes ? decoder.decode(bytes) : null;
  }

  /**
   * Render a compact, deterministic catalog (~20 tokens/skill) for Turn-0 progressive disclosure.
   * Agents activate a skill on demand via `read({ path: "skill://<name>/SKILL.md" })`.
   */
  renderCatalog(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const lines = skills.map(
      (s) => `- ${s.name}: ${s.description} (load via read({ path: "skill://${s.name}/SKILL.md" }))`,
    );
    return lines.join("\n");
  }

  /** Direct trusted commit of a skill onto `refs/harness/skills`. */
  put(input: SkillWriteInput): Sha {
    const skillName = normalizeSkillName(input.skillName);
    const prevHead = this.store.readRef(this.ref);
    const allFiles = prevHead
      ? this.flattenTree(this.store.readCommit(prevHead).tree)
      : new Map<string, Sha>();

    // Replace existing files under `<skillName>/` cleanly.
    const prefix = `${skillName}/`;
    for (const key of [...allFiles.keys()]) {
      if (key.startsWith(prefix)) allFiles.delete(key);
    }
    for (const f of input.files) {
      allFiles.set(`${skillName}/${normalizeRelPath(f.path)}`, this.store.writeBlob(f.content));
    }

    const tree = this.buildNestedTree(allFiles);
    const message = this.formatSkillMessage(input);
    const sha = this.store.commitTree({
      tree,
      parents: prevHead ? [prevHead] : [],
      message,
    });
    this.store.updateRef(this.ref, sha, prevHead ?? "");
    return sha;
  }

  /**
   * Stage a skill addition/update under `refs/harness/skill-proposals/<id>` without
   * mutating `refs/harness/skills` until all gates pass in `promote()`.
   */
  propose(proposalId: string, input: SkillWriteInput): SkillProposal {
    const skillName = normalizeSkillName(input.skillName);
    const proposalRef = `${SKILL_PROPOSAL_PREFIX}${proposalId}`;
    const files = input.files.map((f) => ({ path: normalizeRelPath(f.path), content: f.content }));

    const blob = this.store.writeBlob(
      JSON.stringify(
        {
          id: proposalId,
          skillName,
          message: input.message,
          files,
          sourceSha: input.sourceSha,
          sourceRef: input.sourceRef,
          agentId: input.agentId,
        },
        null,
        2,
      ) + "\n",
    );
    const tree = this.store.writeTree([
      { mode: "100644", type: "blob", sha: blob, name: "proposal.json" },
    ]);
    const prevHead = this.store.readRef(this.ref);
    const sha = this.store.commitTree({
      tree,
      parents: prevHead ? [prevHead] : [],
      message: `skill-proposal(${skillName}): ${input.message}\n\nHarness-Kind: skill-proposal\n`,
    });
    this.store.updateRef(proposalRef, sha, "");

    return {
      id: proposalId,
      ref: proposalRef,
      sha,
      skillName,
      message: input.message,
      files,
      sourceSha: input.sourceSha,
      sourceRef: input.sourceRef,
      agentId: input.agentId,
    };
  }

  /**
   * Evaluate all gates against a staged skill proposal and promote onto `refs/harness/skills`
   * (with `parent2 = proposalSha` for full provenance) only if every gate passes.
   */
  async promote(
    proposalId: string,
    gates: SkillGate[] = [
      validSkillFrontmatterGate(),
      noSkillSecretsGate(),
      nonAbandonedSkillSourceGate(this.store),
    ],
  ): Promise<SkillPromoteResult> {
    const proposalRef = `${SKILL_PROPOSAL_PREFIX}${proposalId}`;
    const propSha = this.store.readRef(proposalRef);
    if (!propSha) {
      throw new Error(`Skill proposal not found: ${proposalId}`);
    }
    const entry = this.store.resolvePath(propSha, "proposal.json");
    if (!entry) {
      throw new Error(`Malformed skill proposal ${proposalId}: missing proposal.json`);
    }
    const raw = JSON.parse(decoder.decode(this.store.readBlob(entry.sha))) as Omit<
      SkillProposal,
      "ref" | "sha"
    >;
    const proposal: SkillProposal = { ...raw, ref: proposalRef, sha: propSha };

    const failedGates: Array<{ name: string; reason: string }> = [];
    for (const gate of gates) {
      const res = await gate.check(proposal);
      if (!res.passed) {
        failedGates.push({ name: gate.name, reason: res.reason ?? "rejected" });
      }
    }
    if (failedGates.length > 0) {
      return { promoted: false, failedGates };
    }

    const prevHead = this.store.readRef(this.ref);
    const allFiles = prevHead
      ? this.flattenTree(this.store.readCommit(prevHead).tree)
      : new Map<string, Sha>();

    const prefix = `${proposal.skillName}/`;
    for (const key of [...allFiles.keys()]) {
      if (key.startsWith(prefix)) allFiles.delete(key);
    }
    for (const f of proposal.files) {
      allFiles.set(`${proposal.skillName}/${f.path}`, this.store.writeBlob(f.content));
    }

    const tree = this.buildNestedTree(allFiles);
    const message = this.formatSkillMessage({
      skillName: proposal.skillName,
      files: proposal.files,
      message: proposal.message,
      sourceSha: proposal.sourceSha,
      sourceRef: proposal.sourceRef,
      agentId: proposal.agentId,
    });

    const parents = prevHead ? [prevHead, propSha] : [propSha];
    const commitSha = this.store.commitTree({ tree, parents, message });
    this.store.updateRef(this.ref, commitSha, prevHead ?? "");
    this.store.deleteRef(proposalRef);

    return { promoted: true, commitSha };
  }

  /** Discard a staged skill proposal without modifying `refs/harness/skills`. */
  reject(proposalId: string): void {
    this.store.deleteRef(`${SKILL_PROPOSAL_PREFIX}${proposalId}`);
  }

  private formatSkillMessage(input: SkillWriteInput): string {
    const trailers = ["Harness-Kind: skill", `Skill-Name: ${input.skillName}`];
    if (input.agentId) trailers.push(`Agent-Id: ${input.agentId}`);
    if (input.sourceRef) trailers.push(`Source-Ref: ${input.sourceRef}`);
    if (input.sourceSha) trailers.push(`Source-SHA: ${input.sourceSha}`);
    const title = input.message.replace(/\r?\n/g, " ").trim() || `skill: ${input.skillName}`;
    return `${title}\n\n${trailers.join("\n")}\n`;
  }

  private flattenTree(treeSha: Sha, prefix = "", out = new Map<string, Sha>()): Map<string, Sha> {
    for (const e of this.store.readTree(treeSha)) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === "tree") this.flattenTree(e.sha, full, out);
      else out.set(full, e.sha);
    }
    return out;
  }

  private buildNestedTree(files: Map<string, Sha>): Sha {
    type DirNode = { files: Map<string, Sha>; dirs: Map<string, DirNode> };
    const root: DirNode = { files: new Map(), dirs: new Map() };

    for (const [rel, sha] of files.entries()) {
      const parts = rel.split("/").filter(Boolean);
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        let child = cur.dirs.get(seg);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          cur.dirs.set(seg, child);
        }
        cur = child;
      }
      cur.files.set(parts[parts.length - 1]!, sha);
    }

    const writeNode = (node: DirNode): Sha => {
      const entries: TreeEntry[] = [];
      for (const [name, sha] of node.files.entries()) {
        entries.push({ mode: "100644", type: "blob", sha, name });
      }
      for (const [name, sub] of node.dirs.entries()) {
        entries.push({ mode: "040000", type: "tree", sha: writeNode(sub), name });
      }
      return this.store.writeTree(entries);
    };

    return writeNode(root);
  }
}
