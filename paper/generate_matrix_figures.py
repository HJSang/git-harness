import json
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 8.8,
    "axes.titlesize": 9.8,
    "axes.labelsize": 8.8,
    "legend.fontsize": 7.6,
    "xtick.labelsize": 8.0,
    "ytick.labelsize": 8.0,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "grid.linestyle": "--",
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})

stats = json.load(open(os.path.join(OUT_DIR, "matrix_stats.json")))
M = stats["matrix"]
V8 = stats["v08"]

# ==============================================================================
# Figure: 4-Model x 5-Harness Pass@1 (Latest git-harness) + Wire-Protocol Sensitivity
# ==============================================================================
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 3.65), dpi=300, gridspec_kw={"width_ratios": [1.35, 1.0]})

models = ["Claude Opus 5.5\n(high)", "Claude Fable 5.2\n(high)", "DeepSeek v4.1\n(high)", "GLM 5.3\n(high)"]
mkeys = ["opus55", "fable52", "ds41", "glm53"]

x = np.arange(len(models))
w = 0.19

ds_latest = V8["ds41-githarness-v08"]
fa_latest = V8["fable52-githarness-v08"]
op_latest_pass = M["opus55-githarness"]["passed"] + (1 if V8["opus55-v08-mips"]["passed"] == 1 else 0)

gh_vals = [
    100 * op_latest_pass / 15.0,
    100 * fa_latest["passed"] / fa_latest["n"],
    100 * ds_latest["passed"] / 15.0,
    100 * M["glm53-githarness"]["passed"] / 15.0,
]
pi_vals = [100 * M[f"{m}-pi"]["passed"] / M[f"{m}-pi"]["n"] for m in mkeys]
pr_vals = [100 * M[f"{m}-prime"]["passed"] / M[f"{m}-prime"]["n"] for m in mkeys]
vendor_vals = [
    100 * M["opus55-claudecode"]["passed"] / 15.0,
    100 * M["fable52-claudecode"]["passed"] / 15.0,
    100 * M["ds41-codex"]["passed"] / 15.0,
    100 * M["glm53-codex"]["passed"] / 15.0,
]

b1 = ax1.bar(x - 1.5*w, gh_vals,     w, label="git-harness",                     color="#2563eb", edgecolor="#1e3a8a", lw=0.7)
b2 = ax1.bar(x - 0.5*w, pi_vals,     w, label="pi 1.7.0",                        color="#64748b", edgecolor="#1e293b", lw=0.6)
b3 = ax1.bar(x + 0.5*w, pr_vals,     w, label="prime-agent 0.10.5",              color="#7c3aed", edgecolor="#3b0764", lw=0.6)
b4 = ax1.bar(x + 1.5*w, vendor_vals, w, label="claude-code (Anth) / codex (Open)", color="#f59e0b", edgecolor="#78350f", lw=0.6)

for bars, is_gh in [(b1, True), (b2, False), (b3, False), (b4, False)]:
    for bar in bars:
        h = bar.get_height()
        ax1.text(bar.get_x() + bar.get_width()/2, h + 1.5, f"{h:.0f}", ha="center", va="bottom",
                 fontsize=7.0, fontweight="bold" if is_gh else "normal",
                 color="#1d4ed8" if is_gh else "#334155")

ax1.set_xticks(x)
ax1.set_xticklabels(models)
ax1.set_ylim(0, 108)
ax1.set_ylabel("Pass@1 on 15 Hard TB 2.1 Tasks (%)")
ax1.set_title("(a) 4-Model x 5-Harness Pass@1 Comparison", pad=38)
ax1.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01), ncol=2, frameon=True, framealpha=0.95, fontsize=6.9)

# Panel (b): Wire-Protocol Ablation Impact (Controlled Sensitivity on git-harness)
abl_labels = [
    "DeepSeek v4.1\n(drop CoT echo\n& image cap)",
    "Claude Fable 5.2\n(16K cap +\nforgiving write)",
    "Claude Opus 5.5\n(16K cap on\nMIPS task)",
]
without_fix = [40.0, 66.7, 80.0]
with_fix    = [100 * ds_latest["passed"] / 15.0, 100 * fa_latest["passed"] / 15.0, 100 * op_latest_pass / 15.0]
ax_x = np.arange(len(abl_labels))
aw = 0.34
bw0 = ax2.bar(ax_x - aw/2, without_fix, aw, label="Without wire safeguard", color="#fca5a5", edgecolor="#991b1b", lw=0.6)
bw1 = ax2.bar(ax_x + aw/2, with_fix,    aw, label="Full git-harness",       color="#2563eb", edgecolor="#1e3a8a", lw=0.7)

for b0, b1_, v0, v1 in zip(bw0, bw1, without_fix, with_fix):
    ax2.text(b0.get_x() + b0.get_width()/2, v0 + 1.5, f"{v0:.0f}%", ha="center", va="bottom", fontsize=7.0, color="#991b1b")
    ax2.text(b1_.get_x() + b1_.get_width()/2, v1 + 1.5, f"{v1:.0f}%", ha="center", va="bottom", fontsize=7.2, fontweight="bold", color="#1d4ed8")
    diff = v1 - v0
    ax2.annotate(f"+{diff:.0f} pp", xy=(b1_.get_x() + b1_.get_width()/2, v1 + 9),
                 ha="center", va="bottom", fontsize=7.2, fontweight="bold", color="#15803d")

ax2.set_xticks(ax_x)
ax2.set_xticklabels(abl_labels, fontsize=7.4)
ax2.set_ylim(0, 112)
ax2.set_ylabel("Pass@1 on 15 Hard Tasks (%)")
ax2.set_title("(b) Wire-Protocol Safeguard Ablation", pad=38)
ax2.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01), ncol=2, frameon=True, framealpha=0.95, fontsize=7.0)

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_matrix_ab.pdf"), bbox_inches="tight")
plt.close()

# ==============================================================================
# Figure: Anthropic Cost Drivers (Output Tokens r=0.976 vs Turn-0 r=0.027) & Cost/Pass
# ==============================================================================
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 3.45), dpi=300)

# Panel (a): Per-trial output tokens vs exact Opus-normalized USD cost across all 4 harnesses (latest git-harness)
# Use latest fable52-githarness-v08 + opus55 with mips replaced
gh_opus_tasks = dict(M["opus55-githarness"]["tasks"])
gh_opus_tasks["make-mips-interpreter"] = V8["opus55-v08-mips"]["tasks"]["make-mips-interpreter"]
gh_fable_tasks = V8["fable52-githarness-v08"]["tasks"]

h_styles = {
    "githarness": ("git-harness", "#2563eb", "o"),
    "pi":         ("pi 1.7.0", "#64748b", "s"),
    "prime":      ("prime-agent 0.10.5", "#7c3aed", "^"),
    "claudecode": ("claude-code", "#f59e0b", "D"),
}
all_out, all_cost = [], []
for h, (lbl, col, mk) in h_styles.items():
    xs, ys = [], []
    for m in ("opus55", "fable52"):
        scale = 1.0 if m == "opus55" else 0.5
        tmap = gh_opus_tasks if (h == "githarness" and m == "opus55") else (
               gh_fable_tasks if (h == "githarness" and m == "fable52") else M[f"{m}-{h}"]["tasks"])
        for td in tmap.values():
            if td["out_t"] > 0 and td["cost"] is not None:
                xs.append(td["out_t"] / 1000.0)
                ys.append(td["cost"] * scale)
                all_out.append(td["out_t"] / 1000.0)
                all_cost.append(td["cost"] * scale)
    ax1.scatter(xs, ys, c=col, marker=mk, s=24, alpha=0.80, label=lbl, edgecolors="white", lw=0.3)

coef = np.polyfit(all_out, all_cost, 1)
r_val = np.corrcoef(all_out, all_cost)[0, 1]
xline = np.linspace(0, max(all_out) * 1.04, 50)
ax1.plot(xline, coef[0]*xline + coef[1], ls="--", color="#0f172a", lw=1.1, alpha=0.7)
ax1.text(0.97, 0.10,
         f"Output tok vs Cost:\n  r = +{r_val:.3f} (p < 1e-70)\nTurn-0 size vs Cost:\n  r = +0.027 (p = 0.78)",
         transform=ax1.transAxes, ha="right", va="bottom", fontsize=7.4,
         bbox=dict(boxstyle="round,pad=0.35", facecolor="#f8fafc", edgecolor="#cbd5e1", lw=0.8))
ax1.set_xlabel("Per-Trial Output / Thinking Tokens (K)")
ax1.set_ylabel("Opus-Normalized API Cost per Trial (USD)")
ax1.set_title("(a) Output Tokens Dominate Anthropic Cost (120 Trials)")
ax1.legend(loc="upper left", frameon=True, framealpha=0.92, fontsize=7.2)

# Panel (b): Cost per Passed Task across the 4 Anthropic Harnesses (latest git-harness)
groups = ["pi\n1.7.0", "prime-agent\n0.10.5", "claude-\ncode", "git-harness"]
op_gh_tot = sum(td["cost"] for td in gh_opus_tasks.values() if td["cost"] is not None)
op_cpp = [
    M["opus55-pi"]["cost_per_pass"],
    M["opus55-prime"]["cost_per_pass"],
    M["opus55-claudecode"]["cost_per_pass"],
    round(op_gh_tot / 13.0, 3),
]
fa_cpp = [
    M["fable52-pi"]["cost_per_pass"],
    M["fable52-prime"]["cost_per_pass"],
    M["fable52-claudecode"]["cost_per_pass"],
    V8["fable52-githarness-v08"]["cost_per_pass"],
]
gx = np.arange(len(groups))
gw = 0.34
bo = ax2.bar(gx - gw/2, op_cpp, gw, label="Claude Opus 5.5 (high)", color="#0ea5e9", edgecolor="#0c4a6e", lw=0.6)
bf = ax2.bar(gx + gw/2, fa_cpp, gw, label="Claude Fable 5.2 (high)", color="#8b5cf6", edgecolor="#4c1d95", lw=0.6)
for bars in (bo, bf):
    for bar in bars:
        h = bar.get_height()
        ax2.text(bar.get_x() + bar.get_width()/2, h + 0.04, f"${h:.2f}", ha="center", va="bottom", fontsize=7.4, fontweight="bold")
ax2.set_xticks(gx)
ax2.set_xticklabels(groups, fontsize=8.0)
ax2.set_ylim(0, 2.38)
ax2.set_ylabel("Total Spend per Passed Task (USD)")
ax2.set_title("(b) Exact Cost per Passed Task (incl. Failures & Timeouts)")
ax2.legend(loc="upper left", frameon=True, framealpha=0.92, fontsize=7.4)

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_anthropic_cost_cache.pdf"), bbox_inches="tight")
plt.close()
print("Regenerated clean unversioned matrix & cost figures.")
