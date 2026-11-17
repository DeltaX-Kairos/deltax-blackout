/**
 * Blackout M2 — browser workspace client.
 *
 * Zero external dependencies. Plain browser JS, no bundler required.
 *
 * Session lifecycle:
 *   1. POST /api/session          → receive csrfToken in body, sessionId in cookie
 *   2. GET  /api/observe          → initial state snapshot
 *   3. POST /api/propose          → scripted candidates cached server-side
 *   4. GET  /api/inspect/:id      → feasibility check per proposal (pure read)
 *   5. POST /api/approve { proposalId } → server caches Action, returns stageId
 *   6. Optionally POST /api/inject → inject typed incident (see stale-basis demo)
 *   7. POST /api/execute { stageId } → execute by stageId; server resolves Action
 *   8. GET  /api/evidence          → downloadable evidence bundle
 *   On page refresh: GET /api/restore → restore CSRF token and state from server
 *
 * All mutation requests send the CSRF token header received at session creation.
 * Raw Action payloads are never sent client→server; only the opaque stageId is.
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  csrfToken: null,       // string | null
  currentState: null,    // ScenarioState | null
  proposals: [],         // Proposal[]
  selectedProposal: null, // Proposal | null
  feasibility: null,     // { pass, violatedRules } | null
  stagedStageId: null,   // string | null — server-side stageId (not raw Action)
  events: [],            // LabEvent[]
  busy: false,
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function announce(msg) {
  const el = $("announce");
  if (el) { el.textContent = ""; requestAnimationFrame(() => { el.textContent = msg; }); }
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

// ─── Render helpers ───────────────────────────────────────────────────────────

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
    const label = key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
    grid.insertAdjacentHTML("beforeend", `
      <div class="metric-card ${sev}" role="group" aria-label="${escapeHtml(label)}">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value">${escapeHtml(formatMetricValue(key, val))}</div>
      </div>
    `);
  }
}

function renderTopology(op) {
  const view = $("topology-view");
  if (!view) return;
  view.innerHTML = "";
  if (op.kind === "queue-storm") {
    const queueSev = op.queueDepth > 3000 ? "incident" : op.queueDepth > 1000 ? "incident" : "healthy";
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
    const replSev = op.replicaAvailability < 0.6 ? "degraded" : op.replicaAvailability < 1.0 ? "incident" : "healthy";
    const connSev = op.connectionCount > 160 ? "incident" : "healthy";
    const latSev = op.queryLatencyMs > 1000 ? "critical" : op.queryLatencyMs > 400 ? "incident" : "healthy";
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

function renderProposals(proposals) {
  const list = $("proposals-list");
  if (!list) return;
  if (!proposals.length) {
    list.innerHTML = `<p style="font-size:0.75rem;color:var(--warm-dim)">No proposals yet — click Generate proposals.</p>`;
    return;
  }
  list.innerHTML = "";
  for (const p of proposals) {
    const isSelected = state.selectedProposal?.proposalId === p.proposalId;
    const card = document.createElement("div");
    card.className = "proposal-card" + (isSelected ? " selected" : "");
    card.setAttribute("role", "listitem");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-selected", String(isSelected));
    card.setAttribute("aria-label", `Proposal: ${p.description}`);
    card.setAttribute("data-proposal-id", p.proposalId);

    const support = (p.operatorReportedSupport * 100).toFixed(0) + "%";
    const effectsHtml = Object.entries(p.predictedEffects)
      .map(([k, v]) =>
        `<li><span class="effect-key">${escapeHtml(k)}</span>: <span class="effect-value">${escapeHtml(formatMetricValue(k, v))}</span></li>`
      )
      .join("");
    const assumptionsHtml = p.assumptions
      .map(a => `<li>${escapeHtml(a)}</li>`)
      .join("");

    card.innerHTML = `
      <div class="proposal-title">${escapeHtml(p.description)}</div>
      <div class="proposal-meta">
        <span class="tag source-scripted">source: ${escapeHtml(p.source)}</span>
        <span class="tag">${escapeHtml(p.actionType)}</span>
        <span class="tag support">support: ${escapeHtml(support)}</span>
        <span class="tag">${escapeHtml(p.semanticClass)}</span>
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
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectProposal(p); }
    });

    list.appendChild(card);
  }
}

function renderFeasibilityOnCard(proposalId, feasibility) {
  const card = document.querySelector(`[data-proposal-id="${CSS.escape(proposalId)}"] .feasibility-result`);
  if (!card) return;
  const projection = feasibility.resourceProjection;
  const detail = projection ? ` Projected database connections: ${projection.projected} / ${projection.limit} (currently ${projection.observed}).` : "";
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
  const isFresh = state.currentState &&
    basisDigest === state.currentState.basisDigest &&
    basisRevision === state.currentState.revision;
  const effect = state.stagedEffect;
  const effectText = effect ? `${effect.actionType}: ${Object.entries(effect.parameters).map(([k,v]) => `${k}=${v}`).join(", ")}` : "Review the selected local lab effect";
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
  const completedStatus = { applied: "Lab action applied. Observe the outcome next.", "stale-basis": "State changed. The old action was blocked; review fresh alternatives.", "duplicate-action": "This action already ran. No second effect applied." };
  setStatus(completedStatus[result.kind] || "Action blocked: " + result.kind, result.kind === "applied" ? "ok" : "warn");
  if (result.kind === "applied") {
    el.innerHTML = `
      <div class="exec-result applied" role="status">
        ✓ Applied — revision ${escapeHtml(String(receipt.revisionAfter))} · digest ${escapeHtml(receipt.digestAfter.slice(0, 12))}…
        <br/>
        <span style="font-size:0.68rem;">Lab note: ${escapeHtml(receipt.labNote)}</span>
      </div>`;
    announce("Action applied. New revision: " + receipt.revisionAfter);
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
  const toShow = events.slice().reverse(); // most recent first
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
    case "ScenarioStarted":    return `scenarioId=${ev.scenarioId} seed=${ev.seed}`;
    case "TickAdvanced":       return `${ev.previousTick} → ${ev.tick}`;
    case "ProposalCreated":    return `${ev.proposalId} source=${ev.source}`;
    case "FeasibilityRejected": return `${ev.proposalId} rules=${ev.violatedRules.join(",")}`;
    case "ActionApproved":     return `${ev.actionId} proposal=${ev.proposalId}`;
    case "ActionApplied":      return `${ev.actionId} → r${ev.revisionAfter}`;
    case "StaleBasiRejected":  return `${ev.actionId} actionDigest=${ev.actionDigest.slice(0,8)}…`;
    case "DuplicateActionRejected": return ev.actionId;
    case "UnconfirmedPayloadRejected": return `${ev.actionId} ${ev.detail}`;
    case "ScenarioTerminated": return `reason=${ev.reason}`;
    case "EvaluateUnconfigured": return ev.note;
    case "IncidentInjected":   return `${ev.injectionKind}: ${ev.description}`;
    default:                   return "";
  }
}

// ─── Full render from stored state ────────────────────────────────────────────

function renderAll() {
  const s = state.currentState;
  if (!s) return;
  renderHeaderBadges(s);
  renderMetrics(s.operationalState);
  renderTopology(s.operationalState);
  renderDigest(s);
  renderProposals(state.proposals);
  renderTimeline(state.events);
  // Re-render staged action basis-freshness pill if one is staged.
  if (state.stagedStageId && state._stagedBasisDigest != null) {
    renderStagedAction(state.stagedStageId, state._stagedBasisDigest, state._stagedBasisRevision, state.feasibility);
  }
  // Disable tick/propose/execute if scenario is terminal.
  const terminal = s.status !== "running";
  const tickBtn = $("tick-btn");
  const proposeBtn = $("propose-btn");
  if (tickBtn) tickBtn.disabled = terminal;
  if (proposeBtn) proposeBtn.disabled = terminal;
}

// ─── Operations ───────────────────────────────────────────────────────────────

async function doObserve() {
  setStatus("Observing…");
  try {
    const snap = await api("GET", "/api/observe");
    state.currentState = snap.state;
    state.events = snap.events;
    renderAll();
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
    // Re-fetch events for the full log.
    const obs = await api("GET", "/api/observe");
    state.events = obs.events;
    renderAll();
    // If a staged action existed, re-render to show stale pill.
    if (state.stagedStageId && state._stagedBasisDigest != null) {
      renderStagedAction(state.stagedStageId, state._stagedBasisDigest, state._stagedBasisRevision, state.feasibility);
    }
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
    state.currentRevision = snap.currentRevision;
    renderAll();
    setStatus(`${snap.proposals.length} proposals generated at r${snap.currentRevision}`, "ok");
    announce(snap.proposals.length + " proposals generated");
  } catch (e) {
    setStatus(e.message, "error");
    announce("Propose failed: " + e.message);
  } finally {
    state.busy = false;
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
  // Update selection UI immediately.
  document.querySelectorAll(".proposal-card").forEach(c => {
    c.classList.toggle("selected", c.dataset.proposalId === proposal.proposalId);
    c.setAttribute("aria-selected", c.dataset.proposalId === proposal.proposalId ? "true" : "false");
  });
  try {
    const snap = await api("GET", `/api/inspect/${encodeURIComponent(proposal.proposalId)}`);
    state.feasibility = snap.feasibility;
    renderFeasibilityOnCard(proposal.proposalId, snap.feasibility);
    if (snap.feasibility.pass) {
      // Approve the proposal — server caches the action and returns stageId.
      setStatus("Approving proposal…");
      const approveSnap = await api("POST", "/api/approve", { proposalId: proposal.proposalId });
      const stageId = approveSnap.stageId;
      state.stagedStageId = stageId;
      state.stagedEffect = approveSnap.stagedEffect;
      // Store the basis from the current observed state for freshness tracking.
      state._stagedBasisDigest = state.currentState ? state.currentState.basisDigest : null;
      state._stagedBasisRevision = state.currentState ? state.currentState.revision : null;
      renderStagedAction(stageId, state._stagedBasisDigest, state._stagedBasisRevision, snap.feasibility);
      setStatus("Action staged — ready to execute", "ok");
      announce("Proposal feasible and staged. Execute when ready.");
    } else {
      const area = $("staging-area");
      if (area) {
        area.innerHTML = `<p style="font-size:0.75rem;color:var(--amber);">Proposal not feasible: ${escapeHtml(snap.feasibility.violatedRules.join(", "))}. Advance a tick or choose another candidate.</p>`;
      }
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
    // Send only the stageId — raw action payload never sent client→server.
    const snap = await api("POST", "/api/execute", { stageId: state.stagedStageId });
    renderExecResult(snap.result, snap.receipt);
    if (snap.result.kind === "applied") {
      state.stagedStageId = null;
      state._stagedBasisDigest = null;
      state._stagedBasisRevision = null;
      state.selectedProposal = null;
      state.proposals = [];
      // Refresh full state.
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
      renderAll();
      const staging = $("staging-area");
      if (staging) {
        staging.innerHTML = `<p style="font-size:0.75rem;color:var(--teal);">Action applied. Observe new state and generate fresh proposals.</p>`;
      }
    } else if (snap.result.kind === "stale-basis") {
      // Show stale pill on existing staged area.
      if (state.stagedStageId && state._stagedBasisDigest != null) {
        renderStagedAction(state.stagedStageId, state._stagedBasisDigest, state._stagedBasisRevision, state.feasibility);
      }
      // Refresh state to show what changed.
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
      renderAll();
      if (execBtn) execBtn.disabled = false;
    } else {
      if (execBtn) execBtn.disabled = false;
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
    const kind = scenario === "queue-storm" ? "database-pressure-queue-storm" : "replica-loss";
    const snap = await api("POST", "/api/inject", { kind });
    if (snap.kind === "injected") {
      const obs = await api("GET", "/api/observe");
      state.currentState = obs.state;
      state.events = obs.events;
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
    // Reset client state.
    state.currentState = null;
    state.proposals = [];
    state.selectedProposal = null;
    state.feasibility = null;
    state.stagedStageId = null;
    state._stagedBasisDigest = null;
    state._stagedBasisRevision = null;
    state.events = [];

    showWorkspace();
    await doObserve();
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
    if (!res.ok) return false; // no live session
    const json = await res.json().catch(() => null);
    if (!json || !json.csrfToken) return false;
    state.csrfToken = json.csrfToken;
    state.currentState = json.state;
    state.events = json.events;
    return true;
  } catch {
    return false;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function boot() {
  // Attempt to restore a previous session before showing setup.
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

  // Allow Enter key on seed/tickLimit fields to submit.
  [$("seed-input"), $("tick-limit-input"), $("scenario-select")].forEach(el => {
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") startSession(); });
  });

  $("new-session-btn").addEventListener("click", () => {
    showSetup();
    $("setup-error").textContent = "";
  });

  $("tick-btn").addEventListener("click", doTick);
  $("observe-btn").addEventListener("click", doObserve);
  $("propose-btn").addEventListener("click", doPropose);
  $("execute-btn").addEventListener("click", doExecute);

  const injectBtn = $("inject-btn");
  if (injectBtn) injectBtn.addEventListener("click", doInject);
}

document.addEventListener("DOMContentLoaded", boot);
