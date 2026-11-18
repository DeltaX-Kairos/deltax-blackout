/**
 * Blackout — browser workspace client.
 *
 * Zero external dependencies. Plain browser JS, no bundler required.
 *
 * Session lifecycle:
 *   1. POST /api/session          → receive csrfToken in body, sessionId in cookie
 *   2. GET  /api/observe          → initial state snapshot + chronological history
 *   3. GET  /api/live/status      → read-only hosted review status & allowance
 *   4. POST /api/propose          → candidate proposals cached server-side
 *   5. POST /api/evaluate         → hosted review of eligible candidates
 *   6. GET  /api/inspect/:id      → feasibility check per proposal (pure read)
 *   7. POST /api/approve          → server caches Action, returns stageId
 *   8. POST /api/execute          → execute by stageId; server resolves Action
 *   9. GET  /api/evidence         → downloadable evidence bundle
 *   On page refresh: GET /api/restore → restore CSRF token, state, and review
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  csrfToken: null,        // string | null
  currentState: null,     // ScenarioState | null
  proposals: [],          // Proposal[]
  selectedProposal: null, // Proposal | null
  feasibility: null,      // { pass, violatedRules, resourceProjection } | null
  stagedStageId: null,    // string | null
  stagedEffect: null,     // { actionType, parameters, basisRevision, basisDigest } | null
  _stagedBasisDigest: null,
  _stagedBasisRevision: null,
  events: [],             // LabEvent[]
  history: [],            // ScenarioState[]
  liveStatus: null,       // HostedStatusInfo | null
  currentReview: null,    // SanitizedReviewRecord | null
  busy: false,
  reviewPending: false,
  lastAppliedReviewId: null,
};

function isReviewConsumed(review) {
  if (!review) return false;
  if (state.lastAppliedReviewId) return true;
  if (
    Array.isArray(state.events) &&
    state.events.some(
      (e) =>
        (e.kind === "ActionApplied" || e.kind === "action-applied") &&
        typeof e.revision === "number" &&
        e.revision >= review.basisRevision
    )
  ) {
    return true;
  }
  return false;
}

function isReviewExpired(review) {
  if (!review || isReviewConsumed(review)) return false;
  const currentRev = state.currentState ? state.currentState.revision : 1;
  const currentDigest = state.currentState ? state.currentState.basisDigest : "";
  return Boolean(
    review.basisRevision !== currentRev ||
      (Boolean(currentDigest) && review.basisDigest !== currentDigest)
  );
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}

function announce(msg) {
  const el = $("announce");
  if (el) {
    el.textContent = "";
    requestAnimationFrame(() => {
      el.textContent = msg;
    });
  }
}

function setStatus(msg, kind = "") {
  const el = $("status-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = kind ? `status-${kind}` : "";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Workflow Step Progression ────────────────────────────────────────────────

function setWorkflowStep(activeStep) {
  const steps = ["observe", "review", "recheck", "apply", "measure"];
  for (const s of steps) {
    const el = $("step-" + s);
    if (!el) continue;
    if (s === activeStep) {
      el.classList.add("active");
    } else {
      el.classList.remove("active");
    }
  }
}

// ─── API client ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.csrfToken && method !== "GET") {
    headers["x-csrf-token"] = state.csrfToken;
  }
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: "Invalid JSON response" }));
  if (!res.ok) {
    const msg = json.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ─── Metric Formatting ────────────────────────────────────────────────────────

function formatMetricValue(key, val) {
  if (typeof val === "number") {
    if (key === "errorRate" || key === "replicaAvailability") return (val * 100).toFixed(1) + "%";
    if (key === "arrivalRatePerTick" || key === "ingestionRateCap") return val.toFixed(0) + " / 10 s";
    if (key.toLowerCase().includes("latency")) return val.toFixed(0) + " ms";
    if (Number.isInteger(val)) return val.toString();
    return val.toFixed(2);
  }
  if (typeof val === "boolean") return val ? "yes" : "no";
  if (val === null) return "—";
  return String(val);
}

function metricSeverity(key, val) {
  if (typeof val !== "number") return "";
  const k = key.toLowerCase();
  if (k.includes("error")) {
    if (val > 0.3) return "critical";
    if (val > 0.1) return "alert";
    return "ok";
  }
  if (k.includes("queue")) {
    if (val > 3000) return "critical";
    if (val > 1000) return "alert";
    return "ok";
  }
  if (k.includes("latency")) {
    if (val > 1000) return "critical";
    if (val > 400) return "alert";
    return "ok";
  }
  return "";
}

function renderMetrics(op) {
  const grid = $("metrics-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const [key, val] of Object.entries(op)) {
    if (key === "kind") continue;
    const sev = metricSeverity(key, val);
    const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
    grid.insertAdjacentHTML(
      "beforeend",
      `
      <div class="metric-card ${sev}" role="group" aria-label="${escapeHtml(label)}">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value">${escapeHtml(formatMetricValue(key, val))}</div>
      </div>
    `
    );
  }
}

function renderTopology(op) {
  const view = $("topology-view");
  if (!view) return;
  view.innerHTML = "";
  if (op.kind === "queue-storm") {
    const queueSev =
      op.queueDepth > 3000 ? "incident" : op.queueDepth > 1000 ? "incident" : "healthy";
    const workerSev = op.workerCount < 6 ? "incident" : "healthy";
    const dbSev = op.dbConnectionCount > 50 ? "incident" : "healthy";
    view.innerHTML = `
      <div class="topo-node">
        <div class="node-box incident" aria-label="API gateway — traffic arriving">API GW</div>
        <span class="node-label">${escapeHtml(String(op.arrivalRatePerTick))} req/tick</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${queueSev}" aria-label="Message queue depth ${op.queueDepth}">Queue</div>
        <span class="node-label">${escapeHtml(String(op.queueDepth))} msgs</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${workerSev}" aria-label="${op.workerCount} workers">Workers</div>
        <span class="node-label">${escapeHtml(String(op.workerCount))} × worker</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${dbSev}" aria-label="Database connections ${op.dbConnectionCount}">DB</div>
        <span class="node-label">${escapeHtml(String(op.dbConnectionCount))} conns</span>
      </div>
    `;
  } else if (op.kind === "database-pressure") {
    const replSev =
      op.replicaAvailability < 0.6
        ? "degraded"
        : op.replicaAvailability < 1.0
        ? "incident"
        : "healthy";
    const connSev = op.connectionCount > 160 ? "incident" : "healthy";
    const latSev =
      op.queryLatencyMs > 1000
        ? "critical"
        : op.queryLatencyMs > 400
        ? "incident"
        : "healthy";
    view.innerHTML = `
      <div class="topo-node">
        <div class="node-box incident" aria-label="${op.appServerCount} app servers">App</div>
        <span class="node-label">${escapeHtml(String(op.appServerCount))} servers</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${connSev}" aria-label="${op.connectionCount} connections">Pool</div>
        <span class="node-label">${escapeHtml(String(op.connectionCount))} conns</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${latSev}" aria-label="Primary DB latency ${op.queryLatencyMs}ms">Primary</div>
        <span class="node-label">${escapeHtml(String(op.queryLatencyMs))} ms</span>
      </div>
      <div class="topo-arrow" aria-hidden="true"></div>
      <div class="topo-node">
        <div class="node-box ${replSev}" aria-label="Read replicas availability ${(op.replicaAvailability * 100).toFixed(0)}%">Replicas</div>
        <span class="node-label">${escapeHtml((op.replicaAvailability * 100).toFixed(0))}% avail</span>
      </div>
    `;
  }
}

function renderDigest(s) {
  const el = $("digest-view");
  if (!el) return;
  el.innerHTML =
    `<span style="color:var(--warm-dim)">rev </span><span style="color:var(--warm-white)">${escapeHtml(String(s.revision))}</span>` +
    `<span style="color:var(--warm-dim)">  tick </span><span style="color:var(--warm-white)">${escapeHtml(String(s.tick))}</span>` +
    `<br/><span style="color:var(--warm-dim)">digest </span><span>${escapeHtml(s.basisDigest)}</span>`;
}

function renderHeaderBadges(s) {
  const badge = $("scenario-badge");
  if (badge) badge.textContent = s.scenarioId;
  const rev = $("revision-badge");
  if (rev) rev.textContent = `r${s.revision} · t${s.tick}`;
  const statusBadge = $("status-badge");
  if (statusBadge) {
    statusBadge.textContent = s.status;
    if (s.status === "running") {
      statusBadge.style.borderColor = "var(--teal-dim)";
      statusBadge.style.background = "var(--teal-bg)";
      statusBadge.style.color = "var(--teal)";
    } else {
      statusBadge.style.borderColor = "var(--amber-dim)";
      statusBadge.style.background = "var(--amber-bg)";
      statusBadge.style.color = "var(--amber)";
    }
  }
  const counter = $("tick-counter");
  if (counter) counter.textContent = `tick ${s.tick} / ${s.tickLimit}`;
}

// ─── Chronological Observation History Charts ─────────────────────────────────

function renderHistoryCharts(history) {
  if (!history || history.length === 0) return;

  const isQueue = history[0].operationalState.kind === "queue-storm";
  const backlogTitle = $("backlog-chart-title");
  const backlogUnit = $("backlog-chart-unit");
  if (backlogTitle) backlogTitle.textContent = isQueue ? "Queue backlog" : "Pool connections";
  if (backlogUnit) backlogUnit.textContent = isQueue ? "msgs" : "conns";

  // Chart 1: Backlog data
  const backlogData = history.map((s) => {
    const val =
      s.operationalState.kind === "queue-storm"
        ? s.operationalState.queueDepth
        : s.operationalState.connectionCount;
    return { tick: s.tick, rev: s.revision, val };
  });

  // Chart 2: Error rate data
  const errorData = history.map((s) => ({
    tick: s.tick,
    rev: s.revision,
    val: s.operationalState.errorRate * 100, // percentage
  }));

  drawSvgLineChart("backlog-chart", backlogData, isQueue ? "msgs" : "conns", "var(--amber)");
  drawSvgLineChart("error-chart", errorData, "%", "var(--red)");
}

function drawSvgLineChart(containerId, points, unit, lineColor) {
  const el = $(containerId);
  if (!el) return;

  const width = el.clientWidth || 240;
  const height = 90;
  const padLeft = 32;
  const padRight = 12;
  const padTop = 10;
  const padBottom = 20;

  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  if (points.length === 0) {
    el.innerHTML = `<span style="font-size:0.7rem;color:var(--warm-dim)">No data</span>`;
    return;
  }

  const minVal = 0;
  let maxVal = Math.max(...points.map((p) => p.val));
  if (unit === "%") {
    maxVal = Math.max(10, Math.ceil(maxVal / 10) * 10);
  } else {
    maxVal = Math.max(10, Math.ceil(maxVal * 1.1));
  }

  const minTick = points[0].tick;
  const maxTick = Math.max(points[points.length - 1].tick, minTick + 1);

  const coords = points.map((p, idx) => {
    const x =
      points.length === 1
        ? padLeft + innerW / 2
        : padLeft + ((p.tick - minTick) / (maxTick - minTick)) * innerW;
    const y = padTop + innerH - (p.val / (maxVal || 1)) * innerH;
    return { x, y, tick: p.tick, rev: p.rev, val: p.val };
  });

  const pathD = coords.reduce(
    (acc, pt, idx) => (idx === 0 ? `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}` : `${acc} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`),
    ""
  );

  const dotsHtml = coords
    .map(
      (pt) =>
        `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3" fill="${lineColor}"><title>t${pt.tick} (r${pt.rev}): ${pt.val.toFixed(unit === "%" ? 1 : 0)} ${unit}</title></circle>`
    )
    .join("");

  el.innerHTML = `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <!-- Grid lines -->
      <line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" stroke="var(--ink-border)" stroke-dasharray="2 2" />
      <line x1="${padLeft}" y1="${padTop + innerH / 2}" x2="${width - padRight}" y2="${padTop + innerH / 2}" stroke="var(--ink-border)" stroke-dasharray="2 2" />
      <line x1="${padLeft}" y1="${padTop + innerH}" x2="${width - padRight}" y2="${padTop + innerH}" stroke="var(--ink-border)" />

      <!-- Y-axis labels -->
      <text x="${padLeft - 4}" y="${padTop + 4}" font-size="9" font-family="var(--font-mono)" fill="var(--warm-dim)" text-anchor="end">${maxVal.toFixed(0)}</text>
      <text x="${padLeft - 4}" y="${padTop + innerH + 3}" font-size="9" font-family="var(--font-mono)" fill="var(--warm-dim)" text-anchor="end">0</text>

      <!-- X-axis tick labels -->
      <text x="${padLeft}" y="${height - 4}" font-size="9" font-family="var(--font-mono)" fill="var(--warm-dim)" text-anchor="start">t${minTick}</text>
      <text x="${width - padRight}" y="${height - 4}" font-size="9" font-family="var(--font-mono)" fill="var(--warm-dim)" text-anchor="end">t${maxTick}</text>

      <!-- Data line -->
      <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      ${dotsHtml}
    </svg>
  `;
}

// ─── DeltaX Evaluate Card Rendering ───────────────────────────────────────────

function renderEvaluateCard() {
  const badge = $("evaluate-status-badge");
  const allowanceEl = $("evaluate-allowance");
  const body = $("evaluate-body");
  const btn = $("evaluate-btn");
  if (!badge || !body || !btn) return;

  const statusInfo = state.liveStatus;
  const review = state.currentReview;

  if (!statusInfo || !statusInfo.configured) {
    badge.textContent = "Local demo";
    badge.className = "eval-badge eval-unconfigured";
    if (allowanceEl) allowanceEl.textContent = "";
    body.innerHTML = `
      <div class="uc-slot">
        Local demo (fictional lab mode) — no hosted review configured. Actions stage directly with operator confirmation.
      </div>
    `;
    btn.style.display = "none";
    return;
  }

  // Configured mode
  btn.style.display = "inline-block";
  const allowance = statusInfo.allowance;
  if (allowanceEl) {
    allowanceEl.textContent = `Attempts: ${allowance.sessionUsed}/${allowance.sessionMax} session · ${allowance.totalUsed}/${allowance.totalMax} global`;
  }

  // Determine user-facing status label
  const currentRev = state.currentState ? state.currentState.revision : 1;
  const currentDigest = state.currentState ? state.currentState.basisDigest : "";
  const consumed = isReviewConsumed(review);
  const expired = isReviewExpired(review);

  if (state.reviewPending || statusInfo.status === "busy") {
    badge.textContent = "Review in progress";
    badge.className = "eval-badge eval-busy";
  } else if (statusInfo.status === "disabled") {
    badge.textContent = "Hosted review unavailable";
    badge.className = "eval-badge eval-disabled";
  } else if (review) {
    if (review.status === "selected") {
      if (consumed) {
        badge.textContent = "Review consumed";
        badge.className = "eval-badge eval-consumed";
      } else if (expired) {
        badge.textContent = "Review expired";
        badge.className = "eval-badge eval-expired";
      } else {
        badge.textContent = "Selected for review";
        badge.className = "eval-badge eval-selected";
      }
    } else if (review.status === "refused") {
      badge.textContent = "Refused";
      badge.className = "eval-badge eval-refused";
    } else if (review.status === "unknown") {
      badge.textContent = "Outcome unknown";
      badge.className = "eval-badge eval-unknown";
    } else {
      badge.textContent = "Hosted review unavailable";
      badge.className = "eval-badge eval-disabled";
    }
  } else {
    badge.textContent = "Available";
    badge.className = "eval-badge eval-available";
  }

  // Render card body details
  if (review && review.status === "selected") {
    let gateSummary = "12 gate records returned; response schema checked";
    if (
      review.envelope &&
      review.envelope.result &&
      review.envelope.result.trace &&
      Array.isArray(review.envelope.result.trace.lambda_decisions)
    ) {
      const decisions = review.envelope.result.trace.lambda_decisions;
      const passCount = decisions.filter((d) => d.disposition === "pass").length;
      gateSummary = `${passCount}/${decisions.length} service gates passed; response schema checked`;
    }

    if (consumed) {
      let inspectReportHtml = "";
      if (review.localInspectReport) {
        const rep = review.localInspectReport;
        const proj = rep.feasibility.resourceProjection;
        const projText = proj ? ` (Projected connections: ${proj.projected} / ${proj.limit})` : "";
        inspectReportHtml = `
          <div style="margin-top:0.35rem;padding-top:0.35rem;border-top:1px solid var(--ink-border);font-size:0.7rem;">
            <span style="font-weight:600;color:var(--warm-dim);">Historical local verification report (basis r${escapeHtml(review.basisRevision)}):</span>
            ${rep.feasibility.pass ? "✓ Feasible at evaluation basis" : "✗ Infeasible"} ${escapeHtml(projText)}
          </div>
        `;
      }

      body.innerHTML = `
        <div class="eval-result-box consumed">
          <div style="font-weight:600;margin-bottom:0.25rem;">Historical review at r${escapeHtml(review.basisRevision)}; current r${escapeHtml(currentRev)} — consumed/applied</div>
          <div style="font-size:0.72rem;color:var(--warm-dim);">
            Candidate: <strong>${escapeHtml(review.selectedCandidateId || "—")}</strong> → Proposal: ${escapeHtml(review.selectedProposalId || "—")} (consumed)
          </div>
          ${inspectReportHtml}
          <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.3rem;">
            Receipt: ${escapeHtml(review.receiptId || review.commercialReceiptId || "—")} · Trace: ${escapeHtml((review.traceId || "").slice(0, 16))}… (${escapeHtml(gateSummary)})
          </div>
          <div class="authority-note">
            Previous review consumed by applied action. Generate fresh proposals to request a new review.
          </div>
        </div>
      `;
    } else if (expired) {
      let inspectReportHtml = "";
      if (review.localInspectReport) {
        const rep = review.localInspectReport;
        const proj = rep.feasibility.resourceProjection;
        const projText = proj ? ` (Projected connections: ${proj.projected} / ${proj.limit})` : "";
        inspectReportHtml = `
          <div style="margin-top:0.35rem;padding-top:0.35rem;border-top:1px solid var(--amber-dim);font-size:0.7rem;">
            <span style="font-weight:600;color:var(--amber);">Historical local verification report (basis r${escapeHtml(review.basisRevision)}):</span>
            ${rep.feasibility.pass ? `✓ Feasible at basis r${escapeHtml(review.basisRevision)} (stale)` : "✗ Infeasible"} ${escapeHtml(projText)}
          </div>
        `;
      }

      body.innerHTML = `
        <div class="eval-result-box expired">
          <div style="font-weight:600;margin-bottom:0.25rem;color:var(--amber);">⚠ Historical review at r${escapeHtml(review.basisRevision)}; current r${escapeHtml(currentRev)} — expired</div>
          <div style="font-size:0.72rem;color:var(--warm-white);">
            Candidate: <strong>${escapeHtml(review.selectedCandidateId || "—")}</strong> → Proposal: ${escapeHtml(review.selectedProposalId || "—")}
          </div>
          ${inspectReportHtml}
          <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.3rem;">
            Receipt: ${escapeHtml(review.receiptId || review.commercialReceiptId || "—")} · Trace: ${escapeHtml((review.traceId || "").slice(0, 16))}… (${escapeHtml(gateSummary)})
          </div>
          <div class="authority-note">
            State changed after review. Old verification basis expired; request fresh review at current revision.
          </div>
        </div>
      `;
    } else {
      let inspectReportHtml = "";
      if (review.localInspectReport) {
        const rep = review.localInspectReport;
        const proj = rep.feasibility.resourceProjection;
        const projText = proj ? ` (Projected connections: ${proj.projected} / ${proj.limit})` : "";
        inspectReportHtml = `
          <div style="margin-top:0.35rem;padding-top:0.35rem;border-top:1px solid var(--teal-dim);font-size:0.7rem;">
            <span style="font-weight:600;color:var(--teal);">Local verification report:</span>
            ${rep.feasibility.pass ? "✓ Feasible under current lab limits" : "✗ Infeasible"} ${escapeHtml(projText)}
          </div>
        `;
      }

      body.innerHTML = `
        <div class="eval-result-box selected">
          <div style="font-weight:600;margin-bottom:0.25rem;">✓ Recommended verification activity selected</div>
          <div style="font-size:0.72rem;color:var(--warm-white);">
            Candidate: <strong>${escapeHtml(review.selectedCandidateId || "—")}</strong> → Proposal: ${escapeHtml(review.selectedProposalId || "—")}
          </div>
          ${inspectReportHtml}
          <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.3rem;">
            Receipt: ${escapeHtml(review.receiptId || review.commercialReceiptId || "—")} · Trace: ${escapeHtml((review.traceId || "").slice(0, 16))}… (${escapeHtml(gateSummary)})
          </div>
          <div class="authority-note">
            Selection validates verification work, not execution authority. Action requires separate explicit human confirmation.
          </div>
        </div>
      `;
    }
  } else if (review && review.status === "refused") {
    body.innerHTML = `
      <div class="eval-result-box refused">
        <div style="font-weight:600;margin-bottom:0.25rem;">✗ Governed noop refusal</div>
        <div style="font-size:0.72rem;color:var(--warm-white);">
          No candidate passed all governance gates. Staging is blocked.
        </div>
        <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.2rem;">
          ${escapeHtml(review.receiptId ? `Receipt: ${review.receiptId}` : "")}
        </div>
      </div>
    `;
  } else if (review && review.status === "unknown") {
    body.innerHTML = `
      <div class="eval-result-box unknown">
        <div style="font-weight:600;margin-bottom:0.25rem;">? Outcome unknown</div>
        <div style="font-size:0.72rem;color:var(--warm-white);">
          Review outcome uncertain. Further attempts and local staging are blocked for this session.
        </div>
        <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.2rem;">
          ${escapeHtml(review.detail || "Request in-flight or timed out.")}
        </div>
      </div>
    `;
  } else {
    body.innerHTML = `
      <div class="uc-slot">
        Hosted review active. Click "Request hosted review" to submit eligible proposals for bounded validation.
      </div>
    `;
  }

  // Button disability
  const disabled =
    statusInfo.status === "disabled" ||
    statusInfo.status === "busy" ||
    state.reviewPending ||
    (review && review.status === "unknown") ||
    allowance.sessionRemaining <= 0 ||
    state.proposals.length === 0;

  btn.disabled = disabled;
}

// ─── Proposal List Rendering ──────────────────────────────────────────────────

function renderProposals(proposals) {
  const list = $("proposals-list");
  if (!list) return;
  if (!proposals.length) {
    list.innerHTML = `<p style="font-size:0.75rem;color:var(--warm-dim)">No proposals yet — click Generate proposals.</p>`;
    return;
  }
  list.innerHTML = "";

  const review = state.currentReview;
  const isReviewActive = Boolean(
    review &&
    review.status === "selected" &&
    !isReviewConsumed(review) &&
    !isReviewExpired(review)
  );

  for (const p of proposals) {
    const isSelected = state.selectedProposal?.proposalId === p.proposalId;
    const isReviewSelected = isReviewActive && review.selectedProposalId === p.proposalId;

    const card = document.createElement("div");
    card.className =
      "proposal-card" +
      (isSelected ? " selected" : "") +
      (isReviewSelected ? " review-selected" : "");
    card.setAttribute("role", "listitem");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-selected", String(isSelected));
    card.setAttribute("aria-label", `Proposal: ${p.description}`);
    card.setAttribute("data-proposal-id", p.proposalId);

    const support = (p.operatorReportedSupport * 100).toFixed(0) + "%";
    const effectsHtml = Object.entries(p.predictedEffects)
      .map(
        ([k, v]) =>
          `<li><span class="effect-key">${escapeHtml(k)}</span>: <span class="effect-value">${escapeHtml(formatMetricValue(k, v))}</span></li>`
      )
      .join("");
    const assumptionsHtml = p.assumptions
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join("");

    const reviewBadgeHtml = isReviewSelected
      ? `<span class="tag review-tag" style="background:var(--teal-bg);color:var(--teal);border:1px solid var(--teal-dim);">★ Selected by hosted review</span>`
      : "";

    card.innerHTML = `
      <div class="proposal-title">${escapeHtml(p.description)}</div>
      <div class="proposal-meta">
        <span class="tag source-scripted">source: ${escapeHtml(p.source)}</span>
        <span class="tag">${escapeHtml(p.actionType)}</span>
        <span class="tag support" title="Caller-reported fixture input; not model confidence">caller-reported fixture input: ${escapeHtml(support)} (scripted)</span>
        <span class="tag">${escapeHtml(p.semanticClass)}</span>
        ${reviewBadgeHtml}
      </div>
      <details style="margin-top:0.4rem;">
        <summary style="font-size:0.72rem;cursor:pointer;color:var(--warm-dim)">Predicted effects</summary>
        <ul class="effects-list" style="margin-top:0.3rem;">${effectsHtml}</ul>
      </details>
      <details style="margin-top:0.3rem;">
        <summary style="font-size:0.72rem;cursor:pointer;color:var(--warm-dim)">Assumptions</summary>
        <ul class="assumptions-list" style="margin-top:0.3rem;">${assumptionsHtml}</ul>
      </details>
      <div class="feasibility-result" style="margin-top:0.4rem;"></div>
    `;

    card.addEventListener("click", () => selectProposal(p));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectProposal(p);
      }
    });

    list.appendChild(card);
  }
}

function renderFeasibilityOnCard(proposalId, feasibility) {
  const card = document.querySelector(
    `[data-proposal-id="${CSS.escape(proposalId)}"] .feasibility-result`
  );
  if (!card) return;
  const projection = feasibility.resourceProjection;
  const detail = projection
    ? ` Projected database connections: ${projection.projected} / ${projection.limit} (currently ${projection.observed}).`
    : "";
  if (feasibility.pass) {
    card.innerHTML = `<div class="feasibility-banner pass" role="status">✓ Feasible against current state.${escapeHtml(detail)}</div>`;
  } else {
    const rules = feasibility.violatedRules.join(", ");
    card.innerHTML = `<div class="feasibility-banner fail" role="alert">✗ Not feasible — ${escapeHtml(rules)}.${escapeHtml(detail)}</div>`;
  }
}

function renderStagedAction(stageId, basisDigest, basisRevision, feasibility) {
  const area = $("staging-area");
  if (!area) return;
  const isFresh =
    state.currentState &&
    basisDigest === state.currentState.basisDigest &&
    basisRevision === state.currentState.revision;
  const effect = state.stagedEffect;
  const effectText = effect
    ? `${effect.actionType}: ${Object.entries(effect.parameters)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`
    : "Review the selected local lab effect";
  const pillClass = isFresh ? "fresh" : "stale";
  const pillLabel = isFresh ? "basis fresh" : "basis stale — re-propose needed";

  area.innerHTML = `
    <div class="action-row">
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.8rem;font-weight:600;margin-bottom:0.3rem;">${escapeHtml(effectText)}</div>
        <div style="font-size:0.72rem;color:var(--warm-dim);margin-bottom:0.3rem;">
          Reviewed at revision ${escapeHtml(String(basisRevision))} · evidence ${escapeHtml(String(basisDigest).slice(0, 12))}…
        </div>
        <span class="basis-pill ${pillClass}" aria-label="${pillLabel}">${escapeHtml(pillLabel)}</span>
      </div>
    </div>
    <div style="font-size:0.68rem;color:var(--warm-dim);margin-top:0.4rem;">
      Confirm this exact effect on the fictional lab. A changed observation will block it.
    </div>
  `;
  const execBtn = $("execute-btn");
  if (execBtn) execBtn.disabled = false;
}

function renderExecResult(result, receipt) {
  const el = $("exec-result");
  if (!el) return;

  if (result.kind === "applied") {
    const revAfter = receipt ? receipt.revisionAfter : "—";
    const digAfter = receipt ? receipt.digestAfter.slice(0, 12) + "…" : "—";
    const labNote = receipt ? receipt.labNote : "local lab action applied";
    el.innerHTML = `
      <div class="exec-result applied" role="status">
        ✓ Applied — revision ${escapeHtml(String(revAfter))} · digest ${escapeHtml(digAfter)}
        <br/>
        <span style="font-size:0.68rem;">Lab note: ${escapeHtml(labNote)}</span>
      </div>`;
    announce("Action applied. New revision: " + revAfter);
  } else if (result.kind === "stale-basis") {
    el.innerHTML = `
      <div class="exec-result stale-basis" role="alert">
        ✗ Stale basis — action digest does not match current state.
        <br/>Action: ${escapeHtml(result.actionDigest.slice(0, 12))}… · Current: ${escapeHtml(result.currentDigest.slice(0, 12))}…
        <br/><span style="font-size:0.68rem;">Re-propose to generate a fresh candidate.</span>
      </div>`;
    announce("Stale basis rejection. Re-propose required.");
  } else if (result.kind === "duplicate-action") {
    el.innerHTML = `<div class="exec-result duplicate" role="alert">✗ Duplicate — action ${escapeHtml(result.actionId)} already consumed.</div>`;
    announce("Duplicate action rejected.");
  } else {
    const detail = result.detail ?? JSON.stringify(result);
    el.innerHTML = `<div class="exec-result error" role="alert">✗ ${escapeHtml(result.kind)}: ${escapeHtml(detail)}</div>`;
    announce("Execution failed: " + detail);
  }
}

function renderTimeline(events) {
  const list = $("timeline-list");
  if (!list) return;
  list.innerHTML = "";
  const toShow = events.slice().reverse();
  for (const ev of toShow) {
    const detail = eventDetail(ev);
    const item = document.createElement("li");
    item.className = `timeline-event ev-${ev.kind}`;
    item.setAttribute("role", "listitem");
    item.innerHTML = `
      <span class="ev-tick" aria-label="Tick ${ev.tick}">t${escapeHtml(String(ev.tick))}</span>
      <span class="ev-kind">${escapeHtml(ev.kind)}</span>
      <span class="ev-detail">${escapeHtml(detail)}</span>
    `;
    list.appendChild(item);
  }
}

function eventDetail(ev) {
  switch (ev.kind) {
    case "ScenarioStarted":
      return `scenarioId=${ev.scenarioId} seed=${ev.seed}`;
    case "TickAdvanced":
      return `${ev.previousTick} → ${ev.tick}`;
    case "ProposalCreated":
      return `${ev.proposalId} source=${ev.source}`;
    case "FeasibilityRejected":
      return `${ev.proposalId} rules=${ev.violatedRules.join(",")}`;
    case "ActionApproved":
      return `${ev.actionId} proposal=${ev.proposalId}`;
    case "ActionApplied":
      return `${ev.actionId} → r${ev.revisionAfter}`;
    case "StaleBasiRejected":
      return `${ev.actionId} actionDigest=${ev.actionDigest.slice(0, 8)}…`;
    case "DuplicateActionRejected":
      return ev.actionId;
    case "UnconfirmedPayloadRejected":
      return `${ev.actionId} ${ev.detail}`;
    case "ScenarioTerminated":
      return `reason=${ev.reason}`;
    case "EvaluateUnconfigured":
      return ev.note;
    case "IncidentInjected":
      return `${ev.injectionKind}: ${ev.description}`;
    default:
      return "";
  }
}

// ─── Full render from stored state ────────────────────────────────────────────

function renderAll() {
  const s = state.currentState;
  if (!s) return;
  renderHeaderBadges(s);
  renderMetrics(s.operationalState);
  renderTopology(s.operationalState);
  renderHistoryCharts(state.history);
  renderDigest(s);
  renderProposals(state.proposals);
  renderEvaluateCard();
  renderTimeline(state.events);

  if (state.stagedStageId && state._stagedBasisDigest != null) {
    renderStagedAction(
      state.stagedStageId,
      state._stagedBasisDigest,
      state._stagedBasisRevision,
      state.feasibility
    );
  }

  const terminal = s.status !== "running";
  const tickBtn = $("tick-btn");
  const proposeBtn = $("propose-btn");
  if (tickBtn) tickBtn.disabled = terminal;
  if (proposeBtn) proposeBtn.disabled = terminal;
}

// ─── Operations ───────────────────────────────────────────────────────────────

async function refreshLiveStatus() {
  try {
    const status = await api("GET", "/api/live/status");
    state.liveStatus = status;
    if (status.review) {
      state.currentReview = status.review;
    }
    renderEvaluateCard();
  } catch {
    // Non-fatal status refresh failure
  }
}

async function doObserve() {
  setStatus("Observing…");
  try {
    const snap = await api("GET", "/api/observe");
    state.currentState = snap.state;
    state.events = snap.events;
    state.history = snap.history || [snap.state];
    renderAll();
    await refreshLiveStatus();
    setWorkflowStep("observe");
    setStatus("Observed", "ok");
  } catch (e) {
    setStatus(e.message, "error");
    announce("Observe failed: " + e.message);
  }
}

async function doTick() {
  if (state.busy) return;
  state.busy = true;
  setStatus("Advancing tick…");
  try {
    const snap = await api("POST", "/api/tick");
    state.currentState = snap.state;
    const obs = await api("GET", "/api/observe");
    state.events = obs.events;
    state.history = obs.history || state.history;
    renderAll();
    if (state.stagedStageId && state._stagedBasisDigest != null) {
      renderStagedAction(
        state.stagedStageId,
        state._stagedBasisDigest,
        state._stagedBasisRevision,
        state.feasibility
      );
    }
    await refreshLiveStatus();
    setWorkflowStep("measure");
    setStatus(`Tick advanced to ${snap.state.tick}`, "ok");
    announce("Tick advanced to " + snap.state.tick);
  } catch (e) {
    setStatus(e.message, "error");
    announce("Tick failed: " + e.message);
  } finally {
    state.busy = false;
  }
}

async function doPropose() {
  if (state.busy) return;
  state.busy = true;
  state.selectedProposal = null;
  state.feasibility = null;
  state.stagedStageId = null;
  state._stagedBasisDigest = null;
  state._stagedBasisRevision = null;
  const execBtn = $("execute-btn");
  if (execBtn) execBtn.disabled = true;
  setStatus("Generating proposals…");
  try {
    const snap = await api("POST", "/api/propose");
    state.proposals = snap.proposals;
    renderAll();
    setWorkflowStep("review");
    setStatus(`${snap.proposals.length} proposals generated at r${snap.currentRevision}`, "ok");
    announce(snap.proposals.length + " proposals generated");
  } catch (e) {
    setStatus(e.message, "error");
    announce("Propose failed: " + e.message);
  } finally {
    state.busy = false;
  }
}

async function doEvaluate() {
  if (state.reviewPending || state.busy) return;
  state.reviewPending = true;
  state.busy = true;
  renderEvaluateCard();
  setStatus("Requesting hosted review…");
  try {
    const review = await api("POST", "/api/evaluate", {});
    state.currentReview = review;
    state.lastAppliedReviewId = null;
    await refreshLiveStatus();
    renderAll();

    if (review.status === "selected" && review.selectedProposalId) {
      const match = state.proposals.find((p) => p.proposalId === review.selectedProposalId);
      if (match) {
        await selectProposal(match);
      }
      setWorkflowStep("recheck");
      setStatus("Review selected proposal: " + review.selectedProposalId, "ok");
      announce("Hosted review selected proposal " + review.selectedProposalId);
    } else if (review.status === "refused") {
      setWorkflowStep("review");
      setStatus("Hosted review refused candidate actions (governed noop)", "warn");
      announce("Hosted review returned governed noop refusal.");
    } else if (review.status === "unknown") {
      setStatus("Review outcome uncertain; further actions blocked", "error");
      announce("Hosted review returned outcome unknown.");
    } else {
      setStatus("Review status: " + review.status, "warn");
    }
  } catch (e) {
    setStatus(e.message, "error");
    announce("Evaluate failed: " + e.message);
  } finally {
    state.reviewPending = false;
    state.busy = false;
    renderAll();
  }
}

async function selectProposal(proposal) {
  if (state.busy) return;
  state.busy = true;
  state.selectedProposal = proposal;
  state.stagedStageId = null;
  state._stagedBasisDigest = null;
  state._stagedBasisRevision = null;
  const execBtn = $("execute-btn");
  if (execBtn) execBtn.disabled = true;
  setStatus("Inspecting feasibility…");

  document.querySelectorAll(".proposal-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.proposalId === proposal.proposalId);
    c.setAttribute(
      "aria-selected",
      c.dataset.proposalId === proposal.proposalId ? "true" : "false"
    );
  });

  try {
    const snap = await api("GET", `/api/inspect/${encodeURIComponent(proposal.proposalId)}`);
    state.feasibility = snap.feasibility;
    renderFeasibilityOnCard(proposal.proposalId, snap.feasibility);

    if (snap.feasibility.pass) {
      // In configured mode, staging requires hosted review check
      setStatus("Staging proposal…");
      const approveSnap = await api("POST", "/api/approve", { proposalId: proposal.proposalId });
      state.stagedStageId = approveSnap.stageId;
      state.stagedEffect = approveSnap.stagedEffect;
      state._stagedBasisDigest = state.currentState ? state.currentState.basisDigest : null;
      state._stagedBasisRevision = state.currentState ? state.currentState.revision : null;
      renderStagedAction(
        approveSnap.stageId,
        state._stagedBasisDigest,
        state._stagedBasisRevision,
        snap.feasibility
      );
      setWorkflowStep("apply");
      setStatus("Action staged — ready to confirm and apply", "ok");
      announce("Proposal feasible and staged. Confirm and apply when ready.");
    } else {
      const area = $("staging-area");
      if (area) {
        area.innerHTML = `<p style="font-size:0.75rem;color:var(--amber);">Proposal not feasible: ${escapeHtml(snap.feasibility.violatedRules.join(", "))}. Advance a tick or choose another candidate.</p>`;
      }
      setWorkflowStep("recheck");
      setStatus("Proposal not feasible — " + snap.feasibility.violatedRules.join(", "), "warn");
      announce("Proposal not feasible: " + snap.feasibility.violatedRules.join(", "));
    }
  } catch (e) {
    setStatus(e.message, "error");
    announce("Inspect/approve failed: " + e.message);
  } finally {
    state.busy = false;
  }
}

async function doExecute() {
  if (!state.stagedStageId) return;
  if (state.busy) return;
  state.busy = true;
  const execBtn = $("execute-btn");
  if (execBtn) execBtn.disabled = true;
  setStatus("Executing action…");

  try {
    const snap = await api("POST", "/api/execute", { stageId: state.stagedStageId });
    renderExecResult(snap.result, snap.receipt);

    // Final outcome status message (never stuck on "Executing action…")
    const completedStatus = {
      applied: "Lab action applied. Observe the outcome next.",
      "stale-basis": "State changed. The old action was blocked; review fresh alternatives.",
      "duplicate-action": "This action already ran. No second effect applied.",
    };
    const finalMsg = completedStatus[snap.result.kind] || `Action blocked: ${snap.result.kind}`;
    const finalKind = snap.result.kind === "applied" ? "ok" : "warn";
    setStatus(finalMsg, finalKind);

    if (snap.result.kind === "applied") {
      if (state.currentReview) {
        state.lastAppliedReviewId =
          state.currentReview.receiptId ||
          state.currentReview.idempotencyKey ||
          state.currentReview.selectedProposalId ||
          true;
      }
      state.stagedStageId = null;
      state._stagedBasisDigest = null;
      state._stagedBasisRevision = null;
      state.selectedProposal = null;
      state.proposals = [];
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
      state.history = obs.history || state.history;
      renderAll();
      const staging = $("staging-area");
      if (staging) {
        staging.innerHTML = `<p style="font-size:0.75rem;color:var(--teal);">Action applied. Observe new state and generate fresh proposals.</p>`;
      }
      setWorkflowStep("measure");
    } else if (snap.result.kind === "stale-basis") {
      if (state.stagedStageId && state._stagedBasisDigest != null) {
        renderStagedAction(
          state.stagedStageId,
          state._stagedBasisDigest,
          state._stagedBasisRevision,
          state.feasibility
        );
      }
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
      state.history = obs.history || state.history;
      renderAll();
      if (execBtn) execBtn.disabled = false;
      setWorkflowStep("recheck");
    } else {
      if (execBtn) execBtn.disabled = false;
      setWorkflowStep("recheck");
    }
  } catch (e) {
    setStatus(e.message, "error");
    announce("Execute failed: " + e.message);
    if (execBtn) execBtn.disabled = false;
  } finally {
    state.busy = false;
  }
}

async function doInject() {
  if (state.busy) return;
  state.busy = true;
  setStatus("Injecting incident pressure…");
  try {
    const scenario = state.currentState ? state.currentState.scenarioId : "queue-storm";
    const kind =
      scenario === "queue-storm" ? "database-pressure-queue-storm" : "replica-loss";
    const snap = await api("POST", "/api/inject", { kind });
    if (snap.kind === "injected") {
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
      state.history = obs.history || state.history;
      renderAll();
      setStatus("Incident injected — staged action is now stale. Re-propose required.", "warn");
      announce("Incident injected. Any staged action is now stale.");
    } else if (snap.kind === "rejected-duplicate") {
      setStatus("Injection already applied for this scenario run.", "warn");
    } else if (snap.kind === "rejected-terminal") {
      setStatus("Cannot inject: scenario is terminal.", "warn");
    } else {
      setStatus("Injection result: " + snap.kind, "warn");
    }
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    state.busy = false;
  }
}

// ─── Session setup ────────────────────────────────────────────────────────────

function showSetup() {
  $("setup-screen").removeAttribute("hidden");
  $("app").setAttribute("hidden", "");
}

function showWorkspace() {
  $("setup-screen").setAttribute("hidden", "");
  $("app").removeAttribute("hidden");
}

async function startSession() {
  const scenario = $("scenario-select").value;
  const seed = parseInt($("seed-input").value, 10);
  const tickLimit = parseInt($("tick-limit-input").value, 10);
  const errEl = $("setup-error");
  errEl.textContent = "";

  if (!Number.isFinite(seed) || seed < 0) {
    errEl.textContent = "Seed must be a non-negative integer.";
    return;
  }
  if (!Number.isFinite(tickLimit) || tickLimit < 1 || tickLimit > 120) {
    errEl.textContent = "Tick limit must be a positive integer (max 120).";
    return;
  }

  const startBtn = $("start-btn");
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

  try {
    const sessionResp = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioName: scenario, seed, tickLimit }),
    });
    const sessionJson = await sessionResp.json().catch(() => ({}));
    if (!sessionResp.ok) {
      errEl.textContent = sessionJson.error || `HTTP ${sessionResp.status}`;
      return;
    }
    state.csrfToken = sessionJson.csrfToken;
    state.currentState = null;
    state.proposals = [];
    state.selectedProposal = null;
    state.feasibility = null;
    state.stagedStageId = null;
    state.stagedEffect = null;
    state._stagedBasisDigest = null;
    state._stagedBasisRevision = null;
    state.events = [];
    state.history = [];
    state.currentReview = null;
    state.reviewPending = false;
    state.lastAppliedReviewId = null;

    showWorkspace();
    await doObserve();
    await refreshLiveStatus();
    setStatus("Session started — " + scenario + " seed " + seed, "ok");
    announce("Lab session started. Scenario: " + scenario);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start lab session";
  }
}

/** Attempt to restore a previous session after page refresh. */
async function tryRestoreSession() {
  try {
    const res = await fetch("/api/restore", { method: "GET", credentials: "same-origin" });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    if (!json || !json.csrfToken) return false;
    state.csrfToken = json.csrfToken;
    state.currentState = json.state;
    state.events = json.events;
    state.history = json.history || [json.state];
    state.liveStatus = json.liveStatus || null;
    state.currentReview = json.review || null;
    return true;
  } catch {
    return false;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  tryRestoreSession().then((restored) => {
    if (restored) {
      showWorkspace();
      renderAll();
      setStatus("Session restored after refresh.", "ok");
    } else {
      showSetup();
    }
  });

  $("start-btn").addEventListener("click", startSession);

  [$("seed-input"), $("tick-limit-input"), $("scenario-select")].forEach((el) => {
    if (el)
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") startSession();
      });
  });

  $("new-session-btn").addEventListener("click", () => {
    showSetup();
    $("setup-error").textContent = "";
  });

  $("tick-btn").addEventListener("click", doTick);
  $("observe-btn").addEventListener("click", doObserve);
  $("propose-btn").addEventListener("click", doPropose);
  $("execute-btn").addEventListener("click", doExecute);

  const evalBtn = $("evaluate-btn");
  if (evalBtn) evalBtn.addEventListener("click", doEvaluate);

  const injectBtn = $("inject-btn");
  if (injectBtn) injectBtn.addEventListener("click", doInject);
}

document.addEventListener("DOMContentLoaded", boot);
