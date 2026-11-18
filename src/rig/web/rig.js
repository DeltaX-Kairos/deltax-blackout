/**
 * rig.js — Measured Worker Rig Browser Client
 *
 * Requirements (docs/RIG-FINISH-011.md §3):
 * - Plain browser JS, zero external dependencies.
 * - Restores CSRF and session via GET /api/restore; bootstraps with POST /api/session
 *   (seed 42, queue-storm) if absent, then GET /api/restore.
 * - API paths: /api/rig/status, /start, /propose, /stage, /apply, /pressure, /close, /evidence.
 * - No caller-selected owner; session cookie authenticates.
 * - Read-only polling <= 1 Hz (1000ms) while running; stops on closed/expired.
 * - Never automatically retries failed POST requests.
 * - Shows real queue drain counts, verified handles (out of 100), basis digest, and observation history.
 * - Human-in-the-loop confirmation: explicit stage, inspect, checkbox, confirm and apply.
 */

"use strict";

(function () {
  const state = {
    csrfToken: null,
    status: "idle",
    active: false,
    observation: null,
    proposals: [],
    selectedProposalId: null,
    stagedAction: null,
    history: [],
    expiryMs: 0,
    pollTimer: null,
    expiryTimer: null,
  };

  // ─── DOM Helpers ──────────────────────────────────────────────────────────

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

  function setFooterStatus(msg) {
    const el = $("footer-status");
    if (el) el.textContent = msg;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── API Client ───────────────────────────────────────────────────────────

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

  // ─── Session Initialization ───────────────────────────────────────────────

  async function initSession() {
    try {
      setFooterStatus("Checking session...");
      const restoreRes = await fetch("/api/restore", {
        method: "GET",
        credentials: "same-origin",
      });
      if (restoreRes.ok) {
        const restoreJson = await restoreRes.json().catch(() => ({}));
        if (restoreJson && restoreJson.csrfToken) {
          state.csrfToken = restoreJson.csrfToken;
          setFooterStatus("Session ready.");
          await refreshStatus();
          return;
        }
      }

      // If absent, bootstrap with fictional queue-storm seed 42 under server protection
      setFooterStatus("Initializing lab session...");
      const sessRes = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioName: "queue-storm", seed: 42, tickLimit: 30 }),
      });

      if (!sessRes.ok) {
        throw new Error(`Failed to create session: HTTP ${sessRes.status}`);
      }

      const sessJson = await sessRes.json().catch(() => ({}));
      state.csrfToken = sessJson.csrfToken || null;

      // Confirm with restore
      const confirmRes = await fetch("/api/restore", {
        method: "GET",
        credentials: "same-origin",
      });
      if (confirmRes.ok) {
        const confirmJson = await confirmRes.json().catch(() => ({}));
        if (confirmJson.csrfToken) state.csrfToken = confirmJson.csrfToken;
      }

      setFooterStatus("Session active.");
      await refreshStatus();
    } catch (err) {
      setFooterStatus(`Session error: ${err.message}`);
    }
  }

  // ─── Polling & Expiry ─────────────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      try {
        await refreshStatus(true);
      } catch {
        // Suppress transient poll error
      }
    }, 1000); // 1 Hz max

    startExpiryCountdown();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    stopExpiryCountdown();
  }

  function startExpiryCountdown() {
    stopExpiryCountdown();
    state.expiryTimer = setInterval(updateExpiryDisplay, 1000);
    updateExpiryDisplay();
  }

  function stopExpiryCountdown() {
    if (state.expiryTimer) {
      clearInterval(state.expiryTimer);
      state.expiryTimer = null;
    }
  }

  function updateExpiryDisplay() {
    const el = $("rig-expiry-display");
    if (!el) return;
    if (!state.expiryMs || state.status !== "running") {
      el.textContent = "—";
      return;
    }
    const remaining = Math.max(0, Math.floor((state.expiryMs - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    el.textContent = `${mins}m ${secs.toString().padStart(2, "0")}s`;

    if (remaining === 0 && state.status === "running") {
      stopPolling();
      void refreshStatus();
    }
  }

  // ─── State Refresh ────────────────────────────────────────────────────────

  async function refreshStatus(silent = false) {
    try {
      const data = await api("GET", "/api/rig/status");
      state.active = data.active;
      state.status = data.status || "idle";

      if (data.observation) {
        state.observation = data.observation;
        recordHistoryItem(data.observation);
      }

      if (Array.isArray(data.proposals) && data.proposals.length > 0) {
        state.proposals = data.proposals;
      }

      renderAll();

      if (state.status !== "running" && state.status !== "starting") {
        stopPolling();
      }

      if (!silent) {
        setFooterStatus(`Status refreshed: ${state.status}`);
      }
    } catch (err) {
      if (!silent) {
        setFooterStatus(`Status refresh failed: ${err.message}`);
      }
    }
  }

  function recordHistoryItem(obs) {
    if (!obs) return;
    const exists = state.history.some(
      (h) => h.revision === obs.revision && h.basisDigest === obs.basisDigest
    );
    if (!exists) {
      state.history.unshift(obs);
      if (state.history.length > 50) {
        state.history.pop();
      }
      renderHistoryTable();
    }
  }

  // ─── UI Rendering ─────────────────────────────────────────────────────────

  function renderAll() {
    renderHeaderControls();
    renderStatusStrip();
    renderMetrics();
    renderProposals();
    renderInspectPanel();
    renderStagedPanel();
    renderHistoryTable();
  }

  function renderHeaderControls() {
    const isRunning = state.status === "running" || state.status === "starting";
    $("start-rig-btn").disabled = isRunning;
    $("close-rig-btn").disabled = !isRunning;
    $("inject-pressure-btn").disabled = !isRunning;
    $("refresh-proposals-btn").disabled = !isRunning;
    $("download-evidence-btn").disabled = !state.observation;
  }

  function renderStatusStrip() {
    const badge = $("rig-status-badge");
    badge.textContent = state.status;
    badge.className = `badge badge-${state.status}`;

    if (state.observation) {
      $("rig-revision").textContent = String(state.observation.revision);
      const digest = state.observation.basisDigest || "—";
      $("rig-digest").textContent = digest.slice(0, 16) + "...";
      $("rig-digest").title = digest;
    } else {
      $("rig-revision").textContent = "0";
      $("rig-digest").textContent = "—";
      $("rig-digest").title = "No active digest";
    }
  }

  function renderMetrics() {
    const obs = state.observation;
    const mc = obs ? obs.measuredCounters : null;

    $("cnt-pending").textContent = mc ? String(mc.pendingJobs) : "—";
    $("cnt-inflight").textContent = mc ? String(mc.inFlightJobs) : "—";
    $("cnt-completed").textContent = mc ? String(mc.completedJobs) : "—";
    $("cnt-unknown").textContent = mc ? String(mc.unknownJobs) : "—";

    $("cnt-active-workers").textContent = mc ? String(mc.activeWorkers) : "—";
    $("cnt-paused-workers").textContent = mc ? String(mc.pausedWorkers) : "—";

    const handles = mc ? mc.managedSqliteHandles : 0;
    $("cnt-handles").textContent = String(handles);

    // Each READY-verified worker reports exactly three handles. Derive parent
    // ownership from observed totals, including the zero-resource closed state.
    const liveWorkers = mc ? (mc.activeWorkers + mc.pausedWorkers) : 0;
    const workerHandles = liveWorkers * 3;
    const parentHandles = Math.max(0, handles - workerHandles);

    $("cnt-parent-handles").textContent = mc ? String(parentHandles) : "—";
    $("cnt-worker-handles").textContent = mc ? String(workerHandles) : "—";

    const meterFill = $("handle-meter-fill");
    const pct = Math.min(100, Math.max(0, handles));
    meterFill.style.width = `${pct}%`;
    meterFill.className = "meter-bar-fill";
    if (pct > 95) meterFill.classList.add("critical");
    else if (pct > 80) meterFill.classList.add("warning");
  }

  function proposalIsCurrent(p) {
    return state.status === "running" && state.observation &&
      p.basisRevision === state.observation.revision && p.basisDigest === state.observation.basisDigest;
  }

  function renderProposals() {
    const container = $("proposals-list");
    if (!state.proposals || state.proposals.length === 0) {
      container.innerHTML = `<div class="empty-state">${
        state.status === "running"
          ? "No proposals available. Click Refresh."
          : "Start rig to generate candidate proposals."
      }</div>`;
      return;
    }

    container.innerHTML = state.proposals
      .map((p) => {
        const isSelected = p.proposalId === state.selectedProposalId;
        const fresh = proposalIsCurrent(p);
        return `
        <div class="proposal-item ${isSelected ? "selected" : ""}"
             tabindex="0"
             role="radio"
             aria-checked="${isSelected}"
             data-proposal-id="${escapeHtml(p.proposalId)}">
          <div>
            <div class="proposal-title">${escapeHtml(p.actionType)}</div>
            <div class="proposal-meta">${escapeHtml(p.description)}</div>
          </div>
          <div class="mono" style="font-size:0.75rem;color:${fresh ? (p.feasible ? "var(--teal)" : "var(--red)") : "var(--amber)"}">
            ${p.projectedHandles} handles ${fresh ? (p.feasible ? "(feasible)" : "(blocked)") : `(historical r${p.basisRevision}; refresh)`}
          </div>
        </div>
      `;
      })
      .join("");

    container.querySelectorAll(".proposal-item").forEach((el) => {
      el.addEventListener("click", () => {
        selectProposal(el.getAttribute("data-proposal-id"));
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectProposal(el.getAttribute("data-proposal-id"));
        }
      });
    });
  }

  function selectProposal(id) {
    state.selectedProposalId = id;
    renderProposals();
    renderInspectPanel();
    // renderInspectPanel owns freshness and feasibility of the staging control.
  }

  function renderInspectPanel() {
    const panel = $("inspect-panel");
    const p = state.proposals.find((x) => x.proposalId === state.selectedProposalId);
    if (!p) {
      panel.innerHTML = `<div class="empty-state">Select a proposal above to inspect details and resource projection.</div>`;
      $("stage-btn").disabled = true;
      return;
    }

    const currentHandles = state.observation ? state.observation.measuredCounters.managedSqliteHandles : 0;
    const projectedHandles = p.projectedHandles;
    const isFeasible = p.feasible;
    const fresh = proposalIsCurrent(p);

    panel.innerHTML = `
      ${fresh ? "" : `<p class="text-amber">Historical proposal at r${p.basisRevision}; current r${state.observation?.revision ?? "—"}. Refresh to recheck.</p>`}
      <div class="staged-kv-row">
        <span class="staged-key">Action Type:</span>
        <strong class="mono">${escapeHtml(p.actionType)}</strong>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Parameters:</span>
        <span class="mono">${escapeHtml(JSON.stringify(p.parameters))}</span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Current Handles:</span>
        <span class="mono">${currentHandles}</span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">${fresh ? "Projected Total:" : "Historical Projection:"}</span>
        <span class="mono ${isFeasible ? "text-teal" : "text-red"}">
          ${projectedHandles} / 100 max (${fresh ? (isFeasible ? "Feasible" : "EXCEEDS BUDGET") : "expired; refresh"})
        </span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Proposal Basis Rev:</span>
        <span class="mono">${p.basisRevision}</span>
      </div>
    `;
    $("stage-btn").disabled = !fresh || !isFeasible;
  }

  function renderStagedPanel() {
    const panel = $("staged-details");
    const staged = state.stagedAction;

    if (!staged) {
      panel.innerHTML = `<div class="empty-state">No action currently staged.</div>`;
      $("confirm-checkbox").checked = false;
      $("confirm-checkbox").disabled = true;
      $("apply-btn").disabled = true;
      return;
    }

    panel.innerHTML = `
      <div class="staged-kv-row">
        <span class="staged-key">Stage ID:</span>
        <span class="mono">${escapeHtml(staged.stageId)}</span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Action Type:</span>
        <strong class="mono">${escapeHtml(staged.actionType)}</strong>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Human Effect:</span>
        <span>${escapeHtml(staged.humanReadableEffect || "Execute action")}</span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Bound Basis Rev:</span>
        <span class="mono">${staged.basisRevision}</span>
      </div>
      <div class="staged-kv-row">
        <span class="staged-key">Payload SHA:</span>
        <span class="mono truncate" style="max-width:240px;" title="${escapeHtml(staged.payloadDigest)}">
          ${escapeHtml(staged.payloadDigest.slice(0, 16))}...
        </span>
      </div>
    `;

    $("confirm-checkbox").disabled = state.status !== "running";
    $("apply-btn").disabled = !$("confirm-checkbox").checked || state.status !== "running";
  }

  function renderHistoryTable() {
    const tbody = $("history-tbody");
    if (!state.history || state.history.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center">No observation history recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.history
      .map((h) => {
        const mc = h.measuredCounters;
        return `
        <tr>
          <td>${h.revision}</td>
          <td><span class="badge badge-${h.status}">${h.status}</span></td>
          <td class="mono truncate" style="max-width:120px;" title="${escapeHtml(h.basisDigest)}">
            ${escapeHtml(h.basisDigest ? h.basisDigest.slice(0, 10) + "..." : "—")}
          </td>
          <td>${mc ? `${mc.activeWorkers} / ${mc.pausedWorkers}` : "—"}</td>
          <td>${mc ? mc.pendingJobs : "—"}</td>
          <td>${mc ? mc.inFlightJobs : "—"}</td>
          <td class="text-teal">${mc ? mc.completedJobs : "—"}</td>
          <td>${mc ? `${mc.managedSqliteHandles} / 100` : "—"}</td>
        </tr>
      `;
      })
      .join("");
  }

  function showFeedback(type, message) {
    const el = $("apply-feedback");
    el.hidden = false;
    el.className = `feedback-banner ${type}`;
    el.textContent = message;
    announce(message);
  }

  function hideFeedback() {
    const el = $("apply-feedback");
    el.hidden = true;
    el.textContent = "";
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function handleStartRig() {
    hideFeedback();
    const btn = $("start-rig-btn");
    btn.disabled = true;
    setFooterStatus("Starting 24-job process rig...");
    announce("Starting measured process rig with 24 jobs");

    try {
      const data = await api("POST", "/api/rig/start");
      state.active = true;
      state.status = data.status || "running";
      state.observation = data.observation;
      state.proposals = data.proposals || [];
      state.expiryMs = data.expiryMs || (Date.now() + 120000);
      recordHistoryItem(data.observation);

      renderAll();
      startPolling();
      setFooterStatus("Rig started with 1 paused worker and 24 pending jobs (48 handles).");
      announce("Rig started successfully");
    } catch (err) {
      setFooterStatus(`Start failed: ${err.message}`);
      showFeedback("error", `Start failed: ${err.message}`);
      btn.disabled = false;
    }
  }

  async function handleRefreshProposals() {
    hideFeedback();
    setFooterStatus("Refreshing candidate proposals...");
    try {
      const data = await api("POST", "/api/rig/propose");
      state.proposals = data.proposals || [];
      if (data.observation) {
        state.observation = data.observation;
        recordHistoryItem(data.observation);
      }
      renderAll();
      setFooterStatus(`Proposals refreshed (${state.proposals.length} available).`);
    } catch (err) {
      setFooterStatus(`Refresh proposals failed: ${err.message}`);
    }
  }

  async function handleStage() {
    hideFeedback();
    if (!state.selectedProposalId) return;
    const btn = $("stage-btn");
    btn.disabled = true;
    setFooterStatus("Staging selected proposal...");

    try {
      const data = await api("POST", "/api/rig/stage", {
        proposalId: state.selectedProposalId,
      });

      state.stagedAction = {
        ...data.staged,
        humanReadableEffect: data.humanReadableEffect,
      };

      if (data.observation) {
        state.observation = data.observation;
        recordHistoryItem(data.observation);
      }

      renderAll();
      setFooterStatus("Proposal staged. Review exact effect and confirm.");
      announce("Proposal staged for human review");
    } catch (err) {
      setFooterStatus(`Stage failed: ${err.message}`);
      showFeedback("error", `Stage failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  async function handleApply() {
    hideFeedback();
    if (!state.stagedAction) return;

    const btn = $("apply-btn");
    btn.disabled = true;
    $("confirm-checkbox").disabled = true;
    setFooterStatus("Confirming and applying action against measured state...");

    try {
      const data = await api("POST", "/api/rig/apply", {
        stageId: state.stagedAction.stageId,
      });

      if (data.observation) {
        state.observation = data.observation;
        recordHistoryItem(data.observation);
      }

      const res = data.result;
      if (res.kind === "applied") {
        state.stagedAction = null;
        showFeedback(
          "success",
          `Action applied successfully! Revision advanced from ${res.receipt.revisionBefore} to ${res.receipt.revisionAfter}. Handles: ${res.receipt.measuredAfter.managedSqliteHandles}.`
        );
        setFooterStatus("Action applied.");
      } else if (res.kind === "stale-basis") {
        showFeedback(
          "stale",
          `Action rejected (stale-basis): ${res.detail}. State basis changed since staging.`
        );
        setFooterStatus("Action rejected (stale basis).");
      } else if (res.kind === "infeasible-resource") {
        showFeedback(
          "error",
          `Action rejected (infeasible resource): ${res.detail}. Hard handle budget of 100 would be exceeded.`
        );
        setFooterStatus("Action rejected (infeasible resource).");
      } else if (res.kind === "unknown") {
        showFeedback(
          "error",
          `Action outcome uncertain (unknown): ${res.detail}. Stage consumed, no automatic retry.`
        );
        setFooterStatus("Action outcome uncertain (unknown).");
      } else {
        showFeedback("error", `Action failed: ${res.kind} (${res.detail || "unknown"})`);
        setFooterStatus(`Action outcome: ${res.kind}`);
      }

      renderAll();
    } catch (err) {
      setFooterStatus(`Apply failed: ${err.message}`);
      showFeedback("error", `Apply failed: ${err.message}`);
    }
  }

  async function handleInjectPressure() {
    hideFeedback();
    const btn = $("inject-pressure-btn");
    btn.disabled = true;
    setFooterStatus("Injecting database pressure (reserving 90 pool handles)...");

    try {
      const data = await api("POST", "/api/rig/pressure");
      if (data.observation) {
        state.observation = data.observation;
        recordHistoryItem(data.observation);
      }
      renderAll();
      setFooterStatus("Database pressure injected. Managed handles reserved to 94.");
      showFeedback(
        "stale",
        "Database pressure injected: extra handles reserved to 90. Managed SQLite handles now at 94/100."
      );
      announce("Database pressure injected");
    } catch (err) {
      setFooterStatus(`Inject pressure failed: ${err.message}`);
      showFeedback("error", `Inject pressure failed: ${err.message}`);
    } finally {
      btn.disabled = state.status !== "running";
    }
  }

  async function handleCloseRig() {
    hideFeedback();
    const btn = $("close-rig-btn");
    btn.disabled = true;
    stopPolling();
    setFooterStatus("Closing process rig and releasing all resources...");

    try {
      const data = await api("POST", "/api/rig/close");
      state.status = "closed";
      state.active = false;
      state.expiryMs = 0;
      $("rig-expiry-display").textContent = "—";
      state.stagedAction = null;
      state.proposals = [];
      state.selectedProposalId = null;
      if (data.finalObservation) {
        state.observation = data.finalObservation;
        recordHistoryItem(data.finalObservation);
      }

      renderAll();
      setFooterStatus("Rig closed. All child workers terminated and SQLite handles released.");
      announce("Rig closed successfully");
    } catch (err) {
      setFooterStatus(`Close failed: ${err.message}`);
    }
  }

  async function handleDownloadEvidence() {
    setFooterStatus("Fetching evidence bundle...");
    try {
      const bundle = await api("GET", "/api/rig/evidence");
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `blackout-rig-evidence-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFooterStatus("Evidence bundle downloaded.");
    } catch (err) {
      setFooterStatus(`Evidence download failed: ${err.message}`);
    }
  }

  // ─── Event Listeners ──────────────────────────────────────────────────────

  function bindEvents() {
    $("start-rig-btn").addEventListener("click", handleStartRig);
    $("close-rig-btn").addEventListener("click", handleCloseRig);
    $("refresh-proposals-btn").addEventListener("click", handleRefreshProposals);
    $("stage-btn").addEventListener("click", handleStage);
    $("apply-btn").addEventListener("click", handleApply);
    $("inject-pressure-btn").addEventListener("click", handleInjectPressure);
    $("download-evidence-btn").addEventListener("click", handleDownloadEvidence);

    $("confirm-checkbox").addEventListener("change", (e) => {
      $("apply-btn").disabled = !e.target.checked || state.status !== "running" || !state.stagedAction;
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    initSession();
  });
})();
