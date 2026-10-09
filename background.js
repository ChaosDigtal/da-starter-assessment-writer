const RESUME_WAIT_MS = 20000;
const RESUME_POLL_MS = 250;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "click-lets-go") return;

  startAssessment(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, message: error?.message || "Could not start the assessment." });
    });

  return true;
});

async function startAssessment(message) {
  const tabId = message.tabId;
  if (!tabId) {
    return { ok: false, message: "No active tab to start the assessment." };
  }
  if (!chrome.scripting?.executeScript) {
    return { ok: false, message: "Reload the extension on chrome://extensions, then try again." };
  }

  const stage = ["resume", "linkedin", "experience", "education", "about", "availability"].includes(message.stage) ? message.stage : "welcome";
  if (stage === "availability") {
    return runAvailabilityStep(tabId);
  }
  if (stage === "about") {
    return finishFrom("about", message, null);
  }
  if (stage === "education") {
    return finishFrom("education", message, null);
  }
  if (stage === "experience") {
    return finishFrom("experience", message, null);
  }
  if (stage === "linkedin") {
    const linkedin = await runLinkedInStep(tabId, message.linkedin);
    if (!linkedin?.ok) return linkedin;
    return finishFrom("experience", message, linkedin.message);
  }

  const resume = message.resume;
  if (!resume?.base64 || !resume.name) {
    return { ok: false, message: "Load a resume before starting the assessment." };
  }

  let clicked = { ok: false };
  if (stage === "welcome") {
    clicked = await runInPage(tabId, clickLetsGo);
  }
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
      const uploaded = await runInPage(tabId, uploadResume, [payload]);
      if (!uploaded?.ok) {
        return {
          ok: false,
          message: uploaded?.message || "The resume field appeared, but the file could not be attached.",
        };
      }
      await delay(30000);
      const linkedin = await runLinkedInStep(tabId, message.linkedin);
      if (!linkedin?.ok) return linkedin;
      return finishFrom(
        "experience",
        message,
        `Uploaded ${uploaded.name || resume.name} (${formatBytes(uploaded.size)}). ${linkedin.message}`,
      );
    }

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

async function finishFrom(stage, message, earlier) {
  const order = ["experience", "education", "about", "availability"];
  const start = order.indexOf(stage);
  const notes = earlier ? [earlier] : [];
  for (const current of order.slice(start)) {
    const result = await runStage(current, message);
    if (!result?.ok) return result;
    if (result.message) notes.push(result.message);
  }
  return { ok: true, message: notes.join(" ") };
}

async function runStage(stage, message) {
  const tabId = message.tabId;
  if (stage === "experience") return runReviewStep(tabId, "Reviewed experience and clicked Next.");
  if (stage === "education") return runReviewStep(tabId, "Reviewed education and clicked Next.");
  if (stage === "about") return runAboutStep(tabId, message.country, message.gender, message.race);
  return runAvailabilityStep(tabId);
}

async function runAboutStep(tabId, country, gender, race) {
  const fluency = fluencyForCountry(country);
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

  await humanDelay();
  const countryResult = await runInPage(tabId, selectCurrentCountry, [countryDisplayName(country)]);
  if (!countryResult?.ok) return countryResult || { ok: false, message: "Could not select the country." };

  await humanDelay();
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

  const raceChoice = profileRace(race);
  if (!raceChoice) {
    return { ok: false, message: "Load a race that matches one of the options on this page." };
  }
  await humanDelay();
  const raceResult = await runInPage(tabId, selectProfileRace, [raceChoice]);
  if (!raceResult?.ok) return raceResult || { ok: false, message: "Could not select race." };

  await humanDelay();
  const source = randomHeardSource();
  const heard = await runInPage(tabId, fillHeardOfUs, [source]);
  if (!heard?.ok) return heard || { ok: false, message: "Could not fill how you found us." };

  await humanDelay();
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
  const deadline = Date.now() + 5000;
  let last = { ok: false, message: "The 20–40 hours option is not on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, clickAvailabilityHours);
      if (last?.ok) {
        await humanDelay();
        const nextClicks = await clickNextUntilGone(tabId);
        const continued = await clickContinueWhenReady(tabId);
        if (!continued?.ok) return continued;
        const nextNote = nextClicks ? ` Clicked Next ${nextClicks} time${nextClicks === 1 ? "" : "s"}.` : "";
        return { ok: true, message: `Selected 20–40 hours per week.${nextNote} Clicked Continue.` };
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

async function clickNextUntilGone(tabId) {
  let clicks = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let state = { present: false, enabled: false };
    try {
      state = (await runInPage(tabId, nextButtonState)) || state;
    } catch {
      break;
    }
    if (!state.present) break;
    if (!state.enabled) {
      await delay(500);
      continue;
    }
    const clicked = await runInPage(tabId, clickNext);
    if (!clicked?.ok) break;
    clicks += 1;
    await humanDelay();
  }
  return clicks;
}

function nextButtonState() {
  const buttons = [...document.querySelectorAll("button")].filter((button) => buttonText(button) === "next" && isVisible(button));
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  return { present: buttons.length > 0, enabled: enabled.length > 0 };

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

async function clickContinueWhenReady(tabId) {
  const deadline = Date.now() + 15000;
  let last = { ok: false, message: "No Continue button on this page." };
  while (Date.now() < deadline) {
    try {
      last = await runInPage(tabId, clickContinue);
      if (last?.ok) return { ok: true, message: "Selected 20–40 hours per week and clicked Continue." };
    } catch {
      last = { ok: false, message: "No Continue button on this page." };
    }
    await delay(500);
  }
  return last?.reason === "disabled"
    ? { ok: false, message: "The Continue button was still disabled after waiting." }
    : last;
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
  await delay(10000);
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
  const filled = await fillWhenReady(tabId, url);
  if (!filled?.ok) {
    return {
      ok: false,
      message: filled?.message || "Could not fill the LinkedIn URL.",
    };
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      if (last?.ok) return last;
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
