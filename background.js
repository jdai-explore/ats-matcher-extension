/**
 * background.js — ATS Resume Matcher Service Worker
 * Handles: Gemini API calls, chrome.storage operations, message routing.
 * All user data stays in chrome.storage.local (on-device only).
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL    = "gemini-1.5-flash";
const STORAGE_KEYS    = {
  API_KEY:       "gemini_api_key",
  RESUME_DATA:   "resume_keywords",
  RESUME_META:   "resume_meta",       // filename, uploadedAt
  GDPR_CONSENT:  "gdpr_consent",
  SETUP_DONE:    "setup_complete",
};

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "SAVE_API_KEY":
          await saveApiKey(message.apiKey);
          sendResponse({ ok: true });
          break;

        case "SAVE_CONSENT":
          await chrome.storage.local.set({ [STORAGE_KEYS.GDPR_CONSENT]: true });
          sendResponse({ ok: true });
          break;

        case "PARSE_RESUME":
          // message.fileData = base64 string, message.mimeType, message.fileName, message.extractedText (for docx)
          const parseResult = await parseResume(message);
          sendResponse(parseResult);
          break;

        case "ANALYZE_JOB":
          // message.jobText = scraped job description
          const analysis = await analyzeJob(message.jobText);
          sendResponse(analysis);
          break;

        case "GET_STATE":
          const state = await getState();
          sendResponse(state);
          break;

        case "DELETE_ALL_DATA":
          await chrome.storage.local.clear();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      console.error("[ATS Matcher BG]", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep channel open for async response
});

// ─── Install Hook ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // Open onboarding page on first install
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

// ─── Core Functions ──────────────────────────────────────────────────────────

async function saveApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") throw new Error("Invalid API key");
  // Minimal validation: Gemini keys start with "AIza"
  if (!apiKey.startsWith("AIza")) throw new Error("This doesn't look like a valid Gemini API key (should start with 'AIza').");
  await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: apiKey.trim() });
}

async function getApiKey() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  return data[STORAGE_KEYS.API_KEY] || null;
}

async function getState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.RESUME_META,
    STORAGE_KEYS.RESUME_DATA,
    STORAGE_KEYS.GDPR_CONSENT,
    STORAGE_KEYS.SETUP_DONE,
  ]);
  return {
    hasApiKey:    !!data[STORAGE_KEYS.API_KEY],
    hasResume:    !!data[STORAGE_KEYS.RESUME_DATA],
    resumeMeta:   data[STORAGE_KEYS.RESUME_META] || null,
    gdprConsent:  !!data[STORAGE_KEYS.GDPR_CONSENT],
    setupDone:    !!data[STORAGE_KEYS.SETUP_DONE],
    keywordCount: data[STORAGE_KEYS.RESUME_DATA]
                    ? countKeywords(data[STORAGE_KEYS.RESUME_DATA])
                    : 0,
  };
}

function countKeywords(resumeData) {
  return (
    (resumeData.hardSkills?.length || 0) +
    (resumeData.softSkills?.length || 0) +
    (resumeData.tools?.length || 0) +
    (resumeData.jobTitles?.length || 0)
  );
}

// ─── Resume Parsing ──────────────────────────────────────────────────────────

async function parseResume({ fileData, mimeType, fileName, extractedText }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No API key configured.");

  let prompt = `You are a professional resume parser. Extract all relevant professional information from this resume and return ONLY a valid JSON object with no markdown, no explanation, no code fences — raw JSON only.

The JSON must have exactly these keys:
{
  "hardSkills": ["list of technical/hard skills"],
  "softSkills": ["list of soft/interpersonal skills"],
  "tools": ["list of software, tools, platforms, frameworks"],
  "jobTitles": ["list of job titles mentioned"],
  "industries": ["list of industries/domains"],
  "certifications": ["list of certifications"],
  "allKeywords": ["combined flat list of ALL unique relevant keywords for ATS matching"]
}

Be thorough — include acronyms AND their full forms (e.g., both "ML" and "Machine Learning").
Normalize casing to Title Case for skills.`;

  let content;

  if (extractedText) {
    // DOCX: text was extracted client-side, send as text prompt
    content = [{ text: `${prompt}\n\nRESUME TEXT:\n${extractedText.slice(0, 15000)}` }];
  } else if (fileData && mimeType === "application/pdf") {
    // PDF: send as inline_data so Gemini reads it natively
    content = [
      {
        inline_data: {
          mime_type: "application/pdf",
          data: fileData, // base64 string
        },
      },
      { text: prompt },
    ];
  } else {
    throw new Error("Unsupported file type. Please upload a PDF or DOCX file.");
  }

  const response = await callGemini(apiKey, content);
  const parsed = safeParseJSON(response);

  if (!parsed || !parsed.allKeywords) {
    throw new Error("Gemini returned an unexpected response. Please try again.");
  }

  // Store only extracted keywords (not raw resume text) — privacy by design
  await chrome.storage.local.set({
    [STORAGE_KEYS.RESUME_DATA]: parsed,
    [STORAGE_KEYS.RESUME_META]: {
      fileName: fileName || "resume",
      uploadedAt: new Date().toISOString(),
      keywordCount: parsed.allKeywords.length,
    },
    [STORAGE_KEYS.SETUP_DONE]: true,
  });

  return { ok: true, resumeData: parsed };
}

// ─── Job Analysis ────────────────────────────────────────────────────────────

async function analyzeJob(jobText) {
  if (!jobText || jobText.trim().length < 50) {
    throw new Error("Job description too short to analyze.");
  }

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("No API key configured.");

  const stored = await chrome.storage.local.get(STORAGE_KEYS.RESUME_DATA);
  const resumeData = stored[STORAGE_KEYS.RESUME_DATA];
  if (!resumeData) throw new Error("No resume uploaded yet.");

  // Step 1: Extract keywords from job description
  const jdPrompt = `You are an ATS (Applicant Tracking System) expert. Analyze this job description and extract keywords, returning ONLY raw JSON with no markdown or explanation.

Return exactly:
{
  "required": ["must-have skills/keywords from 'Required', 'Must have', 'Qualifications' sections"],
  "preferred": ["nice-to-have skills from 'Preferred', 'Nice to have', 'Bonus' sections"],
  "tools": ["specific software/tools/platforms/frameworks mentioned"],
  "jobTitle": "the main job title being hired for",
  "seniority": "Junior/Mid/Senior/Lead/Principal/Director/etc",
  "allKeywords": ["flat list of ALL unique keywords from the entire JD, both required and preferred"]
}

Include both acronyms and full forms where applicable. Normalize to Title Case.

JOB DESCRIPTION:
${jobText.slice(0, 8000)}`;

  const jdResponse = await callGemini(apiKey, [{ text: jdPrompt }]);
  const jdData = safeParseJSON(jdResponse);

  if (!jdData || !jdData.allKeywords) {
    throw new Error("Could not parse job description. Please try again.");
  }

  // Step 2: Compute match score
  const matchResult = computeMatchScore(resumeData, jdData);

  // Job description text is NOT stored — processed only in memory
  return {
    ok: true,
    score: matchResult.score,
    matched: matchResult.matched,
    missing: matchResult.missing,
    matchedRequired: matchResult.matchedRequired,
    missingRequired: matchResult.missingRequired,
    matchedPreferred: matchResult.matchedPreferred,
    missingPreferred: matchResult.missingPreferred,
    jobTitle: jdData.jobTitle || "",
    seniority: jdData.seniority || "",
    totalRequired: jdData.required?.length || 0,
    totalPreferred: jdData.preferred?.length || 0,
    suggestion: buildSuggestion(matchResult, jdData.jobTitle),
  };
}

// ─── Scoring Algorithm ───────────────────────────────────────────────────────

function computeMatchScore(resumeData, jdData) {
  const resumeKeywords = new Set(
    (resumeData.allKeywords || []).map(k => normalize(k))
  );

  const required  = jdData.required  || [];
  const preferred = jdData.preferred || [];
  const allJd     = jdData.allKeywords || [];

  // Check each JD keyword against resume
  const matchedRequired  = [];
  const missingRequired  = [];
  const matchedPreferred = [];
  const missingPreferred = [];
  const matchedOther     = [];
  const missingOther     = [];

  for (const kw of required) {
    const key = normalize(kw);
    if (resumeKeywords.has(key) || fuzzyMatch(key, resumeKeywords)) {
      matchedRequired.push(kw);
    } else {
      missingRequired.push(kw);
    }
  }

  for (const kw of preferred) {
    const key = normalize(kw);
    if (resumeKeywords.has(key) || fuzzyMatch(key, resumeKeywords)) {
      matchedPreferred.push(kw);
    } else {
      missingPreferred.push(kw);
    }
  }

  // Weighted scoring: required = 2x weight, preferred = 1x
  const requiredWeight  = 2;
  const preferredWeight = 1;

  const maxScore =
    required.length * requiredWeight + preferred.length * preferredWeight;

  const achieved =
    matchedRequired.length * requiredWeight +
    matchedPreferred.length * preferredWeight;

  const score = maxScore > 0 ? Math.round((achieved / maxScore) * 100) : 0;

  return {
    score: Math.min(score, 100),
    matched:          [...matchedRequired, ...matchedPreferred],
    missing:          [...missingRequired, ...missingPreferred],
    matchedRequired,
    missingRequired,
    matchedPreferred,
    missingPreferred,
  };
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9+#.]/g, " ").replace(/\s+/g, " ").trim();
}

function fuzzyMatch(keyword, keywordSet) {
  // Check if any resume keyword contains or is contained by the JD keyword
  for (const rk of keywordSet) {
    if (rk.includes(keyword) || keyword.includes(rk)) return true;
    // Handle acronym matching (e.g. "ml" === "machine learning" — too loose, skip)
  }
  return false;
}

function buildSuggestion(matchResult, jobTitle) {
  const { missingRequired, score } = matchResult;
  if (score >= 85) return "Excellent match! Your resume is well-aligned for this role. Apply with confidence.";
  if (score >= 70) {
    const top = missingRequired.slice(0, 2);
    return top.length > 0
      ? `Strong match! Adding "${top.join('" and "')}" to your resume could push you above 85%.`
      : "Strong match! Minor tweaks to mirror the job description's language could boost your score.";
  }
  if (score >= 50) {
    const top = missingRequired.slice(0, 3);
    return `Moderate match. Focus on adding: ${top.join(", ")}. Tailor your experience descriptions to include these keywords.`;
  }
  return `Low match. This ${jobTitle || "role"} requires skills that may need significant additions to your resume. Consider whether this aligns with your background.`;
}

// ─── Gemini API Client ───────────────────────────────────────────────────────

async function callGemini(apiKey, contentParts) {
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: contentParts }],
    generationConfig: {
      temperature:     0.1,  // Low temp for consistent structured output
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const errMsg  = errBody?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400) throw new Error(`Gemini API error: ${errMsg}`);
    if (res.status === 403) throw new Error("Invalid Gemini API key. Please check your key in Settings.");
    if (res.status === 429) throw new Error("Gemini rate limit hit. Please wait a moment and try again.");
    throw new Error(`Gemini API error: ${errMsg}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function safeParseJSON(text) {
  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return null;
  }
}
