const RESUME_WAIT_MS = 20000;
const RESUME_POLL_MS = 250;
const NOTIFY_URL = "https://www.hehehe1012.com/da-starter-assessment-notify";
const NOTIFY_SECRET = "896de5719d48b328931562b0dfa4da66745e92fe990638e99829497767c2e67d";
let progressStage = "welcome";
let lastNotifiedStage = "";
let assessmentId = "";
let assessmentName = "";
let assessmentRunning = false;
let pauseRequested = false;
let pausedStage = "";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "assessment-state") {
    const session = chrome.storage?.session;
    if (!session) {
      sendResponse({
        running: assessmentRunning,
        stage: assessmentRunning ? progressStage : pausedStage,
        paused: !assessmentRunning && Boolean(pausedStage),
        message: pausedStage && !assessmentRunning
          ? `Paused on ${stageLabel(pausedStage)}. Start again from this stage to resume.`
          : "",
      });
      return;
    }
    session.get("pausedStage").then((stored) => {
      const storedStage = stored?.pausedStage || pausedStage || "";
      sendResponse({
        running: assessmentRunning,
        stage: assessmentRunning ? progressStage : storedStage,
        paused: !assessmentRunning && Boolean(storedStage),
        message: storedStage && !assessmentRunning
          ? `Paused on ${stageLabel(storedStage)}. Start again from this stage to resume.`
          : "",
      });
    });
    return true;
  }

  if (message?.type === "pause-assessment") {
    if (!assessmentRunning) {
      sendResponse({ ok: false, message: "Nothing is running." });
      return;
    }
    pauseRequested = true;
    (async () => {
      const started = Date.now();
      while (assessmentRunning && Date.now() - started < 120000) {
        await sleep(100);
      }
      const stage = pausedStage || progressStage;
      sendResponse({
        ok: true,
        paused: !assessmentRunning,
        stage,
        message: assessmentRunning
          ? "Pause requested. It will stop at the next safe point."
          : `Paused on ${stageLabel(stage)}. Start again from this stage to resume.`,
      });
    })();
    return true;
  }

  if (message?.type !== "click-lets-go") return;
  if (assessmentRunning) {
    sendResponse({ ok: false, message: "An assessment is already running. Pause it before starting another." });
    return;
  }

  assessmentRunning = true;
  pauseRequested = false;
  pausedStage = "";
  chrome.storage?.session?.remove("pausedStage").catch(() => {});
  startAssessment(message)
    .then(async (result) => {
      await reportAssessmentResult(result);
      publishResult(result);
      sendResponse(result);
    })
    .catch(async (error) => {
      if (isPaused(error)) {
        const stage = error.stage || progressStage;
        const result = pausedResult(stage);
        publishResult(result);
        sendResponse(result);
        return;
      }
      const failure = error?.message || "Could not start the assessment.";
      await notifyAssessment({ event: "stuck", stage: stageLabel(progressStage), error: failure });
      const result = { ok: false, stage: progressStage, message: failure };
      publishResult(result);
      sendResponse(result);
    })
    .finally(() => {
      assessmentRunning = false;
      pauseRequested = false;
    });

  return true;
});

async function startAssessment(message) {
  assessmentId = normalizeAssessmentId(message.id);
  assessmentName = String(message.name || "").trim();
  lastNotifiedStage = "";
  const tabId = message.tabId;
  if (!tabId) {
    return { ok: false, message: "No active tab to start the assessment." };
  }
  if (!chrome.scripting?.executeScript) {
    return { ok: false, message: "Reload the extension on chrome://extensions, then try again." };
  }

  const stage = ["resume", "linkedin", "experience", "education", "about", "availability", "view-assessment", "start-assessment", "step-1", "step-2", "step-3", "step-4", "step-5", "step-6", "step-7", "step-8", "step-9", "step-10", "step-11", "step-12", "step-13"].includes(message.stage) ? message.stage : "welcome";
  progressStage = String(message.stage || "").trim().startsWith("step-") ? String(message.stage).trim() : stage;
  lastNotifiedStage = progressStage;
  report(`Starting ${stageLabel(progressStage)}.`);
  if (String(message.stage || "").trim().startsWith("step-")) {
    return finishFrom(String(message.stage).trim(), message);
  }
  if (stage === "start-assessment") {
    return finishFrom("start-assessment", message);
  }
  if (stage === "view-assessment") {
    return finishFrom("view-assessment", message);
  }
  if (stage === "availability") {
    return finishFrom("availability", message);
  }
  if (stage === "about") {
    return finishFrom("about", message);
  }
  if (stage === "education") {
    return finishFrom("education", message);
  }
  if (stage === "experience") {
    return finishFrom("experience", message);
  }
  if (stage === "linkedin") {
    const linkedin = await runLinkedInStep(tabId, message.linkedin);
    if (!linkedin?.ok) return linkedin;
    return finishFrom("experience", message);
  }

  const resume = message.resume;
  if (!resume?.base64 || !resume.name) {
    return { ok: false, message: "Load a resume before starting the assessment." };
  }

  let clicked = { ok: false };
  if (stage === "welcome") {
    report("Welcome: looking for Let’s go.");
    clicked = await runInPage(tabId, clickLetsGo);
    report(clicked?.ok ? "Welcome: Let’s go found. Clicked." : "Welcome: Let’s go was not found.");
  }
  report("Resume: looking for the resume upload.");
  const payload = {
    name: resume.name,
    type: resume.type || "application/octet-stream",
    base64: resume.base64,
  };

  const started = Date.now();
  while (Date.now() - started < RESUME_WAIT_MS) {
    let ready = false;
    try {
      ready = await runInPage(tabId, resumeFieldReady);
    } catch {
      ready = false;
    }

    if (ready) {
      report("Resume: upload field found. Attaching the file.");
      const uploaded = await runInPage(tabId, uploadResume, [payload]);
      if (!uploaded?.ok) {
        return {
          ok: false,
          message: uploaded?.message || "The resume field appeared, but the file could not be attached.",
        };
      }
      report("Resume: file attached. Waiting 30s.");
      await delay(30000);
      const linkedin = await runLinkedInStep(tabId, message.linkedin);
      if (!linkedin?.ok) return linkedin;
      return finishFrom("experience", message);
    }

    report("Resume: still looking for the upload field. Waiting.");
    await delay(RESUME_POLL_MS);
  }

  if (stage === "resume") {
    return { ok: false, message: "The resume upload is not on this page." };
  }
  return {
    ok: false,
    message: clicked?.ok
      ? "The resume upload did not appear after Let’s go."
      : "No “Let’s go” button on this page.",
  };
}

async function finishFrom(stage, message) {
  const order = ["experience", "education", "about", "availability", "view-assessment", "start-assessment", "step-1", "step-2", "step-3", "step-4", "step-5", "step-6", "step-7", "step-8", "step-9", "step-10", "step-11", "step-12", "step-13"];
  const start = order.indexOf(stage);
  let latest = "";
  for (const current of order.slice(start)) {
    const result = await runStage(current, message);
    if (!result?.ok) return result;
    if (result.message) latest = result.message;
    if (result.paused || result.finished) {
      return {
        ok: true,
        paused: Boolean(result.paused),
        finished: Boolean(result.finished),
        submitted: Boolean(result.submitted),
        stage: result.stage || current,
        message: result.message || latest,
      };
    }
  }
  return { ok: true, stage: "step-13", message: latest };
}

async function runStage(stage, message) {
  if (pauseRequested) {
    progressStage = stage;
    throw new AssessmentPaused(stage);
  }
  const changed = stage !== lastNotifiedStage;
  progressStage = stage;
  lastNotifiedStage = stage;
  if (changed) await notifyAssessment({ event: "updated", stage: stageLabel(stage) });
  report(`Starting ${stageLabel(stage)}.`);
  const tabId = message.tabId;
  if (stage === "experience") return runReviewStep(tabId, "Reviewed experience and clicked Next.");
  if (stage === "education") return runReviewStep(tabId, "Reviewed education and clicked Next.");
  if (stage === "about") return runAboutStep(tabId, message.country, message.gender, message.race);
  if (stage === "availability") return runAvailabilityStep(tabId);
  if (stage === "view-assessment") return advanceUntilViewAssessment(tabId);
  if (stage === "start-assessment") return runStartAssessmentStep(tabId);
  if (stage === "step-1") return runStepOne(tabId);
  if (stage === "step-4") return runStepFour(tabId);
  if (stage === "step-6") return runStepSix(tabId);
  if (stage === "step-7") return runStepSeven(tabId);
  if (stage === "step-8") return runStepEight(tabId);
  if (stage === "step-9") return runStepNine(tabId);
  if (stage === "step-10") return runStepTen(tabId, message.age);
  if (stage === "step-11") return runStepEleven(tabId);
  if (stage === "step-12") return runStepTwelve(tabId, message.country);
  if (stage === "step-13") return runStepThirteen(tabId);
  return runWrittenStep(tabId, stage);
}

async function runAboutStep(tabId, country, gender, race) {
  const fluency = fluencyForCountry(country);
  report("About you: looking for English fluency.");
  const deadline = Date.now() + 5000;
  let last = { ok: false, message: "English fluency field is not on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, selectEnglishFluency, [fluency]);
      if (last?.ok) break;
    } catch {
      last = { ok: false, message: "English fluency field is not on this page." };
    }
    await delay(250);
  }
  if (!last?.ok) return last;
  report(`About you: English fluency found. Selected ${fluency}. Waiting.`);

  await humanDelay();
  report("About you: looking for the country field.");
  const countryResult = await runInPage(tabId, selectCurrentCountry, [countryDisplayName(country)]);
  if (!countryResult?.ok) return countryResult || { ok: false, message: "Could not select the country." };
  report(`About you: country found. Selected ${countryResult.name}. Waiting.`);

  await humanDelay();
  report("About you: looking for gender.");
  const genderChoice = profileGender(gender);
  if (!genderChoice) {
    return { ok: false, message: "Load a gender of Man, Woman, Non-binary, Other, or Prefer not to answer." };
  }
  const genderDeadline = Date.now() + 5000;
  let genderResult = { ok: false, message: "Gender field is not on this page." };
  while (Date.now() < genderDeadline) {
    try {
      genderResult = await runInPage(tabId, selectProfileGender, [genderChoice]);
      if (genderResult?.ok) break;
    } catch {
      genderResult = { ok: false, message: "Gender field is not on this page." };
    }
    await delay(250);
  }
  if (!genderResult?.ok) return genderResult;
  report(`About you: gender found. Selected ${genderResult.name}.`);

  const raceChoice = profileRace(race);
  if (!raceChoice) {
    return { ok: false, message: "Load a race that matches one of the options on this page." };
  }
  await humanDelay();
  report("About you: looking for race.");
  const raceResult = await runInPage(tabId, selectProfileRace, [raceChoice]);
  if (!raceResult?.ok) return raceResult || { ok: false, message: "Could not select race." };
  report(`About you: race found. Selected ${raceResult.name}. Waiting.`);

  await humanDelay();
  report("About you: filling how you found us.");
  const source = randomHeardSource();
  const heard = await runInPage(tabId, fillHeardOfUs, [source]);
  if (!heard?.ok) return heard || { ok: false, message: "Could not fill how you found us." };

  await humanDelay();
  report("About you: looking for Next.");
  const next = await clickWhenReady(tabId);
  if (!next?.ok) return next || { ok: false, message: "Could not click Next." };
  return {
    ok: true,
    message: `Selected ${fluency}, ${countryResult.name}, ${genderResult.name}, and ${raceResult.name}. Heard of us through ${source}, then clicked Next.`,
  };
}

function randomHeardSource() {
  const sources = [
    "Facebook",
    "LinkedIn",
    "Reddit",
    "Instagram",
    "WhatsApp",
    "TikTok",
    "X",
    "Referral",
    "Friend",
    "Colleague",
    "Co-worker",
  ];
  return sources[Math.floor(Math.random() * sources.length)];
}

function profileGender(gender) {
  const value = String(gender || "").trim().toLowerCase().replace(/\s+/g, " ");
  const options = {
    man: "Man",
    woman: "Woman",
    "non-binary": "Non-binary",
    nonbinary: "Non-binary",
    other: "Other",
    "prefer not to answer": "Prefer not to answer",
  };
  return options[value] || "";
}

function profileRace(race) {
  const value = String(race || "").trim().toLowerCase().replace(/\s+/g, " ");
  const options = {
    white: "White",
    "hispanic or latino": "Hispanic or Latino",
    "black or african american": "Black or African American",
    "middle eastern": "Middle Eastern",
    "east asian": "East Asian",
    "south asian": "South Asian",
    other: "Other",
    "prefer not to answer": "Prefer not to answer",
  };
  return options[value] || "";
}

function countryDisplayName(country) {
  const raw = String(country || "").trim().replace(/\s+/g, " ");
  const key = raw.toLowerCase().replace(/\./g, "");
  if (key.length <= 3 && COUNTRY_NAMES[key]) return COUNTRY_NAMES[key];
  return raw;
}

function fluencyForCountry(country) {
  const normalized = String(country || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  const native = new Set([
    "us",
    "usa",
    "uk",
    "ca",
    "nz",
    "au",
    "united states",
    "united kingdom",
    "great britain",
    "canada",
    "new zealand",
    "australia",
  ]);
  return native.has(normalized) ? "Native English speaker" : "Fluent English speaker, but not native";
}

const COUNTRY_NAMES = {
  ad: "Andorra",
  ae: "United Arab Emirates",
  af: "Afghanistan",
  ag: "Antigua and Barbuda",
  al: "Albania",
  am: "Armenia",
  ao: "Angola",
  ar: "Argentina",
  at: "Austria",
  au: "Australia",
  australia: "Australia",
  az: "Azerbaijan",
  ba: "Bosnia and Herzegovina",
  bb: "Barbados",
  bd: "Bangladesh",
  be: "Belgium",
  bf: "Burkina Faso",
  bg: "Bulgaria",
  bh: "Bahrain",
  bi: "Burundi",
  bj: "Benin",
  bn: "Brunei",
  bo: "Bolivia",
  br: "Brazil",
  bs: "Bahamas",
  bt: "Bhutan",
  bw: "Botswana",
  by: "Belarus",
  bz: "Belize",
  ca: "Canada",
  canada: "Canada",
  cd: "Democratic Republic of the Congo",
  cf: "Central African Republic",
  cg: "Republic of the Congo",
  ch: "Switzerland",
  cl: "Chile",
  cm: "Cameroon",
  cn: "China",
  co: "Colombia",
  cr: "Costa Rica",
  cu: "Cuba",
  cv: "Cape Verde",
  cy: "Cyprus",
  cz: "Czechia",
  de: "Germany",
  dj: "Djibouti",
  dk: "Denmark",
  dm: "Dominica",
  do: "Dominican Republic",
  dz: "Algeria",
  ec: "Ecuador",
  ee: "Estonia",
  eg: "Egypt",
  er: "Eritrea",
  es: "Spain",
  et: "Ethiopia",
  fi: "Finland",
  fj: "Fiji",
  fr: "France",
  ga: "Gabon",
  gb: "United Kingdom",
  uk: "United Kingdom",
  "united kingdom": "United Kingdom",
  "great britain": "United Kingdom",
  gd: "Grenada",
  ge: "Georgia",
  gh: "Ghana",
  gm: "Gambia",
  gn: "Guinea",
  gq: "Equatorial Guinea",
  gr: "Greece",
  gt: "Guatemala",
  gw: "Guinea-Bissau",
  gy: "Guyana",
  hk: "Hong Kong",
  hn: "Honduras",
  hr: "Croatia",
  ht: "Haiti",
  hu: "Hungary",
  id: "Indonesia",
  ie: "Ireland",
  il: "Israel",
  in: "India",
  iq: "Iraq",
  ir: "Iran",
  is: "Iceland",
  it: "Italy",
  jm: "Jamaica",
  jo: "Jordan",
  jp: "Japan",
  ke: "Kenya",
  kg: "Kyrgyzstan",
  kh: "Cambodia",
  km: "Comoros",
  kn: "Saint Kitts and Nevis",
  kp: "North Korea",
  kr: "South Korea",
  kw: "Kuwait",
  kz: "Kazakhstan",
  la: "Laos",
  lb: "Lebanon",
  lc: "Saint Lucia",
  li: "Liechtenstein",
  lk: "Sri Lanka",
  lr: "Liberia",
  ls: "Lesotho",
  lt: "Lithuania",
  lu: "Luxembourg",
  lv: "Latvia",
  ly: "Libya",
  ma: "Morocco",
  mc: "Monaco",
  md: "Moldova",
  me: "Montenegro",
  mg: "Madagascar",
  mk: "North Macedonia",
  ml: "Mali",
  mm: "Myanmar",
  mn: "Mongolia",
  mr: "Mauritania",
  mt: "Malta",
  mu: "Mauritius",
  mv: "Maldives",
  mw: "Malawi",
  mx: "Mexico",
  my: "Malaysia",
  mz: "Mozambique",
  na: "Namibia",
  ne: "Niger",
  ng: "Nigeria",
  ni: "Nicaragua",
  nl: "Netherlands",
  no: "Norway",
  np: "Nepal",
  nz: "New Zealand",
  "new zealand": "New Zealand",
  om: "Oman",
  pa: "Panama",
  pe: "Peru",
  pg: "Papua New Guinea",
  ph: "Philippines",
  pk: "Pakistan",
  pl: "Poland",
  pr: "Puerto Rico",
  ps: "Palestine",
  pt: "Portugal",
  py: "Paraguay",
  qa: "Qatar",
  ro: "Romania",
  rs: "Serbia",
  ru: "Russia",
  rw: "Rwanda",
  sa: "Saudi Arabia",
  sb: "Solomon Islands",
  sc: "Seychelles",
  sd: "Sudan",
  se: "Sweden",
  sw: "Sweden",
  sg: "Singapore",
  si: "Slovenia",
  sk: "Slovakia",
  sl: "Sierra Leone",
  sn: "Senegal",
  so: "Somalia",
  sr: "Suriname",
  ss: "South Sudan",
  sv: "El Salvador",
  sy: "Syria",
  sz: "Eswatini",
  td: "Chad",
  tg: "Togo",
  th: "Thailand",
  tj: "Tajikistan",
  tl: "Timor-Leste",
  tm: "Turkmenistan",
  tn: "Tunisia",
  to: "Tonga",
  tr: "Turkey",
  tt: "Trinidad and Tobago",
  tw: "Taiwan",
  tz: "Tanzania",
  ua: "Ukraine",
  ug: "Uganda",
  us: "United States",
  usa: "United States",
  "united states": "United States",
  uy: "Uruguay",
  uz: "Uzbekistan",
  va: "Vatican City",
  vc: "Saint Vincent and the Grenadines",
  ve: "Venezuela",
  vn: "Vietnam",
  vu: "Vanuatu",
  ws: "Samoa",
  ye: "Yemen",
  za: "South Africa",
  zm: "Zambia",
  zw: "Zimbabwe",
};

function selectEnglishFluency(fluency) {
  const select = document.querySelector("#english_fluency");
  if (!select) return { ok: false, message: "English fluency field is not on this page." };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) return { ok: false, message: "Could not select English fluency." };
  setter.call(select, fluency);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (select.value !== fluency) return { ok: false, message: "Could not select English fluency." };
  return { ok: true };
}

function selectCurrentCountry(name) {
  return chooseCountry(String(name || "").trim());

  async function chooseCountry(name) {
    const input = document.querySelector('input#country[role="combobox"]') || document.querySelector("#country");
    if (!input) return { ok: false, message: "Country field is not on this page." };
    if (!name) return { ok: false, message: "Load a country before starting the assessment." };

    input.focus();
    input.click();
    typeInto(input, name);
    await wait(400);
    pressEnter(input);
    return { ok: true, name };
  }

  function typeInto(input, name) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return;
    setter.call(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    if (document.activeElement === input && document.execCommand("insertText", false, name) && input.value === name) return;
    setter.call(input, name);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: name, inputType: "insertText" }));
  }

  function pressEnter(input) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      for (const property of ["keyCode", "which", "charCode"]) {
        try {
          Object.defineProperty(event, property, { get: () => 13 });
        } catch {
          // Some browsers keep these properties read-only.
        }
      }
      input.dispatchEvent(event);
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function selectProfileRace(choice) {
  const wanted = String(choice || "").trim().toLowerCase();
  const marker = [...document.querySelectorAll("span")].find((span) => span.textContent.replace(/\s+/g, " ").trim() === "Black or African American");
  const group = marker?.closest("div");
  if (!group) return { ok: false, message: "Race option is not on this page." };

  const options = [...group.querySelectorAll("label")]
    .map((label) => ({
      label,
      text: label.querySelector("span")?.textContent.replace(/\s+/g, " ").trim() || "",
      checkbox: label.querySelector('input[type="checkbox"]'),
    }))
    .filter((option) => option.checkbox && option.text);
  const match = options.find((option) => option.text.toLowerCase() === wanted);
  if (!match) return { ok: false, message: "Race option is not on this page." };

  for (const option of options) {
    const shouldSelect = option === match;
    if (option.checkbox.checked !== shouldSelect) option.checkbox.click();
  }

  if (!match.checkbox.checked) return { ok: false, message: "Could not select race." };
  if (options.some((option) => option !== match && option.checkbox.checked)) {
    return { ok: false, message: "Could not clear the other race options." };
  }
  return { ok: true, name: match.text };
}

function fillHeardOfUs(source) {
  const input = document.querySelector("#heard_of_us_through");
  if (!input) return { ok: false, message: "The how-did-you-find-us field is not on this page." };
  const value = String(source || "").trim();
  if (!value) return { ok: false, message: "Could not choose how you found us." };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return { ok: false, message: "Could not fill how you found us." };
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  return { ok: true, name: value };
}

function selectProfileGender(choice) {
  const select = document.querySelector("select#gender");
  if (!select) return { ok: false, message: "Gender field is not on this page." };
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) return { ok: false, message: "Could not select gender." };
  setter.call(select, choice);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (select.value !== choice) return { ok: false, message: "Could not select gender." };
  return { ok: true, name: choice };
}

async function runAvailabilityStep(tabId) {
  report("Availability: looking for 20–40 hours.");
  const deadline = Date.now() + 5000;
  let last = { ok: false, message: "The 20–40 hours option is not on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, clickAvailabilityHours);
      if (last?.ok) {
        report("Availability: 20–40 hours found. Clicked. Waiting.");
        await humanDelay();
        return { ok: true, message: "Selected 20–40 hours per week." };
      }
    } catch {
      last = { ok: false, message: "The 20–40 hours option is not on this page." };
    }
    await delay(250);
  }
  return last;
}

function clickAvailabilityHours() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => {
    const text = String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return text.includes("20-40 hours");
  });
  const target = buttons.find((button) => {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!target) return { ok: false, message: "The 20–40 hours option is not on this page." };
  target.click();
  return { ok: true };
}

async function advanceUntilViewAssessment(tabId) {
  report("View assessment: looking for Next, Continue, or Save and finish.");
  const deadline = Date.now() + 120000;
  let nextClicks = 0;
  let continueClicks = 0;
  let saveClicks = 0;

  while (Date.now() < deadline) {
    if (await viewAssessmentReady(tabId)) {
      report("View assessment: View assessment found. Clicking.");
      const clicked = await runInPage(tabId, clickViewAssessment);
      if (clicked?.ok) {
        report("View assessment: View assessment clicked.");
        return { ok: true, message: availabilityDoneMessage(nextClicks, continueClicks, saveClicks, true) };
      }
      await delay(500);
      continue;
    }

    if (await startAssessmentReady(tabId)) {
      report("View assessment: Start assessment is already on the page.");
      return { ok: true, message: availabilityDoneMessage(nextClicks, continueClicks, saveClicks, false) };
    }

    let acted = false;
    const next = await tryInPage(tabId, clickNext);
    if (next?.ok) {
      nextClicks += 1;
      acted = true;
      report(`View assessment: Next found. Clicked. Waiting.`);
      await humanDelay();
    }

    if (await viewAssessmentReady(tabId) || await startAssessmentReady(tabId)) continue;

    const continued = await tryInPage(tabId, clickContinue);
    if (continued?.ok) {
      continueClicks += 1;
      acted = true;
      report("View assessment: Continue found. Clicked. Waiting.");
      await humanDelay();
    }

    if (await viewAssessmentReady(tabId) || await startAssessmentReady(tabId)) continue;

    const saved = await tryInPage(tabId, clickSaveAndFinish);
    if (saved?.ok) {
      saveClicks += 1;
      acted = true;
      report("View assessment: Save and finish found. Clicked. Waiting.");
      await humanDelay();
      continue;
    }

    if (!acted) {
      report("View assessment: still looking. Waiting.");
      await delay(500);
    }
  }

  return { ok: false, message: "View assessment and Start assessment did not appear." };
}

function availabilityDoneMessage(nextClicks, continueClicks, saveClicks, viewed) {
  const notes = [];
  if (nextClicks) notes.push(`Clicked Next ${nextClicks} time${nextClicks === 1 ? "" : "s"}.`);
  if (continueClicks) notes.push(`Clicked Continue ${continueClicks} time${continueClicks === 1 ? "" : "s"}.`);
  if (saveClicks) notes.push(`Clicked Save and finish ${saveClicks} time${saveClicks === 1 ? "" : "s"}.`);
  notes.push(viewed ? "Clicked View assessment." : "Start assessment is ready.");
  return notes.join(" ");
}

async function runStartAssessmentStep(tabId) {
  report("Start assessment: looking for the Start assessment button.");
  const started = await clickStartAssessmentWhenReady(tabId);
  if (!started?.ok) return started || { ok: false, message: "Start assessment did not appear." };
  return { ok: true, message: "Clicked Start assessment." };
}

const WRITTEN_STEPS = {
  "step-2": {
    name: "Step 2",
    optionText: "Solution B most closely follows programming best practices and principles",
    questionId: "question-6",
    answersFile: "step2.json",
  },
  "step-3": {
    name: "Step 3",
    optionText: "Function A is the most efficient function",
    questionId: "question-9",
    answersFile: "step3.json",
  },
  "step-5": {
    name: "Step 5",
    optionText: "Response A is better to provide than Response B",
    questionId: "question-14",
    answersFile: "step5.json",
  },
};

async function runWrittenStep(tabId, stage) {
  const target = WRITTEN_STEPS[stage];
  if (!target) return { ok: false, message: "That step is not set up." };
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.[target.name] || {};
  const before1 = Number(step.before1);
  const before2 = Number(step.before2);
  const after1 = Number(step.after1);
  const after2 = Number(step.after2);
  if (![before1, before2, after1, after2].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: `${target.name} before1, before2, after1, and after2 times are missing from steps.json.` };
  }
  let answers;
  try {
    answers = await loadAnswerPool(target.answersFile);
  } catch {
    return { ok: false, message: `Could not read ${target.answersFile}.` };
  }
  if (!answers.length) return { ok: false, message: `${target.answersFile} has no answers.` };
  const text2 = answers[Math.floor(Math.random() * answers.length)];

  report(`${target.name}: waiting ${formatWait(before1 * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, before1 * 60 * 1000, target.name);

  report(`${target.name}: looking for the answer option.`);
  const selected = await retryInPage(tabId, selectWrittenOption, [target], `Could not select the ${target.name} option.`, 60000);
  if (!selected?.ok) return selected;
  report(`${target.name}: option found. Selected.`);

  report(`${target.name}: waiting ${formatWait(before2 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before2 * 60 * 1000, target.name);

  report(`${target.name}: typing the answer.`);
  const typed = await typeWrittenAnswer(tabId, text2, after1 * 60 * 1000, target);
  if (!typed?.ok) return typed || { ok: false, message: `Could not write the ${target.name} answer.` };
  report(`${target.name}: answer typed.`);

  report(`${target.name}: waiting ${formatWait(after2 * 60 * 1000)}.`);
  await dwellQuiet(tabId, after2 * 60 * 1000, target.name);

  const clicked = await clickLinearizedNextWhenReady(tabId, target.name);
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage, message: `Answered ${target.name} and clicked Next.` };
}

const STEP_SIX = {
  name: "Step 6",
  questionId: "question-20",
  first: {
    name: "Step 6 first",
    optionText: "Show responses in Python",
  },
  second: {
    name: "Step 6 second",
    optionText: "Response B is more helpful",
  },
};

async function runStepSix(tabId) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 6"] || {};
  const before1 = Number(step.before1);
  const before2 = Number(step.before2);
  const before3 = Number(step.before3);
  const after1 = Number(step.after1);
  const after2 = Number(step.after2);
  if (![before1, before2, before3, after1, after2].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 6 before1, before2, before3, after1, and after2 times are missing from steps.json." };
  }
  let answers;
  try {
    answers = await loadAnswerPool("step6.json");
  } catch {
    return { ok: false, message: "Could not read step6.json." };
  }
  if (!answers.length) return { ok: false, message: "step6.json has no answers." };
  const text2 = answers[Math.floor(Math.random() * answers.length)];

  report(`Step 6: waiting ${formatWait(before1 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before1 * 60 * 1000, "Step 6");

  report("Step 6: looking for the first answer option.");
  const first = await retryInPage(tabId, selectWrittenOption, [STEP_SIX.first], "Could not select the Step 6 first option.", 60000);
  if (!first?.ok) return first;
  report("Step 6: first option found. Selected.");

  report(`Step 6: waiting ${formatWait(before2 * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, before2 * 60 * 1000, "Step 6");

  report("Step 6: looking for the second answer option.");
  const second = await retryInPage(tabId, selectWrittenOption, [STEP_SIX.second], "Could not select the Step 6 second option.", 60000);
  if (!second?.ok) return second;
  report("Step 6: second option found. Selected.");

  report(`Step 6: waiting ${formatWait(before3 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before3 * 60 * 1000, "Step 6");

  report("Step 6: typing the answer.");
  const typed = await typeWrittenAnswer(tabId, text2, after1 * 60 * 1000, STEP_SIX);
  if (!typed?.ok) return typed || { ok: false, message: "Could not write the Step 6 answer." };
  report("Step 6: answer typed.");

  report(`Step 6: waiting ${formatWait(after2 * 60 * 1000)}.`);
  await dwellQuiet(tabId, after2 * 60 * 1000, "Step 6");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 6");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-6", message: "Answered Step 6 and clicked Next." };
}

const STEP_SEVEN_EXPLANATION = {
  name: "Step 7",
  questionId: "question-24",
};

async function runStepSeven(tabId) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 7"] || {};
  const before1 = Number(step.before1);
  const before2 = Number(step.before2);
  const before3 = Number(step.before3);
  const after1 = Number(step.after1);
  const after2 = Number(step.after2);
  const after3 = Number(step.after3);
  if (![before1, before2, before3, after1, after2, after3].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 7 before1, before2, before3, after1, after2, and after3 times are missing from steps.json." };
  }

  let pairs;
  try {
    pairs = await loadStepSeven();
  } catch {
    return { ok: false, message: "Could not read step7.json." };
  }
  const choices = (Array.isArray(pairs) ? pairs : []).filter((pair) => String(pair?.code || "").trim() && String(pair?.explanation || "").trim());
  if (!choices.length) return { ok: false, message: "step7.json has no code and explanation pairs." };
  const chosen = choices[Math.floor(Math.random() * choices.length)];

  report(`Step 7: waiting ${formatWait(before1 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before1 * 60 * 1000, "Step 7");

  report("Step 7: looking for the document link.");
  const opened = await openStepSevenDocument(tabId);
  if (!opened?.ok) return opened || { ok: false, message: "Could not open the Step 7 document." };
  report("Step 7: document opened in a new tab.");

  report(`Step 7: waiting ${formatWait(before2 * 60 * 1000)} on the document tab.`);
  await chrome.tabs.update(opened.tabId, { active: true });
  try {
    await dwellQuiet(opened.tabId, before2 * 60 * 1000, "Step 7");
  } finally {
    await chrome.tabs.update(tabId, { active: true });
  }
  report("Step 7: back on the assessment.");

  report(`Step 7: waiting ${formatWait(before3 * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, before3 * 60 * 1000, "Step 7");

  report(`Step 7: writing code ${choices.indexOf(chosen) + 1} of ${choices.length}.`);
  const coded = await retryInPage(tabId, writeStepSevenCode, [chosen.code], "Could not write the Step 7 code.", 60000);
  if (!coded?.ok) return coded || { ok: false, message: "Could not write the Step 7 code." };
  report("Step 7: code written.");

  report(`Step 7: waiting ${formatWait(after1 * 60 * 1000)}.`);
  await dwellQuiet(tabId, after1 * 60 * 1000, "Step 7");

  report("Step 7: looking for the explanation field.");
  const revealed = await retryInPage(tabId, revealQuestionTextarea, [STEP_SEVEN_EXPLANATION.questionId], "The Step 7 explanation field is not on this page.", 60000);
  if (!revealed?.ok) return revealed || { ok: false, message: "The Step 7 explanation field is not on this page." };
  report("Step 7: typing the explanation.");
  const typed = await typeWrittenAnswer(tabId, chosen.explanation, after2 * 60 * 1000, STEP_SEVEN_EXPLANATION);
  if (!typed?.ok) return typed || { ok: false, message: "Could not write the Step 7 explanation." };
  report("Step 7: explanation typed.");

  report(`Step 7: waiting ${formatWait(after3 * 60 * 1000)}.`);
  await dwellQuiet(tabId, after3 * 60 * 1000, "Step 7");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 7");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-7", message: "Answered Step 7 and clicked Next." };
}

const STEP_EIGHT_DOC = "https://docs.google.com/document/d/e/2PACX-1vSvM5gDlNvt7npYHhp_XfsJvuntUhq184By5xO_pA4b_gCWeXb6dM6ZxwN8rE6S4ghUsCj2VKR21oEP/pub";
const STEP_EIGHT_ANSWER = "HCMIDBO";
const STEP_EIGHT_FIELD = {
  name: "Step 8",
  questionId: "question-26",
};

async function runStepEight(tabId) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 8"] || {};
  const before1 = Number(step.before1);
  const before2 = Number(step.before2);
  const before3 = Number(step.before3);
  const after1 = Number(step.after1);
  const after2 = Number(step.after2);
  if (![before1, before2, before3, after1, after2].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 8 before1, before2, before3, after1, and after2 times are missing from steps.json." };
  }

  report(`Step 8: waiting ${formatWait(before1 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before1 * 60 * 1000, "Step 8");

  report("Step 8: looking for the document link.");
  const opened = await openStepEightDocument(tabId);
  if (!opened?.ok) return opened || { ok: false, message: "Could not open the Step 8 document." };
  report("Step 8: document opened in a new tab.");

  report(`Step 8: waiting ${formatWait(before2 * 60 * 1000)} on the document tab.`);
  await chrome.tabs.update(opened.tabId, { active: true });
  try {
    await dwellQuiet(opened.tabId, before2 * 60 * 1000, "Step 8");
  } finally {
    await chrome.tabs.update(tabId, { active: true });
  }
  report("Step 8: back on the assessment.");

  report(`Step 8: waiting ${formatWait(before3 * 60 * 1000)}.`);
  await dwellQuiet(tabId, before3 * 60 * 1000, "Step 8");

  report("Step 8: typing the answer.");
  const typed = await typeWrittenAnswer(tabId, STEP_EIGHT_ANSWER, after1 * 60 * 1000, STEP_EIGHT_FIELD);
  if (!typed?.ok) return typed || { ok: false, message: "Could not write the Step 8 answer." };
  report("Step 8: answer typed.");

  report(`Step 8: waiting ${formatWait(after2 * 60 * 1000)}.`);
  await dwellQuiet(tabId, after2 * 60 * 1000, "Step 8");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 8");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-8", message: "Answered Step 8 and clicked Next." };
}

const STEP_NINE_OPTION = {
  name: "Step 9",
  optionText: "Software Engineering",
};

async function runStepNine(tabId) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 9"] || {};
  const before = Number(step.before);
  const after = Number(step.after);
  if (![before, after].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 9 before and after times are missing from steps.json." };
  }

  report(`Step 9: waiting ${formatWait(before * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, before * 60 * 1000, "Step 9");

  report("Step 9: looking for the answer option.");
  const selected = await retryInPage(tabId, selectWrittenOption, [STEP_NINE_OPTION], "Could not select the Step 9 option.", 60000);
  if (!selected?.ok) return selected;
  report("Step 9: option found. Selected.");

  report(`Step 9: waiting ${formatWait(after * 60 * 1000)}.`);
  await dwellQuiet(tabId, after * 60 * 1000, "Step 9");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 9");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-9", message: "Answered Step 9 and clicked Next." };
}

const STEP_TEN_UNDER_30 = [
  "HTML/CSS",
  "Python",
  "SQL",
  "Docker",
  ["Javascript", "Typescript"],
  ["Data visualization: matplotlib or D3.js or bokeh or similar", "Front-end development: React or Vue.js or Angular or similar"],
];

const STEP_TEN_OVER_30 = [
  "NoSQL",
  ["Cloud computing: AWS or Azure or Google Cloud Platform or similar", "Unit & functional tests: Selenium or Cypress or Mocha or similar"],
];

async function runStepTen(tabId, ageValue) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 10"] || {};
  const before = Number(step.before);
  const after = Number(step.after);
  if (![before, after].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 10 before and after times are missing from steps.json." };
  }
  const age = Number(String(ageValue ?? "").trim());
  if (!Number.isFinite(age) || age < 0) return { ok: false, message: "Load an age before Step 10." };

  const older = age >= 30;
  const labels = stepTenOptionLabels(older);
  report(`Step 10: age ${age}. ${older ? "Selecting the 30 or older skills." : "Selecting the under-30 skills."}`);

  report(`Step 10: waiting ${formatWait(before * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, before * 60 * 1000, "Step 10");

  for (const optionText of labels) {
    report(`Step 10: looking for “${optionText}”.`);
    const selected = await retryInPage(tabId, selectStepTenOption, [{ optionText }], "Could not select a Step 10 option.", 60000);
    if (!selected?.ok) return selected;
    report(`Step 10: “${optionText}” found. Selected.`);
  }

  report(`Step 10: waiting ${formatWait(after * 60 * 1000)}.`);
  await dwellQuiet(tabId, after * 60 * 1000, "Step 10");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 10");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-10", message: `Answered Step 10 for age ${age} and clicked Next.` };
}

function stepTenOptionLabels(older) {
  const chosen = STEP_TEN_UNDER_30.map((entry) => (Array.isArray(entry) ? entry[Math.floor(Math.random() * entry.length)] : entry));
  if (older) {
    for (const entry of STEP_TEN_OVER_30) chosen.push(Array.isArray(entry) ? entry[Math.floor(Math.random() * entry.length)] : entry);
  }
  return [...new Set(chosen)];
}

function selectStepTenOption(target) {
  const input = findLabeledInput(target.optionText, "checkbox");
  if (!input) return { ok: false, message: `The Step 10 option “${target.optionText}” is not on this page.` };
  if (!input.checked) {
    const label = input.closest("label") || (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null);
    (label || input).click();
    if (!input.checked) input.click();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (!input.checked) return { ok: false, message: `Could not select “${target.optionText}”.` };
  return { ok: true };

  function findLabeledInput(text, type) {
    const wanted = normalize(text);
    for (const label of document.querySelectorAll("label")) {
      if (normalize(label.innerText || label.textContent) !== wanted) continue;
      const nested = label.querySelector(`input[type="${type}"]`);
      const linked = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const input = nested || (linked?.type === type ? linked : null);
      if (input) return input;
    }
    return null;
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
}

async function runStepEleven(tabId) {
  report("Step 11: looking for Submit or the English question.");
  const deadline = Date.now() + 60000;
  let sawEnglish = false;
  while (Date.now() < deadline) {
    const state = await tryInPage(tabId, stepElevenState);
    if (state?.english) {
      sawEnglish = true;
      break;
    }
    if (state?.submit) {
      report("Step 11: Submit found. Clicking.");
      const clicked = await tryInPage(tabId, clickSubmit);
      if (clicked?.ok) return { ok: true, finished: true, submitted: true, stage: "step-11", message: "Clicked Submit." };
    }
    await delay(500);
  }
  if (!sawEnglish) return { ok: false, message: "Step 11 did not show Submit or the English question." };

  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 11"] || {};
  const before = Number(step.before);
  const after = Number(step.after);
  if (![before, after].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 11 before and after times are missing from steps.json." };
  }

  report(`Step 11: waiting ${formatWait(before * 60 * 1000)}.`);
  await dwellQuiet(tabId, before * 60 * 1000, "Step 11");

  report("Step 11: looking for Native English speaker.");
  const selected = await retryInPage(
    tabId,
    selectWrittenOption,
    [{ name: "Step 11", optionText: "Native English speaker" }],
    "Could not select Native English speaker.",
    60000,
  );
  if (!selected?.ok) return selected;
  report("Step 11: Native English speaker found. Selected.");

  report(`Step 11: waiting ${formatWait(after * 60 * 1000)}.`);
  await dwellQuiet(tabId, after * 60 * 1000, "Step 11");

  const clicked = await clickNextOrSubmit(tabId, "Step 11");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next or Submit." };
  return {
    ok: true,
    finished: clicked.finished,
    submitted: Boolean(clicked.submitted),
    stage: "step-11",
    message: clicked.finished ? "Answered Step 11 and clicked Submit." : "Answered Step 11 and clicked Next.",
  };
}

function stepElevenState() {
  return {
    submit: Boolean(findSubmitButton()),
    english: Boolean(findEnglishOption()),
  };

  function findEnglishOption() {
    const wanted = "native english speaker";
    for (const label of document.querySelectorAll("label")) {
      const text = String(label.innerText || label.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text !== wanted) continue;
      const input = label.querySelector('input[type="radio"]');
      if (input) return input;
    }
    return null;
  }

  function findSubmitButton() {
    const byTest = document.querySelector('button[data-testid="task-response-editor-submit"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].find((button) => buttonText(button) === "submit" && isVisible(button)) || null;
  }

  function buttonText(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function clickSubmit() {
  const button = findSubmitButton();
  if (!button) return { ok: false, message: "Submit is not on this page." };
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    return { ok: false, message: "Submit is still disabled." };
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  button.click();
  return { ok: true };

  function findSubmitButton() {
    const byTest = document.querySelector('button[data-testid="task-response-editor-submit"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].find((button) => buttonText(button) === "submit" && isVisible(button)) || null;
  }

  function buttonText(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function clickNextOrSubmit(tabId, label) {
  const name = label || "Page";
  report(`${name}: looking for Next or Submit.`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await tryInPage(tabId, nextOrSubmitState);
    if (state?.next) {
      const clicked = await tryInPage(tabId, clickLinearizedNext);
      if (clicked?.ok) {
        report(`${name}: Next clicked.`);
        return { ok: true, finished: false };
      }
    } else if (state?.submit) {
      const clicked = await tryInPage(tabId, clickSubmit);
      if (clicked?.ok) {
        report(`${name}: Submit clicked.`);
        return { ok: true, finished: true, submitted: true };
      }
    }
    await delay(500);
  }
  return { ok: false, message: "Could not click Next or Submit." };
}

function nextOrSubmitState() {
  const next = findAssessmentNext();
  const submit = findSubmitButton();
  return {
    next: Boolean(next && !next.disabled && next.getAttribute("aria-disabled") !== "true"),
    submit: Boolean(submit && !submit.disabled && submit.getAttribute("aria-disabled") !== "true"),
  };

  function findAssessmentNext() {
    const byTest = document.querySelector('button[data-testid="linearized-next"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].reverse().find((button) => buttonText(button) === "next" && isVisible(button)) || null;
  }

  function findSubmitButton() {
    const byTest = document.querySelector('button[data-testid="task-response-editor-submit"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].find((button) => buttonText(button) === "submit" && isVisible(button)) || null;
  }

  function buttonText(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function runStepTwelve(tabId, country) {
  const countryName = countryDisplayName(country);
  if (!countryName) return { ok: false, message: "Load a country before Step 12." };
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 12"] || {};
  const before = Number(step.before);
  const after = Number(step.after);
  if (![before, after].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 12 before and after times are missing from steps.json." };
  }

  report(`Step 12: waiting ${formatWait(before * 60 * 1000)}.`);
  await dwellQuiet(tabId, before * 60 * 1000, "Step 12");

  report(`Step 12: looking for ${countryName}.`);
  const selected = await retryInPage(
    tabId,
    selectWrittenOption,
    [{ name: "Step 12", optionText: countryName }],
    `Could not select ${countryName}.`,
    60000,
  );
  if (!selected?.ok) return selected;
  report(`Step 12: ${countryName} found. Selected.`);

  report(`Step 12: waiting ${formatWait(after * 60 * 1000)}.`);
  await dwellQuiet(tabId, after * 60 * 1000, "Step 12");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 12");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-12", message: `Selected ${countryName} on Step 12 and clicked Next.` };
}

async function runStepThirteen(tabId) {
  report("Step 13: looking for Submit.");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const clicked = await tryInPage(tabId, clickSubmit);
    if (clicked?.ok) {
      report("Step 13: Submit found. Clicked.");
      return { ok: true, finished: true, submitted: true, stage: "step-13", message: "Clicked Submit." };
    }
    report("Step 13: Submit not ready. Waiting.");
    await delay(500);
  }
  return { ok: false, message: "Submit did not appear." };
}

async function openStepEightDocument(tabId) {
  const current = await chrome.tabs.get(tabId);
  const found = await retryInPage(tabId, findStepEightLink, [STEP_EIGHT_DOC], "The Step 8 document link is not on this page.", 60000);
  if (!found?.ok || !found.href) return found?.ok ? { ok: false, message: "The Step 8 document link is not on this page." } : found;

  const opened = waitForNewTab(current.windowId, 2500);
  await tryInPage(tabId, clickStepSevenLink, [found.href]);
  const created = await opened;
  if (created?.id && created.id !== tabId) return { ok: true, tabId: created.id };

  const createdByExtension = await chrome.tabs.create({ url: found.href, active: false, openerTabId: tabId });
  if (!createdByExtension?.id) return { ok: false, message: "The Step 8 document link did not open a new tab." };
  return { ok: true, tabId: createdByExtension.id };
}

function findStepEightLink(href) {
  const link = [...document.querySelectorAll("a[href]")].find((anchor) => sameDocHref(anchor.href, href) && isVisible(anchor));
  if (!link) return { ok: false, message: "The Step 8 document link is not on this page." };
  return { ok: true, href: link.href };

  function sameDocHref(left, right) {
    return String(left || "").replace(/\/+$/, "") === String(right || "").replace(/\/+$/, "");
  }

  function isVisible(anchor) {
    const style = window.getComputedStyle(anchor);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function openStepSevenDocument(tabId) {
  const current = await chrome.tabs.get(tabId);
  const found = await retryInPage(tabId, findStepSevenLink, [], "The Step 7 document link is not on this page.", 60000);
  if (!found?.ok || !found.href) return found?.ok ? { ok: false, message: "The Step 7 document link is not on this page." } : found;

  const opened = waitForNewTab(current.windowId, 2500);
  await tryInPage(tabId, clickStepSevenLink, [found.href]);
  const created = await opened;
  if (created?.id && created.id !== tabId) return { ok: true, tabId: created.id };

  const createdByExtension = await chrome.tabs.create({ url: found.href, active: false, openerTabId: tabId });
  if (!createdByExtension?.id) return { ok: false, message: "The Step 7 document link did not open a new tab." };
  return { ok: true, tabId: createdByExtension.id };
}

function waitForNewTab(windowId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onCreated(tab) {
      if (windowId && tab.windowId !== windowId) return;
      finish(tab);
    }
    function finish(tab) {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      resolve(tab);
    }
    chrome.tabs.onCreated.addListener(onCreated);
  });
}

function findStepSevenLink() {
  const link = stepSevenLink();
  if (!link) return { ok: false, message: "The Step 7 document link is not on this page." };
  return { ok: true, href: link.href };

  function stepSevenLink() {
    const anchors = [...document.querySelectorAll("a[href]")].filter(isVisible);
    return (
      anchors.find((anchor) => /docs\.google\.com\/document/i.test(anchor.href)) ||
      anchors.find((anchor) => anchor.target === "_blank" && /^https?:/i.test(anchor.href)) ||
      anchors.find((anchor) => /^https?:/i.test(anchor.href) && anchor.origin !== location.origin) ||
      null
    );
  }

  function isVisible(anchor) {
    const style = window.getComputedStyle(anchor);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function clickStepSevenLink(href) {
  const link = [...document.querySelectorAll("a[href]")].find((anchor) => anchor.href === href) || stepSevenLink();
  if (!link) return { ok: false, message: "The Step 7 document link is not on this page." };
  link.scrollIntoView({ block: "center", inline: "nearest" });
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
  return { ok: true, href: link.href };

  function stepSevenLink() {
    const anchors = [...document.querySelectorAll("a[href]")].filter(isVisible);
    return (
      anchors.find((anchor) => /docs\.google\.com\/document/i.test(anchor.href)) ||
      anchors.find((anchor) => anchor.target === "_blank" && /^https?:/i.test(anchor.href)) ||
      anchors.find((anchor) => /^https?:/i.test(anchor.href) && anchor.origin !== location.origin) ||
      null
    );
  }

  function isVisible(anchor) {
    const style = window.getComputedStyle(anchor);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = anchor.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function revealQuestionTextarea(questionId) {
  const root = document.getElementById(questionId);
  if (!root) {
    window.scrollBy(0, Math.max(240, window.innerHeight * 0.6));
    return { ok: false, message: "The Step 7 explanation field is not on this page." };
  }
  root.scrollIntoView({ block: "center", inline: "nearest" });
  const area = [...root.querySelectorAll("textarea")].pop();
  if (!area) return { ok: false, message: "The Step 7 explanation field is not on this page." };
  area.scrollIntoView({ block: "center", inline: "nearest" });
  return { ok: true };
}

function writeStepSevenCode(code) {
  const content = document.querySelector(".cm-content");
  if (!content) return { ok: false, message: "The Step 7 code editor is not on this page." };
  content.scrollIntoView({ block: "center", inline: "nearest" });
  const view = editorView(content);
  if (view?.dispatch && view.state?.doc) {
    view.focus();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: String(code) },
    });
    const written = view.state.doc.toString();
    const visible = content.innerText || "";
    if (sameText(written, code) || codeLanded(written, code) || codeLanded(visible, code)) return { ok: true };
    return { ok: false, message: "Could not write the Step 7 code." };
  }

  content.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand("insertText", false, String(code));
  if (sameText(content.innerText || "", code) || codeLanded(content.innerText || "", code)) return { ok: true };
  return { ok: false, message: "Could not write the Step 7 code." };

  function sameText(left, right) {
    return String(left).replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").replace(/\s+$/g, "") === String(right).replace(/\r\n/g, "\n").replace(/\s+$/g, "");
  }

  function codeLanded(written, code) {
    const left = String(written || "").replace(/\s+/g, "");
    const right = String(code || "").replace(/\s+/g, "");
    if (right.length < 40 || left.length < 40) return false;
    return left.includes(right.slice(0, 80)) && left.length >= right.length * 0.8;
  }

  function editorView(node) {
    for (let element = node; element; element = element.parentNode) {
      const view = element.cmView;
      if (view?.view?.dispatch) return view.view;
      if (view?.dispatch && view.state?.doc) return view;
    }
    return null;
  }
}

async function loadStepSeven() {
  const response = await fetch(chrome.runtime.getURL("data/step7.json"));
  if (!response.ok) throw new Error("Could not read step7.json.");
  return response.json();
}

async function loadAnswerPool(fileName) {
  const response = await fetch(chrome.runtime.getURL(`data/${fileName}`));
  if (!response.ok) throw new Error(`Could not read ${fileName}.`);
  const data = await response.json();
  return (Array.isArray(data) ? data : []).map((item) => String(item ?? "").trim()).filter(Boolean);
}

function normalizeAssessmentId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return "";
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : text;
}

function formatJst(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} JST`;
}

async function notifyAssessment(payload) {
  const id = payload.id ?? assessmentId;
  if (id === "" || id == null) return;
  const body = { ...payload, id, name: payload.name ?? assessmentName };
  try {
    const response = await fetch(NOTIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-notify-secret": NOTIFY_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.error("Assessment notify failed:", response.status);
  } catch (error) {
    console.error("Assessment notify failed:", error?.message || error);
  }
}

async function reportAssessmentResult(result) {
  if (result?.paused) return;
  if (result?.submitted) {
    await notifyAssessment({ event: "ended", "ended at": formatJst() });
    return;
  }
  if (result && result.ok === false) {
    await notifyAssessment({
      event: "stuck",
      stage: stageLabel(progressStage),
      error: result.message || "The assessment stopped.",
    });
  }
}

function reportStage(stage, message) {
  if (stage) progressStage = stage;
  chrome.runtime.sendMessage({ type: "stage-progress", stage: stage || progressStage, message }).catch(() => {});
}

function report(message) {
  reportStage(progressStage, message);
}

function stageLabel(stage) {
  const labels = {
    welcome: "Welcome",
    resume: "Resume",
    linkedin: "LinkedIn",
    experience: "Experience",
    education: "Education",
    about: "About you",
    availability: "Availability",
    "view-assessment": "View assessment",
    "start-assessment": "Start assessment",
    "step-1": "Step 1",
    "step-2": "Step 2",
    "step-3": "Step 3",
    "step-4": "Step 4",
    "step-5": "Step 5",
    "step-6": "Step 6",
    "step-7": "Step 7",
    "step-8": "Step 8",
    "step-9": "Step 9",
    "step-10": "Step 10",
    "step-11": "Step 11",
    "step-12": "Step 12",
    "step-13": "Step 13",
  };
  return labels[stage] || stage;
}

function formatWait(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return `${minutes} min`;
}

function shortLine(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

async function retryInPage(tabId, func, args, failureMessage, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, message: failureMessage };
  while (Date.now() < deadline) {
    const result = await tryInPage(tabId, func, args);
    if (result?.ok) return result;
    if (result?.message) last = result;
    await delay(500);
  }
  return last;
}

function selectWrittenOption(target) {
  const input = findWrittenOption(target);
  if (!input) return { ok: false, message: `The ${target.name} option is not on this page.` };
  const label = input.closest("label") || (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null);
  (label || input).click();
  if (!input.checked) input.click();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (!input.checked) return { ok: false, message: `Could not select the ${target.name} option.` };
  return { ok: true };

  function findWrittenOption(target) {
    const wanted = normalize(target.optionText);
    for (const label of document.querySelectorAll("label")) {
      if (normalize(label.innerText || label.textContent) !== wanted) continue;
      const nested = label.querySelector('input[type="radio"]');
      const linked = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const input = nested || (linked?.type === "radio" ? linked : null);
      if (input) return input;
    }
    return null;
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
}

async function typeWrittenAnswer(tabId, text, durationMs, target) {
  const actions = buildTypingActions(text, durationMs);
  let batch = [];
  let batchTime = 0;
  let reset = true;
  let typed = 0;
  const started = Date.now();
  let last = { ok: false, message: `Could not write the ${target.name} answer.` };

  for (const action of actions) {
    batch.push(action);
    batchTime += action.delay;
    if (action.type === "char") typed += 1;
    if (batchTime < 15000) continue;
    report(`${target.name}: typing ${typed} characters. ${formatWait(Math.max(0, durationMs - (Date.now() - started)))} left.`);
    last = await runInPage(tabId, typeWrittenChars, [{ actions: batch, reset, questionId: target.questionId, name: target.name }]);
    if (!last?.ok) return last || { ok: false, message: `Could not write the ${target.name} answer.` };
    batch = [];
    batchTime = 0;
    reset = false;
  }

  if (batch.length) {
    last = await runInPage(tabId, typeWrittenChars, [{ actions: batch, reset, questionId: target.questionId, name: target.name }]);
    if (!last?.ok) return last || { ok: false, message: `Could not write the ${target.name} answer.` };
  }
  if (last.value !== text) return { ok: false, message: `The ${target.name} answer was not written completely.` };
  return { ok: true };
}

function buildTypingActions(text, durationMs) {
  const actions = [];
  for (const char of text) {
    const typo = typoFor(char);
    if (typo) {
      actions.push({ type: "char", value: typo });
      actions.push({ type: "backspace" });
    }
    actions.push({ type: "char", value: char });
  }
  const delays = paceDelays(actions.length, durationMs);
  return actions.map((action, index) => ({ ...action, delay: delays[index] }));
}

function typoFor(char) {
  if (!/[a-z]/i.test(char) || Math.random() > 0.08) return "";
  const neighbors = {
    a: "sqwz", b: "vghn", c: "xdfv", d: "sfec", e: "wsdr", f: "dgcr", g: "fhtv", h: "gjyn", i: "ujko", j: "hkun",
    k: "jlim", l: "kop", m: "njk", n: "bmhj", o: "ilkp", p: "ol", q: "wa", r: "edft", s: "awed", t: "rfgy", u: "yhji",
    v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
  };
  const pool = neighbors[char.toLowerCase()] || "abcdefghijklmnopqrstuvwxyz";
  const wrong = pool[Math.floor(Math.random() * pool.length)];
  if (!wrong || wrong.toLowerCase() === char.toLowerCase()) return "";
  return char === char.toUpperCase() ? wrong.toUpperCase() : wrong;
}

function paceDelays(count, totalMs) {
  const total = Math.max(0, Math.round(totalMs));
  if (count <= 0) return [];
  if (!total) return Array(count).fill(0);
  const weights = Array.from({ length: count }, () => 0.15 + Math.random() * Math.random() * 5);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const delays = weights.map((weight) => Math.floor((weight / weightSum) * total));
  let used = delays.reduce((sum, delay) => sum + delay, 0);
  let index = 0;
  while (used < total) {
    delays[index % count] += 1;
    used += 1;
    index += 1;
  }
  return delays;
}

async function typeWrittenChars(payload) {
  const root = document.getElementById(payload.questionId);
  const areas = root ? [...root.querySelectorAll("textarea")] : [];
  const area = areas[areas.length - 1];
  if (!area) return { ok: false, message: `The ${payload.name} answer field is not on this page.` };
  area.scrollIntoView({ block: "center", inline: "nearest" });
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return { ok: false, message: `Could not write the ${payload.name} answer.` };

  area.focus();
  let value = payload.reset ? "" : area.value;
  setter.call(area, value);
  area.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: payload.reset ? "deleteContentBackward" : "insertText" }));

  for (const action of payload.actions) {
    if (action.delay) await wait(action.delay);
    if (action.type === "backspace") value = value.slice(0, -1);
    else value += action.value;
    setter.call(area, value);
    area.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: action.type === "backspace" ? null : action.value,
        inputType: action.type === "backspace" ? "deleteContentBackward" : "insertText",
      }),
    );
  }
  area.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value };

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const STEP_FOUR_MATCHERS = [
  (text) => text.includes("initialize"),
  (text) => text.includes("while"),
  (text) => text.includes("mod"),
  (text) => text.includes("not in"),
  (text) => text.includes("initial value"),
  (text) => text.includes("else"),
  (text) => text.includes("part"),
];

async function runStepFour(tabId) {
  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const step = steps?.["Step 4"] || {};
  const before = Number(step.before);
  const after1 = Number(step.after1);
  const after2 = Number(step.after2);
  if (![before, after1, after2].every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { ok: false, message: "Step 4 before, after1, and after2 times are missing from steps.json." };
  }

  report("Step 4: looking for the seven lines.");
  const ready = await waitForStepFour(tabId);
  if (!ready) return { ok: false, message: "The Step 4 lines did not appear." };
  report("Step 4: all seven lines found.");

  report(`Step 4: waiting ${formatWait(before * 60 * 1000)} before arranging.`);
  await dwellQuiet(tabId, before * 60 * 1000, "Step 4");

  report("Step 4: arranging the lines. Next waits until the order is right.");
  for (;;) {
    const arranged = await arrangeStepFour(tabId);
    if (!arranged?.ok) return arranged || { ok: false, message: "Could not put the Step 4 lines in order." };
    const state = await tryInPage(tabId, readStepFourLines);
    if (stepFourIsOrdered(state?.texts)) break;
    report("Step 4: the list is not in order yet. Arranging again.");
  }

  report(`Step 4: waiting ${formatWait(after2 * 60 * 1000)} before Next.`);
  await dwellQuiet(tabId, after2 * 60 * 1000, "Step 4");
  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 4");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  return { ok: true, stage: "step-4", message: "Arranged Step 4 and clicked Next." };
}

async function waitForStepFour(tabId) {
  const deadline = Date.now() + 60000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    const state = await tryInPage(tabId, readStepFourLines);
    const count = state?.texts?.length || 0;
    if (count >= STEP_FOUR_MATCHERS.length) return true;
    if (Date.now() - lastReport > 2000) {
      report(`Step 4: found ${count} of ${STEP_FOUR_MATCHERS.length} lines. Waiting.`);
      lastReport = Date.now();
    }
    await delay(500);
  }
  return false;
}

const capturedDrags = new Map();

function installDragInterceptListener() {
  if (installDragInterceptListener.installed) return;
  installDragInterceptListener.installed = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Input.dragIntercepted" || !source?.tabId) return;
    const data = dragDataFromEvent(params);
    if (!data) return;
    const queue = capturedDrags.get(source.tabId) || [];
    queue.push(data);
    capturedDrags.set(source.tabId, queue);
  });
}

function dragDataFromEvent(params) {
  const candidate = Array.isArray(params?.data?.items) ? params.data : params;
  if (!Array.isArray(candidate?.items)) return null;
  const data = {
    items: candidate.items,
    dragOperationsMask: Number.isFinite(Number(candidate.dragOperationsMask)) ? Number(candidate.dragOperationsMask) : 1,
  };
  if (Array.isArray(candidate.files)) data.files = candidate.files;
  return data;
}

function pullDragData(tabId) {
  const queue = capturedDrags.get(tabId);
  if (!queue?.length) return null;
  return queue.shift();
}

async function arrangeStepFour(tabId) {
  const target = { tabId };
  installDragInterceptListener();
  try {
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: true });
  } catch {
    await chrome.debugger.detach(target).catch(() => {});
    return { ok: false, message: "Could not start a drag on this page." };
  }

  try {
    for (let index = STEP_FOUR_MATCHERS.length - 1; index >= 0; index -= 1) {
      const itemNumber = index + 1;
      report(`Step 4: item ${itemNumber} of ${STEP_FOUR_MATCHERS.length} — looking.`);
      const points = await runInPage(tabId, stepFourLiftPoints, [index]);
      if (!points?.ok) return points || { ok: false, message: "A Step 4 line is missing." };
      report(`Step 4: item ${itemNumber} — found “${shortLine(points.label)}”.`);
      const lifted = await liftStepFourLine(tabId, target, points.label);
      if (!lifted?.ok) return lifted || { ok: false, message: "Could not drag the Step 4 line." };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Could not rearrange the Step 4 lines." };
  } finally {
    await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function liftStepFourLine(tabId, target, label) {
  const sendMouse = (params) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    pointerType: "mouse",
    ...params,
  });
  const sendDrag = (type, x, y, data) => chrome.debugger.sendCommand(target, "Input.dispatchDragEvent", {
    type,
    x,
    y,
    data,
    modifiers: 0,
  });
  const name = shortLine(label);
  let endX = 0;
  let endY = 0;
  const release = () => sendMouse({
    type: "mouseReleased",
    x: endX,
    y: endY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  }).catch(() => {});

  await release();
  capturedDrags.set(target.tabId, []);
  await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: true }).catch(() => {});

  for (;;) {
    try {
      const before = await runInPage(tabId, stepFourNextHop, [label]);
      if (!before?.ok) {
        report(`Step 4: “${name}” — ${before?.message || "could not read its place"}. Retrying this drag.`);
        await delay(300);
        continue;
      }
      if (before.done) {
        report(`Step 4: “${name}” — is at the top.`);
        return { ok: true };
      }
      report(`Step 4: “${name}” — dragging one place up, above “${shortLine(before.label)}”.`);
      try {
        const started = await startStepFourDrag(tabId, target, label);
        if (started?.ok) {
          const travelSteps = 8;
          const stepDelay = 125;
          await sendDrag("dragEnter", started.fromX, started.fromY, started.data);
          for (let step = 1; step <= travelSteps; step += 1) {
            const x = started.fromX + ((started.x - started.fromX) * step) / travelSteps;
            const y = started.fromY + ((started.y - started.fromY) * step) / travelSteps;
            endX = x;
            endY = y;
            await sendMouse({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
            await sendDrag("dragOver", x, y, started.data);
            await delay(stepDelay);
          }
          await sendDrag("drop", endX, endY, started.data);
          await release();
          report(`Step 4: “${name}” — dropped above “${shortLine(before.label)}”.`);
        } else if (started?.message) {
          report(`Step 4: “${name}” — ${started.message}`);
        }
      } catch (error) {
        await release();
        if (isPaused(error)) throw error;
        report(`Step 4: “${name}” — ${error?.message || "the drag failed"}.`);
      }
      const after = await runInPage(tabId, stepFourNextHop, [label]).catch(() => null);
      if (after?.done) {
        report(`Step 4: “${name}” — is at the top.`);
        return { ok: true };
      }
      const moved = after?.ok && after.place < before.place;
      if (moved) continue;
      report(`Step 4: “${name}” — did not move up. Retrying this drag.`);
      await release();
      await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: true }).catch(() => {});
    } catch (error) {
      await release();
      if (isPaused(error)) throw error;
      report(`Step 4: “${name}” — ${error?.message || "the drag failed"}. Retrying this drag.`);
      await chrome.debugger.sendCommand(target, "Input.setInterceptDrags", { enabled: true }).catch(() => {});
    }
  }
}

function stepFourLiftPoints(index) {
  const rows = largestDragGroup();
  const from = rows.find((row) => matchesStepFour(row.text, index));
  if (!from) return { ok: false, message: "A Step 4 line is missing." };
  const top = topStepFourRow(rows);
  if (!top) return { ok: false, message: "A Step 4 line is missing." };
  const rect = from.handle.getBoundingClientRect();
  return {
    ok: true,
    label: from.text,
    startX: rect.left + rect.width / 2,
    startY: rect.top + rect.height / 2,
  };

  function matchesStepFour(text, index) {
    const checks = [
      (line) => line.includes("initialize"),
      (line) => line.includes("while"),
      (line) => line.includes("mod"),
      (line) => line.includes("not in"),
      (line) => line.includes("initial value"),
      (line) => line.includes("else"),
      (line) => line.includes("part"),
    ];
    return Boolean(checks[index]?.(text));
  }

  function largestDragGroup() {
    const items = [];
    const seen = new Set();
    for (const handle of document.querySelectorAll("[draggable]")) {
      if (!handle.draggable) continue;
      const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
      if (!row || seen.has(row)) continue;
      const line = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!line) continue;
      seen.add(row);
      items.push({ text: line, row, handle, parent: row.parentElement });
    }
    const groups = new Map();
    for (const item of items) {
      const list = groups.get(item.parent) || [];
      list.push(item);
      groups.set(item.parent, list);
    }
    let best = [];
    for (const list of groups.values()) {
      if (list.length > best.length) best = list;
    }
    return best;
  }

  function topStepFourRow(rows) {
    let best = null;
    let bestTop = Infinity;
    for (const row of rows) {
      const edge = row.row.getBoundingClientRect().top;
      if (edge < bestTop) {
        best = row;
        bestTop = edge;
      }
    }
    return best;
  }
}

async function startStepFourDrag(tabId, target, label) {
  const point = await runInPage(tabId, stepFourDragPoint, [label]);
  if (!point?.ok) return point || { ok: false, message: "The drag point moved onto Back. Retrying this drag." };
  const sendMouse = (params) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    pointerType: "mouse",
    ...params,
  });
  const x = point.fromX;
  const y = point.fromY;
  capturedDrags.set(target.tabId, []);
  await sendMouse({ type: "mouseMoved", x, y, button: "none", buttons: 0 });
  const still = await runInPage(tabId, stepFourDragPoint, [label]);
  if (!still?.ok || Math.abs(still.fromX - x) > 2 || Math.abs(still.fromY - y) > 2) {
    return { ok: false, message: still?.message || "The row moved while scrolling. Retrying this drag." };
  }
  await sendMouse({ type: "mousePressed", x: still.fromX, y: still.fromY, button: "left", buttons: 1, clickCount: 1 });
  await sendMouse({ type: "mouseMoved", x: still.fromX + 8, y: still.fromY, button: "left", buttons: 1 });
  let data = pullDragData(target.tabId);
  const deadline = Date.now() + 250;
  while (!data && Date.now() < deadline) {
    await delay(10);
    data = pullDragData(target.tabId);
  }
  if (!data) {
    await sendMouse({ type: "mouseReleased", x: still.fromX, y: still.fromY, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    return { ok: false };
  }
  return { ok: true, data, fromX: still.fromX, fromY: still.fromY, x: still.x, y: still.y };
}

function stepFourDragPoint(excludeText) {
  const rows = largestDragGroup();
  const exclude = String(excludeText || "").replace(/\s+/g, " ").trim().toLowerCase();
  const ordered = rows.slice().sort((a, b) => {
    if (a.row === b.row) return 0;
    const position = a.row.compareDocumentPosition(b.row);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  const index = ordered.findIndex((row) => row.text === exclude);
  if (index <= 0) return { ok: false, message: index === 0 ? "The line is already at the top." : "A Step 4 line is missing." };
  const above = ordered[index - 1];
  const from = ordered[index];
  revealRows(ordered.map((row) => row.row), [above.row, from.row, from.handle]);
  const fromRect = from.handle.getBoundingClientRect();
  const aboveRect = above.row.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;
  const hit = document.elementFromPoint(fromX, fromY);
  if (!hit || isBackControl(hit) || (!from.row.contains(hit) && hit !== from.handle)) {
    return { ok: false, message: "The drag point is on Back. Retrying this drag." };
  }
  return {
    ok: true,
    fromX,
    fromY,
    x: aboveRect.left + aboveRect.width / 2,
    y: aboveRect.top + aboveRect.height * 0.35,
  };

  function isBackControl(node) {
    const control = node.closest("button, a, [role='button']");
    if (!control) return false;
    const text = String(control.innerText || control.textContent || control.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return text === "back" || text.startsWith("back ");
  }

  function revealRows(allRows, pair) {
    const rows = allRows.filter(Boolean);
    const needed = pair.filter(Boolean);
    const height = rows.reduce((sum, row) => sum + (row.offsetHeight || 0), 0);
    const focus = rows.length && height > 0 && height <= window.innerHeight - 96 ? rows : needed;
    if (!focus.length) return;
    focus[Math.floor(focus.length / 2)].scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    for (let pass = 0; pass < 10; pass += 1) {
      const rects = focus.map((node) => node.getBoundingClientRect()).filter((rect) => rect.height > 0);
      if (!rects.length) return;
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      const marginTop = 80;
      const marginBottom = 16;
      if (top >= marginTop && bottom <= window.innerHeight - marginBottom) return;
      const delta = top < marginTop ? top - marginTop : bottom - (window.innerHeight - marginBottom);
      if (!delta) return;
      let moved = false;
      for (let element = focus[0].parentElement; element; element = element.parentElement) {
        const before = focus[0].getBoundingClientRect().top;
        const previous = element.style.scrollBehavior;
        element.style.scrollBehavior = "auto";
        element.scrollTop += delta;
        element.style.scrollBehavior = previous;
        if (Math.abs(focus[0].getBoundingClientRect().top - before) > 1) {
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
          moved = true;
          break;
        }
      }
      if (moved) continue;
      const before = focus[0].getBoundingClientRect().top;
      window.scrollBy({ top: delta, left: 0, behavior: "instant" });
      document.scrollingElement?.dispatchEvent(new Event("scroll", { bubbles: true }));
      if (Math.abs(focus[0].getBoundingClientRect().top - before) <= 1) return;
    }
  }

  function largestDragGroup() {
    const items = [];
    const seen = new Set();
    for (const handle of document.querySelectorAll("[draggable]")) {
      if (!handle.draggable) continue;
      const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
      if (!row || seen.has(row)) continue;
      const line = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!line) continue;
      seen.add(row);
      items.push({ text: line, row, handle, parent: row.parentElement });
    }
    const groups = new Map();
    for (const item of items) {
      const list = groups.get(item.parent) || [];
      list.push(item);
      groups.set(item.parent, list);
    }
    let best = [];
    for (const list of groups.values()) {
      if (list.length > best.length) best = list;
    }
    return best;
  }
}

function stepFourIsOrdered(texts) {
  const lines = (texts || []).map((text) => String(text || "").replace(/\s+/g, " ").trim().toLowerCase());
  if (lines.length < STEP_FOUR_MATCHERS.length) return false;
  return STEP_FOUR_MATCHERS.every((matches, index) => matches(lines[index] || ""));
}

function stepFourNextHop(excludeText) {
  const rows = largestDragGroup();
  const exclude = String(excludeText || "").replace(/\s+/g, " ").trim().toLowerCase();
  const ordered = rows.slice().sort((a, b) => {
    if (a.row === b.row) return 0;
    const position = a.row.compareDocumentPosition(b.row);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  const index = ordered.findIndex((row) => row.text === exclude);
  if (index < 0) return { ok: false, message: "A Step 4 line is missing." };
  if (index === 0) return { ok: true, done: true, place: 0, label: ordered[0].text };
  const above = ordered[index - 1];
  const from = ordered[index];
  revealRows(ordered.map((row) => row.row), [above.row, from.row, from.handle]);
  nudgeOffBack(from);
  const fromRect = from.handle.getBoundingClientRect();
  const fromRowRect = from.row.getBoundingClientRect();
  const aboveRect = above.row.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;
  const hit = document.elementFromPoint(fromX, fromY);
  if (!fullyVisible(fromRowRect) || !fullyVisible(aboveRect) || !fullyVisible(fromRect)) {
    return { ok: false, message: "A Step 4 line is off the screen." };
  }
  if (!hit || isBackControl(hit)) {
    return { ok: false, message: "The drag point is on Back. Retrying this drag." };
  }
  return {
    ok: true,
    done: false,
    place: index,
    label: above.text,
    fromX,
    fromY,
    x: aboveRect.left + aboveRect.width / 2,
    y: aboveRect.top + aboveRect.height * 0.35,
  };

  function nudgeOffBack(from) {
    for (let pass = 0; pass < 6; pass += 1) {
      const rect = from.handle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !isBackControl(hit)) return;
      let scrolled = false;
      for (let element = from.row.parentElement; element && !scrolled; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (!/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight + 2) continue;
        const before = element.scrollTop;
        const previous = element.style.scrollBehavior;
        element.style.scrollBehavior = "auto";
        element.scrollTop -= 72;
        element.style.scrollBehavior = previous;
        scrolled = element.scrollTop !== before;
      }
      if (!scrolled) window.scrollBy({ top: -72, left: 0, behavior: "instant" });
    }
  }

  function isBackControl(node) {
    const control = node.closest("button, a, [role='button']");
    if (!control) return false;
    const text = String(control.innerText || control.textContent || control.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return text === "back" || text.startsWith("back ");
  }

  function revealRows(allRows, pair) {
    const rows = allRows.filter(Boolean);
    const needed = pair.filter(Boolean);
    const height = rows.reduce((sum, row) => sum + (row.offsetHeight || 0), 0);
    const focus = rows.length && height > 0 && height <= window.innerHeight - 96 ? rows : needed;
    if (!focus.length) return;
    focus[Math.floor(focus.length / 2)].scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    for (let pass = 0; pass < 10; pass += 1) {
      const rects = focus.map((node) => node.getBoundingClientRect()).filter((rect) => rect.height > 0);
      if (!rects.length) return;
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      const marginTop = 80;
      const marginBottom = 16;
      if (top >= marginTop && bottom <= window.innerHeight - marginBottom) return;
      const delta = top < marginTop ? top - marginTop : bottom - (window.innerHeight - marginBottom);
      if (!delta) return;
      let moved = false;
      for (let element = focus[0].parentElement; element; element = element.parentElement) {
        const before = focus[0].getBoundingClientRect().top;
        const previous = element.style.scrollBehavior;
        element.style.scrollBehavior = "auto";
        element.scrollTop += delta;
        element.style.scrollBehavior = previous;
        if (Math.abs(focus[0].getBoundingClientRect().top - before) > 1) {
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
          moved = true;
          break;
        }
      }
      if (moved) continue;
      const before = focus[0].getBoundingClientRect().top;
      window.scrollBy({ top: delta, left: 0, behavior: "instant" });
      document.scrollingElement?.dispatchEvent(new Event("scroll", { bubbles: true }));
      if (Math.abs(focus[0].getBoundingClientRect().top - before) <= 1) return;
    }
  }

  function fullyVisible(rect) {
    const margin = 4;
    return rect.height > 0 && rect.width > 0 && rect.top >= margin && rect.bottom <= window.innerHeight - margin;
  }

  function largestDragGroup() {
    const items = [];
    const seen = new Set();
    for (const handle of document.querySelectorAll("[draggable]")) {
      if (!handle.draggable) continue;
      const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
      if (!row || seen.has(row)) continue;
      const line = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!line) continue;
      seen.add(row);
      items.push({ text: line, row, handle, parent: row.parentElement });
    }
    const groups = new Map();
    for (const item of items) {
      const list = groups.get(item.parent) || [];
      list.push(item);
      groups.set(item.parent, list);
    }
    let best = [];
    for (const list of groups.values()) {
      if (list.length > best.length) best = list;
    }
    return best;
  }
}

function stepFourFirstRowPoint(excludeText) {
  const rows = largestDragGroup();
  const exclude = String(excludeText || "").replace(/\s+/g, " ").trim().toLowerCase();
  let top = null;
  let bestTop = Infinity;
  for (const row of rows) {
    if (exclude && row.text === exclude) continue;
    const edge = row.row.getBoundingClientRect().top;
    if (edge < bestTop) {
      top = row;
      bestTop = edge;
    }
  }
  if (!top) return { ok: false, message: "A Step 4 line is missing." };
  const rect = top.row.getBoundingClientRect();
  return {
    ok: true,
    label: top.text,
    x: rect.left + rect.width / 2,
    y: rect.top + Math.min(4, Math.max(1, rect.height / 4)),
  };

  function largestDragGroup() {
    const items = [];
    const seen = new Set();
    for (const handle of document.querySelectorAll("[draggable]")) {
      if (!handle.draggable) continue;
      const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
      if (!row || seen.has(row)) continue;
      const line = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!line) continue;
      seen.add(row);
      items.push({ text: line, row, handle, parent: row.parentElement });
    }
    const groups = new Map();
    for (const item of items) {
      const list = groups.get(item.parent) || [];
      list.push(item);
      groups.set(item.parent, list);
    }
    let best = [];
    for (const list of groups.values()) {
      if (list.length > best.length) best = list;
    }
    return best;
  }
}

function nextStepFourMove(texts) {
  const normalized = texts.map(normalizeLine);
  for (let index = 0; index < STEP_FOUR_MATCHERS.length; index += 1) {
    const matches = STEP_FOUR_MATCHERS[index];
    if (matches(normalized[index] || "")) continue;
    const from = normalized.findIndex((text) => matches(text));
    if (from < 0) return { missing: true };
    return {
      fromText: normalized[from],
      toText: normalized[index],
      place: from > index ? "before" : "after",
    };
  }
  return { done: true };
}

function normalizeLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function dragStepFourByPointer(tabId, move) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch {
    return { ok: false, message: "Could not rearrange the Step 4 lines." };
  }

  try {
    const points = await runInPage(tabId, stepFourDragPoints, [move]);
    if (!points?.ok) return points || { ok: false, message: "A Step 4 line is not on this page." };
    await trustedMouseDrag(target, points.startX, points.startY, points.endX, points.endY);
    await delay(450);
    let after = await stepFourOrderKey(tabId);
    if (after === points.before) {
      const center = await runInPage(tabId, stepFourDragPoints, [{ ...move, place: "center" }]);
      if (center?.ok) {
        await trustedMouseDrag(target, center.startX, center.startY, center.endX, center.endY);
        await delay(450);
        after = await stepFourOrderKey(tabId);
      }
    }
    return { ok: true, changed: after !== points.before };
  } catch {
    return { ok: false, message: "Could not rearrange the Step 4 lines." };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function stepFourOrderKey(tabId) {
  const state = await tryInPage(tabId, readStepFourLines);
  return (state?.texts || []).join("|");
}

async function trustedMouseDrag(target, startX, startY, endX, endY) {
  const send = (params) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", params);
  await send({ type: "mouseMoved", x: startX, y: startY });
  await send({ type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1 });
  await delay(60);
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await send({
      type: "mouseMoved",
      x: startX + ((endX - startX) * step) / steps,
      y: startY + ((endY - startY) * step) / steps,
      button: "left",
      buttons: 1,
    });
    await delay(30);
  }
  await delay(80);
  await send({ type: "mouseReleased", x: endX, y: endY, button: "left", buttons: 0, clickCount: 1 });
}

function stepFourDragPoints(move) {
  const rows = collectStepFourRows();
  const from = rows.find((row) => row.text === move.fromText);
  const to = rows.find((row) => row.text === move.toText);
  if (!from || !to || from.row === to.row) return { ok: false, message: "A Step 4 line is not on this page." };
  from.handle.scrollIntoView({ block: "center", inline: "nearest" });
  to.row.scrollIntoView({ block: "nearest", inline: "nearest" });
  const fromRect = from.handle.getBoundingClientRect();
  const toRect = to.row.getBoundingClientRect();
  const endY = move.place === "before"
    ? toRect.top + Math.min(8, toRect.height / 4)
    : move.place === "after"
      ? toRect.bottom - Math.min(8, toRect.height / 4)
      : toRect.top + toRect.height / 2;
  return {
    ok: true,
    before: rows.map((row) => row.text).join("|"),
    startX: fromRect.left + fromRect.width / 2,
    startY: fromRect.top + fromRect.height / 2,
    endX: toRect.left + Math.max(24, Math.min(toRect.width / 2, toRect.width - 8)),
    endY,
  };

  function collectStepFourRows() {
    return largestDragGroup();

    function largestDragGroup() {
      const items = [];
      const seen = new Set();
      for (const handle of document.querySelectorAll("[draggable]")) {
        if (!handle.draggable) continue;
        const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
        if (!row || seen.has(row)) continue;
        const text = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!text) continue;
        seen.add(row);
        items.push({ text, row, handle, parent: row.parentElement });
      }
      const groups = new Map();
      for (const item of items) {
        const list = groups.get(item.parent) || [];
        list.push(item);
        groups.set(item.parent, list);
      }
      let best = [];
      for (const list of groups.values()) {
        if (list.length > best.length) best = list;
      }
      return best;
    }
  }
}

function readStepFourLines() {
  return { texts: largestDragGroup().map((row) => row.text) };

  function largestDragGroup() {
    const items = [];
    const seen = new Set();
    for (const handle of document.querySelectorAll("[draggable]")) {
      if (!handle.draggable) continue;
      const row = handle.closest(".tw-transition-all") || handle.closest(".tw-border-dashed") || handle.parentElement;
      if (!row || seen.has(row)) continue;
      const text = (row.querySelector("p")?.innerText || row.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;
      seen.add(row);
      items.push({ text, row, handle, parent: row.parentElement });
    }
    const groups = new Map();
    for (const item of items) {
      const list = groups.get(item.parent) || [];
      list.push(item);
      groups.set(item.parent, list);
    }
    let best = [];
    for (const list of groups.values()) {
      if (list.length > best.length) best = list;
    }
    return best;
  }
}

async function dragStepFourLine(move) {
  const rows = collectStepFourRows(move.prefixes);
  const before = rows.map((row) => row.text).join("|");
  const from = rows.find((row) => row.text.startsWith(move.fromPrefix));
  const to = rows.find((row) => row.text === move.toText);
  if (!from || !to || from.row === to.row) return { ok: false, message: "A Step 4 line is not on this page." };

  await dragHandle(from.handle, to.row, move.place);
  await wait(400);
  let after = collectStepFourRows(move.prefixes).map((row) => row.text).join("|");
  if (after === before) {
    moveStepFourRow(from.row, to.row, move.place);
    from.row.dispatchEvent(new Event("drop", { bubbles: true }));
    await wait(250);
    after = collectStepFourRows(move.prefixes).map((row) => row.text).join("|");
  }
  return { ok: true, changed: after !== before };

  async function dragHandle(handle, toRow, place) {
    const dataTransfer = new DataTransfer();
    try {
      dataTransfer.setData("text/plain", "reorder");
      dataTransfer.effectAllowed = "move";
    } catch {
      // Some pages keep dataTransfer restricted.
    }
    const fromRect = handle.getBoundingClientRect();
    const toRect = toRow.getBoundingClientRect();
    const startX = fromRect.left + fromRect.width / 2;
    const startY = fromRect.top + fromRect.height / 2;
    const endX = toRect.left + Math.max(24, toRect.width / 2);
    const endY = place === "before" ? toRect.top + Math.min(10, toRect.height / 4) : toRect.bottom - Math.min(10, toRect.height / 4);
    handle.scrollIntoView({ block: "center" });

    point("pointerdown", startX, startY, handle, 1);
    point("mousedown", startX, startY, handle, 1);
    drag("dragstart", handle, startX, startY, dataTransfer);
    const steps = 4;
    for (let step = 1; step <= steps; step += 1) {
      const x = startX + ((endX - startX) * step) / steps;
      const y = startY + ((endY - startY) * step) / steps;
      point("pointermove", x, y, document, 1);
      point("mousemove", x, y, document, 1);
      drag("dragover", toRow, x, y, dataTransfer);
      await wait(30 + Math.floor(Math.random() * 50));
    }
    drag("dragenter", toRow, endX, endY, dataTransfer);
    drag("dragover", toRow, endX, endY, dataTransfer);
    drag("drop", toRow, endX, endY, dataTransfer);
    drag("dragend", handle, endX, endY, dataTransfer);
    point("pointerup", endX, endY, document, 0);
    point("mouseup", endX, endY, document, 0);
  }

  function point(type, x, y, target, buttons) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
    };
    if (type.startsWith("pointer")) {
      target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      return;
    }
    target.dispatchEvent(new MouseEvent(type, init));
  }

  function drag(type, target, x, y, dataTransfer) {
    target.dispatchEvent(new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      dataTransfer,
    }));
  }

  function moveStepFourRow(fromRow, toRow, place) {
    const parent = fromRow.parentElement;
    if (!parent || parent !== toRow.parentElement) return;
    parent.insertBefore(fromRow, place === "before" ? toRow : toRow.nextSibling);
  }

  function collectStepFourRows(prefixes) {
    const wanted = prefixes.map((prefix) => String(prefix).toLowerCase());
    const seen = new Set();
    const rows = [];
    for (const paragraph of document.querySelectorAll("p")) {
      const text = paragraph.textContent.replace(/\s+/g, " ").trim().toLowerCase();
      const row = paragraph.closest(".tw-transition-all");
      const handle = row?.querySelector("[draggable='true']");
      if (!row || !handle || seen.has(row)) continue;
      if (!wanted.some((prefix) => text.startsWith(prefix))) continue;
      seen.add(row);
      rows.push({ text, row, handle });
    }
    return rows;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function runStepOne(tabId) {
  report("Step 1: looking for Next.");
  const appeared = await waitForLinearizedNext(tabId);
  if (!appeared) return { ok: false, message: "The Next button did not appear." };
  report("Step 1: Next found.");

  let steps;
  try {
    steps = await loadSteps();
  } catch {
    return { ok: false, message: "Could not read steps.json." };
  }
  const minutes = Number(steps?.["Step 1"]?.time);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { ok: false, message: "Step 1 time is missing from steps.json." };
  }

  report(`Step 1: waiting ${formatWait(minutes * 60 * 1000)} and scrolling.`);
  await dwellWithScrolls(tabId, minutes * 60 * 1000, "Step 1");

  const clicked = await clickLinearizedNextWhenReady(tabId, "Step 1");
  if (!clicked?.ok) return clicked || { ok: false, message: "Could not click Next." };
  const waited = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return { ok: true, message: minutes ? `Waited ${waited} on Step 1, then clicked Next.` : "Clicked Next." };
}

async function clickLinearizedNextWhenReady(tabId, label) {
  const name = label || "Page";
  report(`${name}: looking for Next.`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await tryInPage(tabId, linearizedNextState);
    if (state?.present && !state.enabled) report(`${name}: Next found, still disabled. Waiting.`);
    if (state?.enabled) {
      report(`${name}: Next found. Mouse pressed.`);
      const clicked = await tryInPage(tabId, clickLinearizedNext);
      if (clicked?.ok || !clicked?.message) {
        report(`${name}: Next clicked.`);
        return { ok: true, message: "Clicked Next." };
      }
    }
    await delay(500);
  }
  return { ok: false, message: "Could not click Next." };
}

async function loadSteps() {
  const response = await fetch(chrome.runtime.getURL("data/steps.json"));
  if (!response.ok) throw new Error("Could not read steps.json.");
  return response.json();
}

async function waitForLinearizedNext(tabId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await tryInPage(tabId, linearizedNextState);
    if (state?.present) return true;
    await delay(500);
  }
  return false;
}

function linearizedNextState() {
  const button = findAssessmentNext();
  if (!button) return { present: false, enabled: false };
  return {
    present: true,
    enabled: !button.disabled && button.getAttribute("aria-disabled") !== "true",
  };

  function findAssessmentNext() {
    const byTest = document.querySelector('button[data-testid="linearized-next"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].reverse().find((button) => buttonText(button) === "next" && isVisible(button)) || null;
  }

  function buttonText(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function dwellQuiet(tabId, durationMs, label) {
  const end = Date.now() + durationMs;
  const name = label || stageLabel(progressStage);
  if (durationMs > 0) report(`${name}: waiting ${formatWait(durationMs)}.`);
  while (Date.now() < end) {
    const gap = Math.min(end - Date.now(), 15000);
    await delay(gap);
    if (Date.now() >= end) break;
    report(`${name}: still waiting ${formatWait(end - Date.now())}.`);
    await tryInPage(tabId, keepStepAlive);
  }
}

async function dwellWithScrolls(tabId, durationMs, label) {
  const end = Date.now() + durationMs;
  const name = label || stageLabel(progressStage);
  if (durationMs > 0) report(`${name}: waiting ${formatWait(durationMs)} and scrolling.`);
  while (Date.now() < end) {
    const gap = Math.min(end - Date.now(), 10000 + Math.floor(Math.random() * 11000));
    await delay(gap);
    if (Date.now() >= end) break;
    if (Math.random() < 0.7) {
      report(`${name}: scrolling. ${formatWait(end - Date.now())} left.`);
      await tryInPage(tabId, naturalScroll);
    } else {
      report(`${name}: waiting. ${formatWait(end - Date.now())} left.`);
      await tryInPage(tabId, keepStepAlive);
    }
  }
}

function keepStepAlive() {
  return true;
}

async function naturalScroll() {
  const target = scrollTarget();
  const bursts = Math.random() < 0.35 ? 2 : 1;
  for (let index = 0; index < bursts; index += 1) {
    const downward = Math.random() < 0.78;
    const distance = (downward ? 1 : -1) * (70 + Math.floor(Math.random() * 360));
    scrollByAmount(target, distance);
    if (index < bursts - 1) await wait(250 + Math.floor(Math.random() * 700));
  }
  return { ok: true };

  function scrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    let best = root;
    let bestOverflow = overflow(root);
    for (const node of document.querySelectorAll("main, [role='main'], article")) {
      const extra = overflow(node);
      if (extra > bestOverflow + 80) {
        best = node;
        bestOverflow = extra;
      }
    }
    return best || root;
  }

  function overflow(element) {
    if (!element) return 0;
    return element.scrollHeight - element.clientHeight;
  }

  function scrollByAmount(element, distance) {
    if (element && typeof element.scrollBy === "function") element.scrollBy({ top: distance, behavior: "smooth" });
    else window.scrollBy({ top: distance, behavior: "smooth" });
    const wheelTarget = element && element !== document.documentElement && element !== document.body && element !== document.scrollingElement ? element : window;
    wheelTarget.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: distance,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function clickLinearizedNext() {
  const button = findAssessmentNext();
  if (!button) return { ok: false, message: "The Next button is not on this page." };
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    return { ok: false, reason: "disabled", message: "The Next button is still disabled." };
  }
  button.click();
  return { ok: true };

  function findAssessmentNext() {
    const byTest = document.querySelector('button[data-testid="linearized-next"]');
    if (byTest && isVisible(byTest)) return byTest;
    return [...document.querySelectorAll("button")].reverse().find((button) => buttonText(button) === "next" && isVisible(button)) || null;
  }

  function buttonText(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function clickStartAssessmentWhenReady(tabId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const clicked = await tryInPage(tabId, clickStartAssessment);
    if (clicked?.ok) {
      report("Start assessment: button found. Clicked.");
      await notifyAssessment({ event: "started", "started at": formatJst() });
      return clicked;
    }
    report("Start assessment: button not ready. Waiting.");
    await delay(500);
  }
  return { ok: false, message: "Start assessment did not appear." };
}

function clickStartAssessment() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "start assessment" && isVisible(button));
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const target = enabled[enabled.length - 1];
  if (!target) return { ok: false, message: "Start assessment is not on this page." };
  target.click();
  return { ok: true };

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function viewAssessmentReady(tabId) {
  try {
    return Boolean(await runInPage(tabId, viewAssessmentVisible));
  } catch {
    return false;
  }
}

async function startAssessmentReady(tabId) {
  try {
    return Boolean(await runInPage(tabId, startAssessmentVisible));
  } catch {
    return false;
  }
}

async function tryInPage(tabId, func, args) {
  try {
    return await runInPage(tabId, func, args);
  } catch {
    return { ok: false };
  }
}

function viewAssessmentVisible() {
  return [...document.querySelectorAll("button")].some((button) => buttonText(button) === "view assessment" && isVisible(button));

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function startAssessmentVisible() {
  return [...document.querySelectorAll("button")].some((button) => buttonText(button) === "start assessment" && isVisible(button));

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function clickViewAssessment() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "view assessment" && isVisible(button));
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const target = enabled[enabled.length - 1];
  if (!target) return { ok: false, message: "View assessment is not on this page." };
  target.click();
  return { ok: true };

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function clickSaveAndFinish() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "save and finish" && isVisible(button));
  if (!buttons.length) return { ok: false, message: "No Save and finish button on this page." };
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const target = enabled[enabled.length - 1];
  if (!target) return { ok: false, reason: "disabled", message: "The Save and finish button is still disabled." };
  target.click();
  return { ok: true };

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function clickContinue() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "continue" && isVisible(button));
  if (!buttons.length) return { ok: false, message: "No Continue button on this page." };
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const target = enabled[enabled.length - 1];
  if (!target) return { ok: false, reason: "disabled", message: "The Continue button is still disabled." };
  target.click();
  return { ok: true };

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

async function runReviewStep(tabId, message) {
  report(`${stageLabel(progressStage)}: waiting 10s, then looking for Next.`);
  await delay(10000);
  report(`${stageLabel(progressStage)}: looking for Next.`);
  const next = await clickWhenReady(tabId);
  if (!next?.ok) {
    return {
      ok: false,
      message: next?.message || "Could not click Next.",
    };
  }
  return { ok: true, message };
}

async function runLinkedInStep(tabId, url) {
  progressStage = "linkedin";
  report("LinkedIn: looking for the LinkedIn field.");
  const filled = await fillWhenReady(tabId, url);
  if (!filled?.ok) {
    return {
      ok: false,
      message: filled?.message || "Could not fill the LinkedIn URL.",
    };
  }
  report("LinkedIn: field found. URL entered. Looking for Next.");
  const next = await clickWhenReady(tabId);
  if (!next?.ok) {
    return {
      ok: false,
      message: next?.message || "Could not click Next.",
    };
  }
  return { ok: true, message: "Filled LinkedIn and clicked Next." };
}

async function runInPage(tabId, func, args) {
  try {
    return await inject(tabId, func, args, "MAIN");
  } catch (error) {
    if (!/MAIN|world|Cannot access/i.test(error?.message || "")) throw error;
    return inject(tabId, func, args);
  }
}

async function inject(tabId, func, args, world) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args,
  });
  return result?.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delay(ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pauseRequested) {
        reject(new AssessmentPaused(progressStage));
        return;
      }
      const left = ms - (Date.now() - started);
      if (left <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(left, 200));
    };
    tick();
  });
}

class AssessmentPaused extends Error {
  constructor(stage) {
    super(`Paused on ${stageLabel(stage)}.`);
    this.name = "AssessmentPaused";
    this.stage = stage;
  }
}

function isPaused(error) {
  return error?.name === "AssessmentPaused";
}

function pausedResult(stage) {
  pausedStage = stage;
  chrome.storage?.session?.set({ pausedStage: stage }).catch(() => {});
  return {
    ok: true,
    paused: true,
    stage,
    message: `Paused on ${stageLabel(stage)}. Start again from this stage to resume.`,
  };
}

function publishResult(result) {
  chrome.runtime.sendMessage({
    type: "assessment-finished",
    stage: result?.stage || progressStage,
    message: result?.message || "",
    ok: result?.ok !== false,
    paused: Boolean(result?.paused),
  }).catch(() => {});
}

function humanDelay() {
  const ms = 3000 + Math.floor(Math.random() * 1001);
  return delay(ms);
}

async function fillWhenReady(tabId, url) {
  const deadline = Date.now() + 5000;
  let last = { ok: false, message: "LinkedIn field is not on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, fillLinkedIn, [url]);
      if (last?.ok) return last;
    } catch {
      last = { ok: false, message: "LinkedIn field is not on this page." };
    }
    await delay(250);
  }
  return last;
}

async function clickWhenReady(tabId) {
  const deadline = Date.now() + 15000;
  let last = { ok: false, message: "No Next button on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, clickNext);
      if (last?.ok) {
        report(`${stageLabel(progressStage)}: Next found. Clicked.`);
        return last;
      }
      report(`${stageLabel(progressStage)}: Next not ready. Waiting.`);
    } catch {
      last = { ok: false, message: "No Next button on this page." };
    }
    await delay(500);
  }
  return last?.reason === "disabled"
    ? { ok: false, message: "The Next button was still disabled after waiting." }
    : last;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function clickLetsGo() {
  const target = findLetsGo(document);
  if (!target) return { ok: false };
  target.click();
  return { ok: true };

  function findLetsGo(root) {
    const controls = root.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']");
    for (const control of controls) {
      if (isLetsGo(control)) return control;
    }
    for (const element of root.querySelectorAll("*")) {
      if (!element.shadowRoot) continue;
      const nested = findLetsGo(element.shadowRoot);
      if (nested) return nested;
    }
    return null;
  }

  function isLetsGo(control) {
    const candidates = [control.innerText, control.textContent, control.value, control.getAttribute("aria-label")];
    return candidates.some((value) => {
      const text = String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/[’‘]/g, "'");
      return text === "let's go";
    });
  }
}

function fillLinkedIn(url) {
  const input = document.querySelector("#linkedin_url");
  if (!input) return { ok: false, message: "LinkedIn field is not on this page." };
  const value = String(url || "").trim();
  if (!value) return { ok: false, message: "Load a LinkedIn URL before starting the assessment." };

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return { ok: false, message: "Could not fill the LinkedIn URL." };
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  if (input.value !== value) return { ok: false, message: "Could not fill the LinkedIn URL." };
  return { ok: true };
}

function clickNext() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "next" && isVisible(button));
  if (!buttons.length) return { ok: false, message: "No Next button on this page." };
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const target = enabled[enabled.length - 1];
  if (!target) return { ok: false, reason: "disabled", message: "The Next button is still disabled." };
  target.click();
  return { ok: true };

  function buttonText(button) {
    return String(button.innerText || button.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(button) {
    const style = window.getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}

function resumeFieldReady() {
  return Boolean(findResumeInput());

  function findResumeInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const input of inputs) {
      const zone = input.closest("[role='presentation']");
      const text = zone?.textContent || "";
      if (/drag and drop your resume/i.test(text)) return input;
    }
    return null;
  }
}

function uploadResume(file) {
  const input = findResumeInput();
  if (!input) return { ok: false, message: "The resume upload is not on the page." };

  const resume = base64ToFile(file.base64, file.name, file.type);
  if (!resume.size) return { ok: false, message: "The resume file is empty. Load the record again." };
  const transfer = new DataTransfer();
  transfer.items.add(resume);
  const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
  if (!filesSetter) return { ok: false, message: "This page does not allow the resume file to be set." };
  filesSetter.call(input, transfer.files);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const attached = input.files?.[0];
  if (!attached?.size) return { ok: false, message: "The page did not accept the resume file." };
  return { ok: true, name: attached.name, size: attached.size };

  function findResumeInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const candidate of inputs) {
      const zone = candidate.closest("[role='presentation']");
      const text = zone?.textContent || "";
      if (/drag and drop your resume/i.test(text)) return candidate;
    }
    return null;
  }

  function base64ToFile(base64, name, type) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name, { type: type || "application/octet-stream" });
  }
}
