import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9.5,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def draw_box(ax, x, y, w, h, title, body, fc, ec, title_color="#0f172a", lw=1.4, fs_t=10.5, fs_b=8.6, title_y=0.73, body_y=0.33):
    p = FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.012,rounding_size=0.018",
        facecolor=fc, edgecolor=ec, linewidth=lw, zorder=2
    )
    ax.add_patch(p)
    ax.text(
        x + w / 2, y + h * title_y, title,
        ha="center", va="center", fontweight="bold",
        color=title_color, fontsize=fs_t, zorder=3
    )
    ax.text(
        x + w / 2, y + h * body_y, body,
        ha="center", va="center", color="#334155",
        fontsize=fs_b, linespacing=1.35, zorder=3
    )


def draw_arrow(ax, x1, y1, x2, y2, label="", color="#475569", ls="-", lx=0.0, ly=0.0, ha="center"):
    arr = FancyArrowPatch(
        (x1, y1), (x2, y2),
        arrowstyle="-|>,head_length=5.5,head_width=3.2",
        color=color, linewidth=1.3, linestyle=ls, zorder=4
    )
    ax.add_patch(arr)
    if label:
        mx, my = (x1 + x2) / 2 + lx, (y1 + y2) / 2 + ly
        ax.text(
            mx, my, label, ha=ha, va="center", fontsize=8.0, color=color, zorder=5,
            bbox=dict(boxstyle="round,pad=0.18", facecolor="white", edgecolor="none", alpha=0.92)
        )


# ==============================================================================
# Figure 1: Six-Layer Git-First Architecture Diagram
# ==============================================================================
fig, ax = plt.subplots(figsize=(11.2, 5.5), dpi=300)
ax.set_xlim(0.0, 1.0)
ax.set_ylim(0.0, 1.0)
ax.axis("off")

# Layer 5 (Top)
draw_box(
    ax, 0.02, 0.83, 0.96, 0.14,
    "Layer 5: Surfaces & Evaluation Adapters (CLI / JSON-RPC 2.0 / Harbor)",
    "Streaming REPL  |  Headless run  |  --profile NDJSON  |  Atomic --bundle-out (100% timeout survival)  |  SIGTERM abort",
    "#f8fafc", "#64748b", title_y=0.69, body_y=0.28
)

# Middle Row: Layers 2, 3, 4 (generous horizontal widths & gaps)
draw_box(
    ax, 0.02, 0.43, 0.30, 0.30,
    "Layer 2: Agent Runtime",
    "4-tool core (read / write / edit / bash)\nWave-parallel Promise.all\nblob://<sha> offload + Vision read\nmaxSteps synthesis + StuckLoopHook",
    "#eff6ff", "#2563eb", title_y=0.82, body_y=0.38
)

draw_box(
    ax, 0.35, 0.43, 0.30, 0.30,
    "Layer 3: Subagent Orchestrator",
    "spawn (fork / orphan modes)\nLinked git worktrees\nReview gates -> refs/notes/*\nsquash / provenance-only / drop",
    "#faf5ff", "#7c3aed", title_y=0.82, body_y=0.38
)

draw_box(
    ax, 0.68, 0.43, 0.30, 0.30,
    "Layer 4: Knowledge & Safety",
    "MemoryStore (refs/harness/memory)\nSkillStore (refs/harness/skills)\nDisposable SQLite FTS5 RecallIndex\nMCP stdio + OS Sandbox (seatbelt/bwrap)",
    "#ecfdf5", "#059669", title_y=0.82, body_y=0.38
)

# Layer 1: Session Store
draw_box(
    ax, 0.02, 0.21, 0.96, 0.14,
    "Layer 1: Git-Backed Session Store (refs/harness/sessions/*, archive/*, abandoned/*)",
    "Co-atomic turn commits (events + Workspace-Tree)  |  --first-parent KV-cache projection  |  Dual-parent compact & merge anchors  |  history show/diff/rewind",
    "#fffbeb", "#d97706", title_y=0.69, body_y=0.28
)

# Layer 0: Git Plumbing
draw_box(
    ax, 0.02, 0.02, 0.96, 0.125,
    "Layer 0: Zero-Dependency Git Plumbing & Isolated Shadow Index (src/git-store/)",
    "hash-object / write-tree / commit-tree / update-ref via private GIT_INDEX_FILE  |  Zero host-repo pollution  |  Detached --git-dir + >25 MiB / unborn .git guards",
    "#f0fdfa", "#0d9488", title_y=0.68, body_y=0.27
)

# Arrows
draw_arrow(ax, 0.17, 0.818, 0.17, 0.742, "turn / events", "#334155", lx=0.065)
draw_arrow(ax, 0.50, 0.818, 0.50, 0.742, "bundle export", "#64748b", ls="--", lx=0.072)
draw_arrow(ax, 0.332, 0.58, 0.338, 0.58, "", "#7c3aed")
draw_arrow(ax, 0.662, 0.58, 0.668, 0.58, "", "#059669")
draw_arrow(ax, 0.17, 0.418, 0.17, 0.362, "commitTurn / project", "#2563eb", lx=0.088)
draw_arrow(ax, 0.50, 0.418, 0.50, 0.362, "squashMerge / archive", "#7c3aed", lx=0.095)
draw_arrow(ax, 0.83, 0.418, 0.83, 0.362, "ensureFresh FTS5", "#059669", ls="--", lx=-0.085)
draw_arrow(ax, 0.50, 0.198, 0.50, 0.157, "pure Git plumbing (p50 = 47 ms @ 10K files)", "#0d9488", lx=0.185)

fig.subplots_adjust(left=0.005, right=0.995, top=0.995, bottom=0.005)
plt.savefig(os.path.join(OUT_DIR, "fig_architecture.pdf"), bbox_inches="tight", pad_inches=0.06)
plt.close()

# ==============================================================================
# Figure 2: L0-L3 Git-Backed State Hierarchy
# ==============================================================================
fig, ax = plt.subplots(figsize=(11.2, 3.8), dpi=300)
ax.set_xlim(0.0, 1.0)
ax.set_ylim(0.0, 1.0)
ax.axis("off")

tiers = [
    (
        0.015, "#f1f5f9", "#475569",
        "L0: Model Weights",
        "Fixed parameters\nModel-portable adapters\n(swap mid-session)",
        "Updated by external\ntraining only"
    ),
    (
        0.260, "#eff6ff", "#2563eb",
        "L1: Active Context",
        "--first-parent\nprojected prompt\n(97.4% live KV-cache)",
        "Append-only prefix +\ndual-parent compact"
    ),
    (
        0.525, "#faf5ff", "#7c3aed",
        "L2: Ephemeral Work",
        "Tool blobs (blob://<sha>)\nLinked git worktrees\nActive subagent branches",
        "Offload >8 KiB +\nsquash / archive"
    ),
    (
        0.770, "#f0fdfa", "#0d9488",
        "L3: Git Object DAG",
        "refs/harness/* commits\nMemory & Skill branches\nDisposable FTS5 index",
        "Co-atomic commits +\nanti-poisoning gates"
    ),
]

box_w = 0.215
for x, fc, ec, title, body, mut in tiers:
    p = FancyBboxPatch(
        (x, 0.24), box_w, 0.63,
        boxstyle="round,pad=0.010,rounding_size=0.018",
        facecolor=fc, edgecolor=ec, linewidth=1.4, zorder=2
    )
    ax.add_patch(p)
    ax.text(x + box_w / 2, 0.79, title, ha="center", va="center",
            fontweight="bold", fontsize=10.2, color="#0f172a", zorder=3)
    ax.text(x + box_w / 2, 0.55, body, ha="center", va="center",
            fontsize=8.6, color="#334155", linespacing=1.35, zorder=3)
    ax.text(x + box_w / 2, 0.32, mut, ha="center", va="center",
            fontsize=8.0, style="italic", color=ec, linespacing=1.25, zorder=3)

# Boundary line between L1 (token-visible) and L2/L3 (Git-managed external state)
bx = 0.500
ax.plot([bx, bx], [0.18, 0.92], color="#dc2626", ls="--", lw=1.5, zorder=4)
ax.text(
    bx, 0.945, "Token-Visible / External Git-State Boundary",
    ha="center", va="bottom", fontsize=9.2, fontweight="bold", color="#dc2626"
)

# Transition arrows between boxes
draw_arrow(ax, 0.240, 0.56, 0.252, 0.56, "", "#475569")
draw_arrow(ax, 0.485, 0.62, 0.515, 0.62, "", "#2563eb")
draw_arrow(ax, 0.515, 0.48, 0.485, 0.48, "", "#7c3aed", ls="--")
draw_arrow(ax, 0.750, 0.62, 0.762, 0.62, "", "#7c3aed")
draw_arrow(ax, 0.762, 0.48, 0.750, 0.48, "", "#0d9488", ls="--")

# Bottom transition legend (two clean lines so it fits strictly inside 0..1)
ax.text(
    0.50, 0.085,
    "L1 <-> L2: blob:// offload & subagent summary     |     L1 <-> L3: --first-parent projection, FTS5 recall, history show/rewind\n"
    "L2 <-> L3: shadow-index commitTurn, dual-parent squashMerge, archive/abandoned refs, and atomic git bundle export",
    ha="center", va="center", fontsize=8.3, color="#334155", linespacing=1.45,
    bbox=dict(boxstyle="round,pad=0.35", facecolor="#f8fafc", edgecolor="#cbd5e1", lw=0.9)
)

fig.subplots_adjust(left=0.005, right=0.995, top=0.995, bottom=0.005)
plt.savefig(os.path.join(OUT_DIR, "fig_state_hierarchy.pdf"), bbox_inches="tight", pad_inches=0.06)
plt.close()
print("Regenerated fig_architecture.pdf and fig_state_hierarchy.pdf")
