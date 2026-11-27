import json, os, statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9,
    "axes.titlesize": 10,
    "axes.labelsize": 9,
    "legend.fontsize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "grid.linestyle": "--",
})

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(OUT_DIR, "stats_summary.json")))
pi, v5, v71 = data["pi"], data["v5"], data["v71"]
tasks = sorted(set(pi) & set(v5) & set(v71))

# ---- Figure 1: KV-Cache Hit Rate CDF + Uncached Prefill Comparison (2-panel) ----
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7.0, 2.7), dpi=300)

cr_pi  = sorted([100*pi[t]["cache_rate"]  for t in tasks if pi[t]["cache_rate"]  is not None])
cr_v5  = sorted([100*v5[t]["cache_rate"]  for t in tasks if v5[t]["cache_rate"]  is not None])
cr_v71 = sorted([100*v71[t]["cache_rate"] for t in tasks if v71[t]["cache_rate"] is not None])

y_pi  = np.linspace(1/len(cr_pi),  1.0, len(cr_pi))
y_v5  = np.linspace(1/len(cr_v5),  1.0, len(cr_v5))
y_v71 = np.linspace(1/len(cr_v71), 1.0, len(cr_v71))

ax1.plot(cr_pi,  y_pi,  label="pi v0.83.0 (med 87.4%)", color="#64748b", lw=1.8, ls="--")
ax1.plot(cr_v5,  y_v5,  label="git-harness v0.5 (med 86.4%)", color="#0ea5e9", lw=1.5, alpha=0.8)
ax1.plot(cr_v71, y_v71, label="git-harness v0.7.1 (med 88.8%)", color="#2563eb", lw=2.2)
ax1.set_xlim(60, 100)
ax1.set_xlabel("Per-Task KV-Cache Hit Rate (%)")
ax1.set_ylabel("Empirical CDF (89 Tasks)")
ax1.set_title("(a) Per-Task KV-Cache CDF (Wilcoxon p = 0.029)")
ax1.legend(loc="upper left", frameon=True, framealpha=0.9)

# Panel (b): Weighted Uncached Prefill Rate (1 - R_cache) with 95% cluster bootstrap CI
w_pi  = 100 * (1 - sum(pi[t]["cache_tok"]  for t in tasks) / sum(pi[t]["in_tok"]  for t in tasks))
w_v5  = 100 * (1 - sum(v5[t]["cache_tok"]  for t in tasks) / sum(v5[t]["in_tok"]  for t in tasks))
w_v71 = 100 * (1 - sum(v71[t]["cache_tok"] for t in tasks) / sum(v71[t]["in_tok"] for t in tasks))

labels = ["pi v0.83.0", "git-harness\nv0.5", "git-harness\nv0.7.1"]
vals = [w_pi, w_v5, w_v71]
colors = ["#94a3b8", "#38bdf8", "#2563eb"]
bars = ax2.bar(labels, vals, color=colors, width=0.52, edgecolor="#1e293b", lw=0.6)
for b, v in zip(bars, vals):
    ax2.text(b.get_x() + b.get_width()/2, v + 0.18, f"{v:.2f}%", ha="center", va="bottom", fontweight="bold", fontsize=8.5)
ax2.annotate("2.42x lower\nuncached prefill", xy=(2, w_v71 + 0.6), xytext=(1.15, 5.1),
             arrowprops=dict(arrowstyle="->", color="#1d4ed8", lw=1.1),
             fontsize=8, color="#1d4ed8", fontweight="bold", ha="center")
ax2.set_ylim(0, 7.6)
ax2.set_ylabel("Uncached Prefill Rate (1 - R_cache, %)")
ax2.set_title("(b) Weighted Uncached Prefill (95% CI: -5.4% to -1.9%)")

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_kvcache.pdf"), bbox_inches="tight")
plt.close()

# ---- Figure 2: Cost-Accuracy Distribution + Git Overhead Reduction (2-panel) ----
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7.0, 2.7), dpi=300)

def est_cost(rec):
    return (rec["uncached_tok"]*3.0 + rec["cache_tok"]*0.30 + rec["out_tok"]*15.0) / 1e6

# Panel (a): Paired per-task estimated cost scatter (log-log)
xs = [max(0.005, est_cost(pi[t])) for t in tasks]
ys = [max(0.005, est_cost(v71[t])) for t in tasks]
cols = []
for t in tasks:
    if v71[t]["pass_"] and not pi[t]["pass_"]: cols.append("#16a34a")
    elif pi[t]["pass_"] and not v71[t]["pass_"]: cols.append("#d97706")
    elif v71[t]["pass_"] and pi[t]["pass_"]: cols.append("#2563eb")
    else: cols.append("#dc2626")

ax1.scatter(xs, ys, c=cols, s=18, alpha=0.78, edgecolors="white", lw=0.3)
ax1.plot([0.005, 20], [0.005, 20], ls="--", color="#64748b", lw=1.0)
ax1.set_xscale("log"); ax1.set_yscale("log")
ax1.set_xlim(0.008, 12); ax1.set_ylim(0.008, 12)
ax1.set_xlabel("pi v0.83.0 Est. Cost per Task (USD, 10:1 cache)")
ax1.set_ylabel("git-harness v0.7.1 Est. Cost (USD)")
ax1.set_title("(a) Per-Task Cost Parity (Med: $0.16 vs $0.14)")
# compact legend handles
from matplotlib.lines import Line2D
handles = [
    Line2D([0],[0], marker="o", color="w", markerfacecolor="#2563eb", markersize=5, label="Both Pass (66)"),
    Line2D([0],[0], marker="o", color="w", markerfacecolor="#16a34a", markersize=5, label="gh-only Win (6)"),
    Line2D([0],[0], marker="o", color="w", markerfacecolor="#d97706", markersize=5, label="pi-only Win (10)"),
    Line2D([0],[0], marker="o", color="w", markerfacecolor="#dc2626", markersize=5, label="Both Fail (7)"),
]
ax1.legend(handles=handles, loc="upper left", frameon=True, framealpha=0.9, fontsize=7.2)

# Panel (b): Git Overhead % distribution (v0.5 vs v0.7.1)
gp_v5  = sorted([v5[t]["git_pct"]  for t in tasks if v5[t]["git_pct"]  is not None])
gp_v71 = sorted([v71[t]["git_pct"] for t in tasks if v71[t]["git_pct"] is not None])
ax2.plot(gp_v5,  np.linspace(1/len(gp_v5),  1.0, len(gp_v5)),  label="v0.5 (med 0.21%, mean 1.16%)", color="#94a3b8", lw=1.8, ls="--")
ax2.plot(gp_v71, np.linspace(1/len(gp_v71), 1.0, len(gp_v71)), label="v0.7.1 (med 0.18%, mean 0.59%)", color="#0d9488", lw=2.2)
ax2.set_xscale("log")
ax2.set_xlim(0.01, 35)
ax2.axvline(0.5, color="#dc2626", ls=":", lw=1.0, label="0.5% Target")
ax2.set_xlabel("Git Checkpoint Overhead (% of Wall Time, log)")
ax2.set_ylabel("Empirical CDF (89 Tasks)")
ax2.set_title("(b) Git Plumbing Overhead (2x Lower Mean)")
ax2.legend(loc="lower right", frameon=True, framealpha=0.9, fontsize=7.2)

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_cost_overhead.pdf"), bbox_inches="tight")
plt.close()

# ---- Figure 3: Multi-Scale Latency Scaling (reads bench_scale.json if present) ----
scale_path = os.path.join(OUT_DIR, "bench_scale.json")
if os.path.exists(scale_path):
    sc = json.load(open(scale_path))
    ns = [r["n"] for r in sc]
    p50 = [r["commit_p50"] for r in sc]
    p95 = [r["commit_p95"] for r in sc]
    proj = [r["proj_cold"] for r in sc]
    fig, ax = plt.subplots(figsize=(3.4, 2.3), dpi=300)
    ax.plot(ns, p50, marker="o", color="#2563eb", lw=2.0, label="commitTurn p50")
    ax.plot(ns, p95, marker="s", color="#60a5fa", lw=1.4, ls="--", label="commitTurn p95")
    ax.plot(ns, proj, marker="^", color="#0d9488", lw=1.6, label="project(HEAD) cold")
    ax.axhline(100, color="#dc2626", ls=":", lw=1.0, label="P0-6 Target (100 ms)")
    ax.set_xscale("log")
    ax.set_xlabel("Tracked Repository Files (N, log scale)")
    ax.set_ylabel("Latency (ms)")
    ax.set_title("Shadow-Index Scaling (100 to 20,000 Files)")
    ax.legend(loc="upper left", frameon=True, framealpha=0.9, fontsize=7.2)
    plt.tight_layout()
    plt.savefig(os.path.join(OUT_DIR, "fig_scaling.pdf"), bbox_inches="tight")
    plt.close()

# ---- Figure 4: 5-Arm Live Causal Ablation on 15 Feature-Active TB 2.1 Tasks ----
abl_path = os.path.join(OUT_DIR, "ablation_summary.json")
if os.path.exists(abl_path):
    abl = json.load(open(abl_path))
    order = ["No blob://", "No StuckLoopHook", "Full v0.7.1", "pi v0.83.0", "No subagent"]
    disp  = ["No blob://\noffload", "No Stuck\nHook", "Full\nv0.7.1", "pi\nv0.83.0", "git-harness\n(No subagent)"]
    cols  = ["#ef4444", "#f97316", "#0ea5e9", "#64748b", "#16a34a"]

    pass_pct = [100 * abl[k]["pass"] / 15.0 for k in order]
    tos      = [abl[k]["timeouts"] for k in order]
    med_cost = [abl[k]["med_cost"] for k in order]
    mean_dur = [abl[k]["mean_dur"] for k in order]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7.0, 2.75), dpi=300)

    bars1 = ax1.bar(disp, pass_pct, color=cols, width=0.58, edgecolor="#1e293b", lw=0.6)
    for b, p, to in zip(bars1, pass_pct, tos):
        lbl = f"{p:.1f}%" + (f"\n({to} TO)" if to > 0 else "\n(0 TO)")
        ax1.text(b.get_x() + b.get_width()/2, p + 1.8, lbl, ha="center", va="bottom", fontsize=7.2, fontweight="bold")
    ax1.set_ylim(0, 114)
    ax1.set_ylabel("Pass@1 on 15 Hard Tasks (%)")
    ax1.set_title("(a) Accuracy & Timeouts (Causal Ablation)")

    bars2 = ax2.bar(disp, med_cost, color=cols, width=0.58, edgecolor="#1e293b", lw=0.6)
    for b, c, md in zip(bars2, med_cost, mean_dur):
        ax2.text(b.get_x() + b.get_width()/2, c + 0.015, f"${c:.2f}\n({int(round(md))}s)", ha="center", va="bottom", fontsize=7.0, fontweight="bold")
    ax2.set_ylim(0, 0.72)
    ax2.set_ylabel("Median Est. Cost / Task (USD)")
    ax2.set_title("(b) Median Cost & Mean Duration")

    plt.tight_layout()
    plt.savefig(os.path.join(OUT_DIR, "fig_ablation.pdf"), bbox_inches="tight")
    plt.close()

print("Generated figures successfully.")
