/**
 * popup.js — ATS Resume Matcher Extension Popup
 * Handles: state display, resume upload (PDF/DOCX), API key management, settings.
 */

"use strict";

// ─── DOM Refs ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const views = {
  loading:  $("view-loading"),
  setup:    $("view-setup"),
  ready:    $("view-ready"),
  settings: $("view-settings"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  const state = await sendMessage({ type: "GET_STATE" });

  if (!state.gdprConsent || !state.hasApiKey) {
    showSetupView(state);
  } else if (!state.hasResume) {
    // API key set but no resume yet — show ready view with upload prompt
    showReadyView(state);
  } else {
    showReadyView(state);
  }
})();

// ─── View Controllers ─────────────────────────────────────────────────────────

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
}

function showSetupView(state) {
  showView("setup");
  const stepsEl = $("setup-steps");
  const steps = [
    { label: "Accept Privacy Terms",       done: !!state.gdprConsent },
    { label: "Add Gemini API Key",         done: !!state.hasApiKey  },
    { label: "Upload your resume",         done: !!state.hasResume  },
  ];
  stepsEl.innerHTML = steps.map(s => `
    <div class="setup-step">
      <div class="setup-step__icon ${s.done ? "setup-step__icon--done" : "setup-step__icon--pending"}">
        ${s.done ? "✓" : "○"}
      </div>
      <span class="${s.done ? "setup-step__text--done" : ""}">${s.label}</span>
    </div>
  `).join("");

  $("btn-open-onboarding").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
    window.close();
  });
}

function showReadyView(state) {
  showView("ready");

  // Populate status card
  if (state.hasResume && state.resumeMeta) {
    $("status-filename").textContent = truncate(state.resumeMeta.fileName, 28);
    $("status-meta").textContent = `${state.keywordCount} keywords extracted · ${formatDate(state.resumeMeta.uploadedAt)}`;
  } else {
    $("status-card").innerHTML = `
      <div class="status-card__inner">
        <div class="status-icon">⚠️</div>
        <div class="status-info">
          <div class="status-filename">No resume uploaded</div>
          <div class="status-meta">Upload below to get started</div>
        </div>
      </div>
    `;
  }

  setupUploadZone();

  $("btn-settings").addEventListener("click", () => showSettingsView());
}

function showSettingsView() {
  showView("settings");
  loadApiKeyStatus();

  $("btn-back").addEventListener("click", async () => {
    const state = await sendMessage({ type: "GET_STATE" });
    showReadyView(state);
  });

  $("btn-save-key").addEventListener("click", saveApiKey);
  $("api-key-input").addEventListener("keydown", e => {
    if (e.key === "Enter") saveApiKey();
  });

  $("btn-delete-data").addEventListener("click", async () => {
    if (!confirm("Delete all stored data? This will remove your API key, resume keywords, and consent record. You'll need to set up again.")) return;
    await sendMessage({ type: "DELETE_ALL_DATA" });
    const state = await sendMessage({ type: "GET_STATE" });
    showSetupView(state);
  });

  $("btn-view-terms").addEventListener("click", e => {
    e.preventDefault();
    $("terms-modal").classList.remove("hidden");
  });
  $("btn-close-terms").addEventListener("click", () => {
    $("terms-modal").classList.add("hidden");
  });
}

async function loadApiKeyStatus() {
  const state = await sendMessage({ type: "GET_STATE" });
  if (state.hasApiKey) {
    $("api-key-input").placeholder = "••••••••••••••••••• (saved)";
  }
}

async function saveApiKey() {
  const key = $("api-key-input").value.trim();
  if (!key) {
    showKeyFeedback("Please enter an API key.", false);
    return;
  }

  $("btn-save-key").textContent = "…";
  $("btn-save-key").disabled = true;

  const result = await sendMessage({ type: "SAVE_API_KEY", apiKey: key });

  $("btn-save-key").textContent = "Save";
  $("btn-save-key").disabled = false;

  if (result.ok) {
    showKeyFeedback("✓ API key saved successfully!", true);
    $("api-key-input").value = "";
    $("api-key-input").placeholder = "••••••••••••••••••• (saved)";
  } else {
    showKeyFeedback(result.error || "Failed to save key.", false);
  }
}

function showKeyFeedback(msg, ok) {
  const el = $("key-feedback");
  el.textContent = msg;
  el.className = `key-feedback ${ok ? "key-feedback--ok" : "key-feedback--err"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

// ─── File Upload ──────────────────────────────────────────────────────────────

function setupUploadZone() {
  const zone    = $("upload-zone");
  const input   = $("file-input");
  const progress= $("upload-progress");
  const success = $("upload-success");
  const error   = $("upload-error");

  zone.addEventListener("click", () => input.click());

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) handleFile(file);
    input.value = ""; // reset so same file can be re-uploaded
  });

  async function handleFile(file) {
    // Validate file type
    const isPdf  = file.type === "application/pdf" || file.name.endsWith(".pdf");
    const isDocx = file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                   || file.name.endsWith(".docx");

    if (!isPdf && !isDocx) {
      showError("Only PDF and DOCX files are supported.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      showError("File is too large. Please use a file under 10 MB.");
      return;
    }

    // Hide previous feedback
    hideAll();
    zone.classList.add("hidden");
    progress.classList.remove("hidden");
    setStatusText("Reading file…");

    try {
      let payload;

      if (isPdf) {
        setStatusText("Reading PDF…");
        const base64 = await fileToBase64(file);
        payload = {
          type:     "PARSE_RESUME",
          fileData: base64,
          mimeType: "application/pdf",
          fileName: file.name,
          fileSize: file.size,
        };
      } else {
        setStatusText("Extracting text from DOCX…");
        const extractedText = await extractDocxText(file);
        payload = {
          type:          "PARSE_RESUME",
          extractedText: extractedText,
          mimeType:      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          fileName:      file.name,
          fileSize:      file.size,
        };
      }

      setStatusText("Analyzing with Gemini AI…");
      const result = await sendMessage(payload);

      if (!result || !result.ok) {
        throw new Error(result?.error || "Analysis failed. Please try again.");
      }

      progress.classList.add("hidden");
      zone.classList.remove("hidden");
      success.classList.remove("hidden");
      $("upload-kw-count").textContent = `${result.resumeData?.allKeywords?.length || 0}`;
      if (result.cached) {
        const note = success.querySelector(".upload-success__note");
        if (note) note.textContent = "Same file detected — used cached keywords (no API call).";
      }

    } catch (err) {
      progress.classList.add("hidden");
      zone.classList.remove("hidden");
      showError(err.message);
    }
  }

  function hideAll() {
    success.classList.add("hidden");
    error.classList.add("hidden");
  }

  function showError(msg) {
    error.textContent = "⚠️ " + msg;
    error.classList.remove("hidden");
  }

  function setStatusText(txt) {
    $("upload-status-text").textContent = txt;
  }
}

// ─── File Utilities ───────────────────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:application/pdf;base64,XXXXX" — strip prefix
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function extractDocxText(file) {
  // mammoth.js is loaded globally via <script> tag
  if (typeof mammoth === "undefined") {
    throw new Error("DOCX parser not loaded. Please reload the extension.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  if (!result.value || result.value.trim().length < 50) {
    throw new Error("Could not extract text from DOCX. Is it a valid Word document?");
  }
  return result.value;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: "No response" });
      }
    });
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + "…";
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
