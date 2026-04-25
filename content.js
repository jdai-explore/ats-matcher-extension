/**
 * content.js — ATS Resume Matcher Content Script
 * Runs on: linkedin.com/jobs/*
 * Responsibilities:
 *   1. Detect when a job posting is visible
 *   2. Scrape the job description text
 *   3. Request analysis from background service worker
 *   4. Inject a score widget near the Apply button
 *   5. Show a slide-out sidebar with full results
 */

(function () {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────────────

  let currentJobId      = null;
  let sidebarOpen       = false;
  let lastAnalysis      = null;
  let analysisInFlight  = false;
  let observer          = null;

  // ─── Entry Point ─────────────────────────────────────────────────────────────

  init();

  function init() {
    console.log("[ATS Matcher] Content script loaded on:", location.href);
    watchUrlChanges();
    onPageChange();
  }

  function watchUrlChanges() {
    let lastUrl = location.href;
    observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Small delay to let LinkedIn's content render
        setTimeout(onPageChange, 800);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onPageChange() {
    const jobId = extractJobId();
    console.log("[ATS Matcher] onPageChange — URL:", location.href, "jobId:", jobId);
    if (!jobId) {
      removeWidget();
      return;
    }
    if (jobId === currentJobId) return; // same job, no re-analysis
    currentJobId = jobId;
    removeWidget();
    waitForJobDescription();
  }

  // ─── LinkedIn Page Detection ─────────────────────────────────────────────────

  function extractJobId() {
    // Pattern 1: /jobs/view/1234567
    const viewMatch = location.href.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    // Pattern 2: ?currentJobId=1234567 (search results, collections, feed)
    const paramMatch = location.href.match(/[?&]currentJobId=(\d+)/);
    if (paramMatch) return paramMatch[1];
    return null;
  }

  // ─── Wait for Job Description DOM ────────────────────────────────────────────

  function waitForJobDescription() {
    const MAX_WAIT = 8000; // 8 seconds
    const INTERVAL = 500;
    let elapsed = 0;

    const poll = setInterval(() => {
      elapsed += INTERVAL;
      const jdText = scrapeJobDescription();
      if (jdText && jdText.length > 100) {
        clearInterval(poll);
        injectLoadingWidget();
        requestAnalysis(jdText);
      } else if (elapsed >= MAX_WAIT) {
        clearInterval(poll);
        // Could not find JD — inject a "couldn't scan" badge
        injectErrorWidget("Couldn't read this job's description.");
      }
    }, INTERVAL);
  }

  // ─── Job Description Scraper ─────────────────────────────────────────────────

  function scrapeJobDescription() {
    const selectors = [
      // Current LinkedIn selectors (2024-2025)
      "#job-details",
      ".job-details-jobs-unified-top-card__job-insight",
      ".jobs-description__content",
      ".jobs-description-content__text",
      "[class*='jobs-description__content']",
      "[class*='description__text']",
      // Older fallbacks
      ".job-view-layout .jobs-description__content",
      ".jobs-box__html-content",
      ".jobs-description",
      ".description__text",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 80) {
        console.log("[ATS Matcher] JD found via selector:", sel, "— length:", el.innerText.trim().length);
        return el.innerText.trim();
      }
    }
    console.warn("[ATS Matcher] No JD element found. Tried:", selectors.join(", "));
    return null;
  }

  // ─── Communication with Background ──────────────────────────────────────────

  async function requestAnalysis(jobText) {
    if (analysisInFlight) return;
    analysisInFlight = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type:    "ANALYZE_JOB",
        jobText: jobText,
        jobId:   currentJobId,
      });

      analysisInFlight = false;

      if (!response || !response.ok) {
        injectErrorWidget(response?.error || "Analysis failed. Check your setup.");
        return;
      }

      lastAnalysis = response;
      injectScoreWidget(response);
    } catch (err) {
      analysisInFlight = false;
      injectErrorWidget(err.message);
    }
  }

  // ─── Widget Injection ─────────────────────────────────────────────────────────

  function getOrCreateHost() {
    let host = document.getElementById("ats-matcher-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "ats-matcher-host";
      document.body.appendChild(host);
    }
    return host;
  }

  function injectLoadingWidget() {
    const host = getOrCreateHost();
    let shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>${getStyles()}</style>
      <div class="ats-badge ats-badge--loading" id="ats-badge">
        <div class="ats-badge__spinner"></div>
        <span>Scanning…</span>
      </div>
      <div class="ats-sidebar" id="ats-sidebar"></div>
    `;

    addBadgeClickListener(shadow);
  }

  function injectScoreWidget(data) {
    const host = getOrCreateHost();
    let shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({ mode: "open" });

    const { score, jobTitle, seniority } = data;
    const { label, cls } = scoreAppearance(score);

    shadow.innerHTML = `
      <style>${getStyles()}</style>
      <div class="ats-badge ${cls}" id="ats-badge" title="Click to see full ATS analysis">
        <span class="ats-badge__icon">${scoreIcon(score)}</span>
        <span class="ats-badge__score">${score}%</span>
        <span class="ats-badge__label">${label}</span>
        <span class="ats-badge__chevron">›</span>
      </div>
      ${buildSidebarHTML(data)}
    `;

    addBadgeClickListener(shadow);
    addSidebarListeners(shadow);
  }

  function injectErrorWidget(message) {
    const host = getOrCreateHost();
    let shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({ mode: "open" });

    const isSetup = message.includes("No API key") || message.includes("No resume");

    shadow.innerHTML = `
      <style>${getStyles()}</style>
      <div class="ats-badge ats-badge--error" id="ats-badge" title="${escHtml(message)}">
        <span class="ats-badge__icon">⚠️</span>
        <span class="ats-badge__label">${isSetup ? "Setup needed" : "Scan failed"}</span>
        <span class="ats-badge__chevron">›</span>
      </div>
      <div class="ats-sidebar" id="ats-sidebar">
        <div class="ats-sidebar__inner">
          <div class="ats-sidebar__header ats-sidebar__header--error">
            <span>⚠️ ${isSetup ? "Setup Required" : "Error"}</span>
            <button class="ats-close-btn" id="ats-close">✕</button>
          </div>
          <div class="ats-sidebar__body">
            <p class="ats-error-msg">${escHtml(message)}</p>
            ${isSetup ? `<button class="ats-btn ats-btn--primary" id="ats-open-popup">Open Extension Settings</button>` : ""}
          </div>
        </div>
      </div>
    `;

    addBadgeClickListener(shadow);
    addSidebarListeners(shadow);
    if (isSetup) {
      shadow.getElementById("ats-open-popup")?.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
      });
    }
  }

  function removeWidget() {
    const host = document.getElementById("ats-matcher-host");
    if (host) host.remove();
    currentJobId     = null;
    lastAnalysis     = null;
    sidebarOpen      = false;
    analysisInFlight = false;
  }

  // ─── Sidebar HTML Builder ────────────────────────────────────────────────────

  function buildSidebarHTML(data) {
    const {
      score, jobTitle, seniority, suggestion,
      matchedRequired, missingRequired,
      matchedPreferred, missingPreferred,
      paretoSkills = [],
    } = data;

    const { cls } = scoreAppearance(score);

    const renderChips = (items, type) =>
      items.length === 0
        ? `<p class="ats-empty">None</p>`
        : items.map(k => `<span class="ats-chip ats-chip--${type}">${escHtml(k)}</span>`).join("");

    return `
      <div class="ats-sidebar" id="ats-sidebar">
        <div class="ats-sidebar__inner">
          <div class="ats-sidebar__header ${cls}">
            <div class="ats-sidebar__title">
              <span class="ats-sidebar__icon">${scoreIcon(score)}</span>
              <div>
                <div class="ats-sidebar__score-big">${score}% ATS Match</div>
                ${jobTitle ? `<div class="ats-sidebar__role">${escHtml(jobTitle)}${seniority ? " · " + escHtml(seniority) : ""}</div>` : ""}
              </div>
            </div>
            <button class="ats-close-btn" id="ats-close">✕</button>
          </div>

          <div class="ats-score-bar-wrap">
            <div class="ats-score-bar">
              <div class="ats-score-bar__fill ${cls}" style="width:${score}%"></div>
            </div>
            <div class="ats-score-legend">
              <span>0</span><span>50</span><span>80</span><span>100</span>
            </div>
          </div>

          <div class="ats-sidebar__body">
            <div class="ats-suggestion">
              <span class="ats-suggestion__icon">💡</span>
              <p>${escHtml(suggestion)}</p>
            </div>

            ${paretoSkills.length > 0 ? `
            <div class="ats-section">
              <div class="ats-section__header ats-section__header--pareto">
                <span>🎯 Add These ${paretoSkills.length} to Hit 90%</span>
                <span class="ats-count">${paretoSkills.length}</span>
              </div>
              <div class="ats-chips">
                ${paretoSkills.map(p =>
                  `<span class="ats-chip ats-chip--pareto" title="${p.type === 'required' ? 'Required' : 'Preferred'}">${escHtml(p.skill)}</span>`
                ).join("")}
              </div>
            </div>` : ""}

            <div class="ats-section">
              <div class="ats-section__header ats-section__header--green">
                <span>✅ Required Skills Matched</span>
                <span class="ats-count">${matchedRequired.length}</span>
              </div>
              <div class="ats-chips">${renderChips(matchedRequired, "matched")}</div>
            </div>

            <div class="ats-section">
              <div class="ats-section__header ats-section__header--red">
                <span>❌ Required Skills Missing</span>
                <span class="ats-count">${missingRequired.length}</span>
              </div>
              <div class="ats-chips">${renderChips(missingRequired, "missing")}</div>
            </div>

            <div class="ats-section">
              <div class="ats-section__header ats-section__header--blue">
                <span>👍 Preferred Skills Matched</span>
                <span class="ats-count">${matchedPreferred.length}</span>
              </div>
              <div class="ats-chips">${renderChips(matchedPreferred, "preferred-matched")}</div>
            </div>

            <div class="ats-section">
              <div class="ats-section__header ats-section__header--orange">
                <span>➕ Preferred Skills to Add</span>
                <span class="ats-count">${missingPreferred.length}</span>
              </div>
              <div class="ats-chips">${renderChips(missingPreferred, "preferred-missing")}</div>
            </div>

            <div class="ats-footer">
              <p class="ats-footer__note">Powered by Gemini AI · Your data stays on your device</p>
              <button class="ats-btn ats-btn--secondary" id="ats-reanalyze">🔄 Re-analyze</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Event Listeners ─────────────────────────────────────────────────────────

  function addBadgeClickListener(shadow) {
    shadow.getElementById("ats-badge")?.addEventListener("click", () => {
      toggleSidebar(shadow);
    });
  }

  function addSidebarListeners(shadow) {
    shadow.getElementById("ats-close")?.addEventListener("click", () => {
      closeSidebar(shadow);
    });

    shadow.getElementById("ats-reanalyze")?.addEventListener("click", () => {
      closeSidebar(shadow);
      currentJobId = null; // force re-analysis
      onPageChange();
    });
  }

  function toggleSidebar(shadow) {
    const sidebar = shadow.getElementById("ats-sidebar");
    if (!sidebar) return;
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle("ats-sidebar--open", sidebarOpen);
  }

  function closeSidebar(shadow) {
    sidebarOpen = false;
    shadow.getElementById("ats-sidebar")?.classList.remove("ats-sidebar--open");
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function scoreAppearance(score) {
    if (score >= 80) return { label: "Great Match",  cls: "ats-badge--green"  };
    if (score >= 60) return { label: "Good Match",   cls: "ats-badge--yellow" };
    if (score >= 40) return { label: "Partial Match",cls: "ats-badge--orange" };
    return               { label: "Low Match",    cls: "ats-badge--red"    };
  }

  function scoreIcon(score) {
    if (score >= 80) return "✅";
    if (score >= 60) return "⚠️";
    if (score >= 40) return "🔶";
    return "❌";
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ─── Styles (Shadow DOM — fully isolated from LinkedIn CSS) ──────────────────

  function getStyles() {
    return `
      /* Reset */
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      /* ── Badge (floating pill) ── */
      .ats-badge {
        position: fixed;
        bottom: 32px;
        right: 24px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 16px;
        border-radius: 40px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.10);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        user-select: none;
        letter-spacing: 0.01em;
      }
      .ats-badge:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 28px rgba(0,0,0,0.22);
      }
      .ats-badge:active { transform: translateY(0); }

      .ats-badge--green  { background: #16a34a; color: #fff; }
      .ats-badge--yellow { background: #ca8a04; color: #fff; }
      .ats-badge--orange { background: #ea580c; color: #fff; }
      .ats-badge--red    { background: #dc2626; color: #fff; }
      .ats-badge--error  { background: #6b7280; color: #fff; }
      .ats-badge--loading{ background: #6366f1; color: #fff; }

      .ats-badge__score  { font-size: 16px; font-weight: 700; }
      .ats-badge__label  { font-size: 12px; opacity: 0.92; }
      .ats-badge__chevron{ font-size: 18px; opacity: 0.8; margin-left: 2px; }

      /* Spinner */
      .ats-badge__spinner {
        width: 16px; height: 16px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: ats-spin 0.75s linear infinite;
      }
      @keyframes ats-spin { to { transform: rotate(360deg); } }

      /* ── Sidebar ── */
      .ats-sidebar {
        position: fixed;
        top: 0; right: 0;
        height: 100vh;
        width: 380px;
        z-index: 2147483646;
        transform: translateX(100%);
        transition: transform 0.28s cubic-bezier(0.4,0,0.2,1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: none;
      }
      .ats-sidebar--open {
        transform: translateX(0);
        pointer-events: all;
      }
      .ats-sidebar__inner {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #ffffff;
        box-shadow: -4px 0 32px rgba(0,0,0,0.14);
        overflow: hidden;
      }

      /* Header */
      .ats-sidebar__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 20px;
        color: #fff;
        flex-shrink: 0;
      }
      .ats-sidebar__header.ats-badge--green  { background: #16a34a; }
      .ats-sidebar__header.ats-badge--yellow { background: #ca8a04; }
      .ats-sidebar__header.ats-badge--orange { background: #ea580c; }
      .ats-sidebar__header.ats-badge--red    { background: #dc2626; }
      .ats-sidebar__header.ats-badge--error  { background: #6b7280; font-size: 15px; }
      .ats-sidebar__header--error            { background: #6b7280; font-size: 15px; }

      .ats-sidebar__title {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .ats-sidebar__icon    { font-size: 28px; line-height: 1; }
      .ats-sidebar__score-big { font-size: 22px; font-weight: 700; line-height: 1.2; }
      .ats-sidebar__role    { font-size: 12px; opacity: 0.88; margin-top: 2px; }

      .ats-close-btn {
        background: rgba(255,255,255,0.2);
        border: none;
        color: #fff;
        font-size: 16px;
        width: 30px; height: 30px;
        border-radius: 50%;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      .ats-close-btn:hover { background: rgba(255,255,255,0.35); }

      /* Score bar */
      .ats-score-bar-wrap { padding: 14px 20px 8px; flex-shrink: 0; background: #f9fafb; }
      .ats-score-bar {
        height: 8px;
        background: #e5e7eb;
        border-radius: 4px;
        overflow: hidden;
      }
      .ats-score-bar__fill {
        height: 100%;
        border-radius: 4px;
        transition: width 0.8s cubic-bezier(0.4,0,0.2,1);
      }
      .ats-score-bar__fill.ats-badge--green  { background: #16a34a; }
      .ats-score-bar__fill.ats-badge--yellow { background: #ca8a04; }
      .ats-score-bar__fill.ats-badge--orange { background: #ea580c; }
      .ats-score-bar__fill.ats-badge--red    { background: #dc2626; }
      .ats-score-legend {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: #9ca3af;
        margin-top: 4px;
      }

      /* Body */
      .ats-sidebar__body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .ats-sidebar__body::-webkit-scrollbar { width: 5px; }
      .ats-sidebar__body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }

      /* Suggestion box */
      .ats-suggestion {
        display: flex;
        gap: 10px;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 10px;
        padding: 12px 14px;
        font-size: 13px;
        color: #1e40af;
        line-height: 1.5;
      }
      .ats-suggestion__icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }

      /* Sections */
      .ats-section { display: flex; flex-direction: column; gap: 8px; }
      .ats-section__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 6px 10px;
        border-radius: 6px;
      }
      .ats-section__header--green  { background: #dcfce7; color: #166534; }
      .ats-section__header--red    { background: #fee2e2; color: #991b1b; }
      .ats-section__header--blue   { background: #dbeafe; color: #1e40af; }
      .ats-section__header--orange { background: #fed7aa; color: #9a3412; }
      .ats-section__header--pareto { background: #fdf4ff; color: #6b21a8; border: 1px solid #e9d5ff; font-size: 13px; }

      .ats-count {
        background: rgba(0,0,0,0.1);
        border-radius: 12px;
        padding: 1px 8px;
        font-size: 11px;
      }

      /* Keyword chips */
      .ats-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 2px 0;
      }
      .ats-chip {
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 20px;
        font-weight: 500;
        white-space: nowrap;
      }
      .ats-chip--matched          { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
      .ats-chip--missing          { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
      .ats-chip--preferred-matched{ background: #dbeafe; color: #1d4ed8; border: 1px solid #bfdbfe; }
      .ats-chip--preferred-missing{ background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
      .ats-chip--pareto           { background: #faf5ff; color: #7e22ce; border: 2px solid #d8b4fe; font-weight: 600; }

      .ats-empty { font-size: 12px; color: #9ca3af; font-style: italic; padding: 2px 4px; }

      /* Error message */
      .ats-error-msg {
        font-size: 14px;
        color: #374151;
        line-height: 1.6;
        padding: 8px 0;
      }

      /* Footer */
      .ats-footer {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        margin-top: 4px;
        padding-top: 16px;
        border-top: 1px solid #f3f4f6;
      }
      .ats-footer__note { font-size: 11px; color: #9ca3af; text-align: center; }

      /* Buttons */
      .ats-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 9px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: opacity 0.15s, transform 0.1s;
        width: 100%;
      }
      .ats-btn:hover   { opacity: 0.88; }
      .ats-btn:active  { transform: scale(0.98); }
      .ats-btn--primary   { background: #6366f1; color: #fff; }
      .ats-btn--secondary { background: #f3f4f6; color: #374151; }
    `;
  }

})();
