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
# Figure: Multi-Model x Multi-Harness Pass@1 + Closed-Loop v0.8 Lift & Failure Fingerprints
# ==============================================================================
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 3.6), dpi=300, gridspec_kw={"width_ratios": [1.35, 1.0]})

models = ["Claude Opus 5.5\n(high)", "Claude Fable 5.2\n(high)", "DeepSeek v4.1\n(high)", "GLM 5.3\n(high)"]
mkeys = ["opus55", "fable52", "ds41", "glm53"]

x = np.arange(len(models))
w = 0.155

gh71 = [100 * M[f"{m}-githarness"]["passed"] / M[f"{m}-githarness"]["n"] for m in mkeys]
# v0.8 validated cells (opus55 targeted mips fix +1, fable52 full 15, ds41 full/scored)
ds_v8 = V8["ds41-githarness-v08"]
fa_v8 = V8["fable52-githarness-v08"]
op_v8_pass = M["opus55-githarness"]["passed"] + (1 if V8["opus55-v08-mips"]["passed"] == 1 else 0)
gh80 = [
    100 * op_v8_pass / 15.0,
    100 * fa_v8["passed"] / fa_v8["n"],
    100 * ds_v8["passed"] / 15.0,  # conservative denominator 15
    np.nan,
]
pi_vals = [100 * M[f"{m}-pi"]["passed"] / M[f"{m}-pi"]["n"] for m in mkeys]
pr_vals = [100 * M[f"{m}-prime"]["passed"] / M[f"{m}-prime"]["n"] for m in mkeys]
vendor_vals = [
    100 * M["opus55-claudecode"]["passed"] / 15.0,
    100 * M["fable52-claudecode"]["passed"] / 15.0,
    100 * M["ds41-codex"]["passed"] / 15.0,
    100 * M["glm53-codex"]["passed"] / 15.0,
]

b1 = ax1.bar(x - 2*w, gh71, w, label="git-harness v0.7.1", color="#93c5fd", edgecolor="#1e3a8a", lw=0.6)
b2 = ax1.bar(x - 1*w, [0 if np.isnan(v) else v for v in gh80], w, label="git-harness v0.8.0 (post-fix)", color="#2563eb", edgecolor="#1e3a8a", lw=0.7)
b3 = ax1.bar(x + 0*w, pi_vals, w, label="pi 1.7.0", color="#64748b", edgecolor="#1e293b", lw=0.6)
b4 = ax1.bar(x + 1*w, pr_vals, w, label="prime-agent 0.10.5", color="#7c3aed", edgecolor="#3b0764", lw=0.6)
b5 = ax1.bar(x + 2*w, vendor_vals, w, label="claude-code (Anth) / codex (Open)", color="#f59e0b", edgecolor="#78350f", lw=0.6)

# Hide unused bar for glm53 v0.8
b2[3].set_visible(False)

for bars, is_v8 in [(b1, False), (b2, True), (b3, False), (b4, False), (b5, False)]:
    for idx, bar in enumerate(bars):
        if is_v8 and idx == 3:
            continue
        h = bar.get_height()
        if h > 0:
            ax1.text(bar.get_x() + bar.get_width()/2, h + 1.4, f"{h:.0f}", ha="center", va="bottom",
                     fontsize=6.5, fontweight="bold" if is_v8 else "normal",
                     color="#1d4ed8" if is_v8 else "#334155")

# Annotate v0.8 jumps on Fable 5.2 and DeepSeek v4.1
ax1.annotate("+20 pp", xy=(1 - w, gh80[1] + 5.5), xytext=(1 - 1.5*w, 102),
             fontsize=7.3, fontweight="bold", color="#1d4ed8", ha="center",
             arrowprops=dict(arrowstyle="->", color="#1d4ed8", lw=0.9))
ax1.annotate("+33 pp", xy=(2 - w, gh80[2] + 5.5), xytext=(2 - 1.5*w, 89),
             fontsize=7.3, fontweight="bold", color="#1d4ed8", ha="center",
             arrowprops=dict(arrowstyle="->", color="#1d4ed8", lw=0.9))

ax1.set_xticks(x)
ax1.set_xticklabels(models)
ax1.set_ylim(0, 112)
ax1.set_ylabel("Pass@1 on 15 Hard TB 2.1 Tasks (%)")
ax1.set_title("(a) 4-Model x 5-Harness Pass@1 & Closed-Loop v0.8 Lift", pad=26)
ax1.legend(loc="lower center", bbox_to_anchor=(0.5, 1.00), ncol=3, frameon=True, framealpha=0.95, fontsize=6.5)

# Panel (b): Cross-Model Harness Failure Fingerprints (Scaffold Effect — 182-trial audited taxonomy)
harnesses = ["git-harness\nv0.7.1\n(25 fails)", "codex\n0.77.0\n(10 fails)", "pi\n1.7.0\n(20 fails)", "claude-code\n(3 fails)", "prime-agent\n(2 fails)"]
cats = {
    "max_tokens Trunc.": [44.0, 0.0, 15.0, 0.0, 0.0],
    "Timeout / Oscill.": [24.0, 40.0, 20.0, 33.3, 0.0],
    "Logic / Verify Fail": [24.0, 50.0, 55.0, 66.7, 50.0],
    "Policy Refusal / Premature": [8.0, 10.0, 10.0, 0.0, 50.0],
}
cat_cols = ["#ef4444", "#f97316", "#3b82f6", "#a855f7"]
bottom = np.zeros(len(harnesses))
hx = np.arange(len(harnesses))
for (cname, vals), col in zip(cats.items(), cat_cols):
    arr = np.array(vals)
    ax2.bar(hx, arr, width=0.56, bottom=bottom, label=cname, color=col, edgecolor="white", lw=0.5)
    for i, v in enumerate(arr):
        if v >= 14:
            ax2.text(i, bottom[i] + v/2, f"{v:.0f}%", ha="center", va="center", color="white", fontsize=7.0, fontweight="bold")
    bottom += arr

ax2.set_xticks(hx)
ax2.set_xticklabels(harnesses, fontsize=7.3)
ax2.set_ylim(0, 118)
ax2.set_ylabel("Share of Harness Failures (%)")
ax2.set_title("(b) Harness Failure Fingerprints (Scaffold Effect)")
ax2.legend(loc="upper center", ncol=2, frameon=True, framealpha=0.92, fontsize=6.6)

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_matrix_ab.pdf"), bbox_inches="tight")
plt.close()

# ==============================================================================
# Figure: Anthropic Cost Drivers (Output Tokens r=0.977 vs Turn-0 r=0.027) & Cost/Pass
# ==============================================================================
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.4, 3.45), dpi=300)

# Panel (a): Scatter of per-trial output tokens vs exact USD cost across all 120 baseline Anthropic trials
h_styles = {
    "githarness": ("git-harness v0.7.1", "#2563eb", "o"),
    "pi":         ("pi 1.7.0", "#64748b", "s"),
    "prime":      ("prime-agent 0.10.5", "#7c3aed", "^"),
    "claudecode": ("claude-code", "#f59e0b", "D"),
}
all_out, all_cost = [], []
for h, (lbl, col, mk) in h_styles.items():
    xs, ys = [], []
    for m in ("opus55", "fable52"):
        # Normalize cost to Opus-equivalent ($20/M out) so Opus & Fable sit on one clean line
        scale = 1.0 if m == "opus55" else 0.5
        for td in M[f"{m}-{h}"]["tasks"].values():
            if td["out_t"] > 0 and td["cost"] is not None:
                xs.append(td["out_t"] / 1000.0)
                ys.append(td["cost"] * scale)
                all_out.append(td["out_t"] / 1000.0)
                all_cost.append(td["cost"] * scale)
    ax1.scatter(xs, ys, c=col, marker=mk, s=24, alpha=0.80, label=lbl, edgecolors="white", lw=0.3)

# Linear fit line
coef = np.polyfit(all_out, all_cost, 1)
r_val = np.corrcoef(all_out, all_cost)[0, 1]
xline = np.linspace(0, max(all_out) * 1.03, 50)
ax1.plot(xline, coef[0]*xline + coef[1], ls="--", color="#0f172a", lw=1.1, alpha=0.7)
ax1.text(0.97, 0.10,
         f"Output tok vs Cost:\n  r = +{r_val:.3f} (p < 1e-70)\nTurn-0 size vs Cost:\n  r = +0.027 (p = 0.78)",
         transform=ax1.transAxes, ha="right", va="bottom", fontsize=7.4,
         bbox=dict(boxstyle="round,pad=0.35", facecolor="#f8fafc", edgecolor="#cbd5e1", lw=0.8))
ax1.set_xlabel("Per-Trial Output / Thinking Tokens (K)")
ax1.set_ylabel("Opus-Normalized API Cost per Trial (USD)")
ax1.set_title("(a) Output Tokens Dominate Anthropic Cost (120 Trials)")
ax1.legend(loc="upper left", frameon=True, framealpha=0.92, fontsize=7.0)

# Panel (b): Cost per Passed Task across Anthropic Harnesses (Opus 5.5 vs Fable 5.2)
groups = ["pi\n1.7.0", "prime\n0.10.5", "claude-\ncode", "git-harness\nv0.7.1", "git-harness\nv0.8.0"]
op_cpp = [
    M["opus55-pi"]["cost_per_pass"],
    M["opus55-prime"]["cost_per_pass"],
    M["opus55-claudecode"]["cost_per_pass"],
    M["opus55-githarness"]["cost_per_pass"],
    round((M["opus55-githarness"]["tot_cost"] - M["opus55-githarness"]["tasks"]["make-mips-interpreter"]["cost"] + V8["opus55-v08-mips"]["tot_cost"]) / 13.0, 3),
]
fa_cpp = [
    M["fable52-pi"]["cost_per_pass"],
    M["fable52-prime"]["cost_per_pass"],
    M["fable52-claudecode"]["cost_per_pass"],
    M["fable52-githarness"]["cost_per_pass"],
    V8["fable52-githarness-v08"]["cost_per_pass"],
]
gx = np.arange(len(groups))
gw = 0.34
bo = ax2.bar(gx - gw/2, op_cpp, gw, label="Claude Opus 5.5 (high)", color="#0ea5e9", edgecolor="#0c4a6e", lw=0.6)
bf = ax2.bar(gx + gw/2, fa_cpp, gw, label="Claude Fable 5.2 (high)", color="#8b5cf6", edgecolor="#4c1d95", lw=0.6)
for bars in (bo, bf):
    for bar in bars:
        h = bar.get_height()
        ax2.text(bar.get_x() + bar.get_width()/2, h + 0.04, f"${h:.2f}", ha="center", va="bottom", fontsize=7.0, fontweight="bold")
ax2.set_xticks(gx)
ax2.set_xticklabels(groups, fontsize=7.6)
ax2.set_ylim(0, 2.38)
ax2.set_ylabel("Total Spend per Passed Task (USD)")
ax2.set_title("(b) Exact Cost per Passed Task (incl. Failures & Timeouts)")
ax2.legend(loc="upper left", frameon=True, framealpha=0.92, fontsize=7.3)

plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_anthropic_cost_cache.pdf"), bbox_inches="tight")
plt.close()
print("Generated fig_matrix_ab.pdf and fig_anthropic_cost_cache.pdf cleanly.")
