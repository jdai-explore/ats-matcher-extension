/**
 * onboarding.js — First-time setup flow
 * Steps: 1. Privacy consent → 2. API Key → 3. Resume Upload → 4. Ready
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────

let currentStep = 1;
const TOTAL_STEPS = 4;

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const progressFill = $("progress-fill");

// ─── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  const state = await sendMessage({ type: "GET_STATE" });

  // Skip already-completed steps
  if (state.gdprConsent && state.hasApiKey && state.hasResume) {
    goToStep(4);
  } else if (state.gdprConsent && state.hasApiKey) {
    goToStep(3);
  } else if (state.gdprConsent) {
    goToStep(2);
  } else {
    goToStep(1);
  }

  setupStep1();
  setupStep2();
  setupStep3();
  setupStep4();
})();

// ─── Step Navigation ──────────────────────────────────────────────────────────

function goToStep(n) {
  document.querySelectorAll(".step").forEach(el => el.classList.add("hidden"));
  $(`step-${n}`)?.classList.remove("hidden");
  currentStep = n;
  progressFill.style.width = `${((n - 1) / (TOTAL_STEPS - 1)) * 100}%`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ─── Step 1: Privacy Consent ──────────────────────────────────────────────────

function setupStep1() {
  const checkbox = $("consent-checkbox");
  const btnAccept = $("btn-accept");

  checkbox.addEventListener("change", () => {
    btnAccept.disabled = !checkbox.checked;
  });

  btnAccept.addEventListener("click", async () => {
    btnAccept.textContent = "Saving…";
    btnAccept.disabled = true;
    await sendMessage({ type: "SAVE_CONSENT" });
    goToStep(2);
  });
}

// ─── Step 2: API Key ──────────────────────────────────────────────────────────

function setupStep2() {
  const input    = $("api-key-input");
  const btnSave  = $("btn-save-key");
  const btnSkip  = $("btn-skip-key");
  const btnToggle= $("btn-toggle-key");
  const feedback = $("key-feedback");

  btnToggle.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") btnSave.click();
  });

  btnSave.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) { showFeedback(feedback, "Please enter your API key.", false); return; }

    setBtnLoading(btnSave, true, "Verifying…");
    const result = await sendMessage({ type: "SAVE_API_KEY", apiKey: key });
    setBtnLoading(btnSave, false, "Save & Continue →");

    if (result.ok) {
      showFeedback(feedback, "✓ API key saved!", true);
      setTimeout(() => goToStep(3), 800);
    } else {
      showFeedback(feedback, result.error || "Failed to save key.", false);
    }
  });

  btnSkip.addEventListener("click", () => goToStep(3));
}

// ─── Step 3: Resume Upload ────────────────────────────────────────────────────

function setupStep3() {
  const zone      = $("upload-zone");
  const input     = $("file-input");
  const btnBrowse = $("btn-browse");
  const btnSkip   = $("btn-skip-resume");
  const progress  = $("upload-progress");
  const feedback  = $("upload-feedback");
  const statusEl  = $("upload-status");

  btnBrowse.addEventListener("click", e => { e.stopPropagation(); input.click(); });
  zone.addEventListener("click", () => input.click());

  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  });

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) processFile(file);
    input.value = "";
  });

  btnSkip.addEventListener("click", () => goToStep(4));

  async function processFile(file) {
    const isPdf  = file.type === "application/pdf" || file.name.endsWith(".pdf");
    const isDocx = file.name.endsWith(".docx");

    if (!isPdf && !isDocx) {
      showFeedback(feedback, "Only PDF and DOCX files are supported.", false);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showFeedback(feedback, "File too large. Max 10 MB.", false);
      return;
    }

    feedback.classList.add("hidden");
    zone.classList.add("hidden");
    progress.classList.remove("hidden");

    try {
      let payload;

      if (isPdf) {
        setStatus("Reading PDF…");
        const base64 = await fileToBase64(file);
        payload = { type: "PARSE_RESUME", fileData: base64, mimeType: "application/pdf", fileName: file.name };
      } else {
        setStatus("Extracting text from DOCX…");
        const extractedText = await extractDocxText(file);
        payload = { type: "PARSE_RESUME", extractedText, mimeType: "docx", fileName: file.name };
      }

      setStatus("Analyzing keywords with Gemini AI…");
      const result = await sendMessage(payload);

      progress.classList.add("hidden");
      zone.classList.remove("hidden");

      if (!result?.ok) throw new Error(result?.error || "Analysis failed.");

      const count = result.resumeData?.allKeywords?.length || 0;
      showFeedback(feedback, `✅ Resume parsed! ${count} keywords extracted. Continuing…`, true);
      setTimeout(() => goToStep(4), 1200);

    } catch (err) {
      progress.classList.add("hidden");
      zone.classList.remove("hidden");
      showFeedback(feedback, `⚠️ ${err.message}`, false);
    }
  }

  function setStatus(txt) { statusEl.textContent = txt; }
}

// ─── Step 4: Ready ────────────────────────────────────────────────────────────

function setupStep4() {
  $("btn-go-linkedin")?.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/jobs/" });
    window.close();
  });

  $("btn-close-tab")?.addEventListener("click", () => window.close());
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function showFeedback(el, msg, ok) {
  el.textContent = msg;
  el.className   = `feedback ${ok ? "feedback--ok" : "feedback--err"}`;
  el.classList.remove("hidden");
}

function setBtnLoading(btn, loading, text) {
  btn.disabled    = loading;
  btn.textContent = text;
}

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "No response" });
      }
    });
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function extractDocxText(file) {
  if (typeof mammoth === "undefined") throw new Error("DOCX parser not available.");
  const arrayBuffer = await file.arrayBuffer();
  const result      = await mammoth.extractRawText({ arrayBuffer });
  if (!result.value || result.value.trim().length < 30)
    throw new Error("DOCX appears to be empty or unreadable.");
  return result.value;
}
