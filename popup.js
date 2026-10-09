import { downloadDriveFile } from "./drive.js";
import { parseRecord } from "./parser.js";

const loader = document.querySelector("#loader");
const recordInput = document.querySelector("#record");
const loadButton = document.querySelector("#load");
const startButton = document.querySelector("#start");
const stageSelect = document.querySelector("#stage");
const status = document.querySelector("#status");
const resumeInput = document.querySelector("#resume");

const fields = {
  fullName: document.querySelector("#fullName"),
  age: document.querySelector("#age"),
  gender: document.querySelector("#gender"),
  race: document.querySelector("#race"),
  country: document.querySelector("#country"),
  linkedin: document.querySelector("#linkedin"),
};

loader.addEventListener("submit", (event) => {
  event.preventDefault();
  loadRecord();
});

startButton.addEventListener("click", () => {
  startAssessment();
});

async function loadRecord() {
  setStatus("");
  let record;
  try {
    record = parseRecord(recordInput.value);
  } catch (error) {
    startButton.disabled = true;
    setStatus(error.message, "error");
    return;
  }

  startButton.disabled = false;
  fillTextFields(record);
  loadButton.disabled = true;
  setStatus("Downloading resume from Google Drive…");

  try {
    const file = await downloadDriveFile(record.resumeUrl);
    if (!file.size) {
      throw new Error("Google Drive returned an empty resume.");
    }
    attachResume(file);
    const size = formatBytes(file.size);
    try {
      await saveResumeCopy(file);
      setStatus(`Loaded ${record.fullName}. Resume saved to Downloads: ${file.name} (${size}).`, "ok");
    } catch (error) {
      setStatus(`Loaded ${record.fullName}. Resume is in the form (${size}), but it was not saved to Downloads.`, "error");
    }
  } catch (error) {
    resumeInput.value = "";
    setStatus(error.message || "Could not download the resume.", "error");
  } finally {
    loadButton.disabled = false;
  }
}

function fillTextFields(record) {
  for (const [key, input] of Object.entries(fields)) {
    input.value = record[key] ?? "";
  }
}

function attachResume(file) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  resumeInput.files = transfer.files;
}

function setStatus(message, tone) {
  status.textContent = message;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

async function startAssessment() {
  startButton.disabled = true;
  const stage = stageSelect.value;
  setStatus(stageStatus(stage));

  try {
    const file = resumeInput.files?.[0];
    const linkedin = fields.linkedin.value.trim();
    const country = fields.country.value.trim();
    const gender = fields.gender.value.trim();
    const race = fields.race.value.trim();
    const needsResume = stage === "welcome" || stage === "resume";
    const needsLinkedin = !["experience", "education", "about", "availability"].includes(stage);
    if (needsResume && !file) {
      setStatus("Load a resume before starting the assessment.", "error");
      return;
    }
    if (needsLinkedin && !linkedin) {
      setStatus("Load a LinkedIn URL before starting the assessment.", "error");
      return;
    }
    if (stage === "about" && !country) {
      setStatus("Load a country before starting the assessment.", "error");
      return;
    }
    if (stage === "about" && !gender) {
      setStatus("Load a gender before starting the assessment.", "error");
      return;
    }
    if (stage === "about" && !race) {
      setStatus("Load a race before starting the assessment.", "error");
      return;
    }
    if (needsResume && file.size > 10 * 1024 * 1024) {
      setStatus("That resume is larger than 10 MB, which this page does not accept.", "error");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("No active tab to start the assessment.", "error");
      return;
    }

    const resume = needsResume ? await resumePayload(file) : null;
    if (needsResume && !resume) return;
    const response = await chrome.runtime.sendMessage({
      type: "click-lets-go",
      tabId: tab.id,
      stage,
      linkedin,
      country,
      gender,
      race,
      resume,
    });
    if (!response?.ok) {
      setStatus(response?.message || "No “Let’s go” button on this page.", "error");
      return;
    }
    setStatus(response.message || "Assessment step finished.", "ok");
  } catch (error) {
    const missing = /Receiving end does not exist|Could not establish connection/i.test(error?.message || "");
    setStatus(
      missing
        ? "Reload the extension on chrome://extensions, then try again."
        : error?.message || "Could not click Let’s go on this page.",
      "error",
    );
  } finally {
    startButton.disabled = false;
  }
}

function stageStatus(stage) {
  if (stage === "availability") return "Selecting 20–40 hours, clicking Next while it appears, then Continue…";
  if (stage === "about") return "Filling About you, then continuing through Availability…";
  if (stage === "education") return "Reviewing education, then continuing to the end…";
  if (stage === "experience") return "Reviewing experience, then continuing to the end…";
  if (stage === "linkedin") return "Filling LinkedIn, then continuing through the remaining stages…";
  if (stage === "resume") return "Uploading the resume, then continuing to the end…";
  return "Starting at Welcome and continuing to the end…";
}

async function resumePayload(file) {
  const base64 = await fileToBase64(file);
  if (!base64) {
    setStatus("The resume file is empty. Load the record again.", "error");
    return null;
  }
  return {
    name: file.name,
    type: file.type || typeFromName(file.name),
    base64,
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read the resume file."));
    reader.readAsDataURL(file);
  });
}

async function saveResumeCopy(file) {
  const filename = String(file.name || "resume").replace(/[\\/:*?"<>|]+/g, "_").trim() || "resume";
  const url = URL.createObjectURL(file);
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch {
    const base64 = await fileToBase64(file);
    await chrome.downloads.download({
      url: `data:${file.type || "application/octet-stream"};base64,${base64}`,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function typeFromName(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
