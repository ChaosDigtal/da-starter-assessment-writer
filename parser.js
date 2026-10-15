const FIELD_COUNT = 8;

const FIELD_NAMES = [
  "id",
  "fullName",
  "age",
  "gender",
  "race",
  "country",
  "linkedin",
  "resumeUrl",
];

export function parseRecord(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("Paste a candidate record before loading.");
  }

  const fields = [];
  const pattern = /\{([^{}]*)\}/g;
  let match = pattern.exec(text);
  while (match) {
    fields.push(match[1].trim());
    match = pattern.exec(text);
  }

  if (fields.length !== FIELD_COUNT) {
    throw new Error(
      `Expected 8 brace groups (ID, name, age, gender, race, country, LinkedIn, Drive resume). Found ${fields.length}.`,
    );
  }

  const record = {};
  FIELD_NAMES.forEach((name, index) => {
    record[name] = fields[index];
  });

  if (!/^\d+$/.test(record.id)) {
    throw new Error("ID must be a whole number.");
  }

  if (!record.fullName) {
    throw new Error("Full name is empty.");
  }

  if (record.age && !/^\d{1,3}$/.test(record.age)) {
    throw new Error("Age must be a whole number.");
  }

  if (record.linkedin && !isHttpUrl(record.linkedin)) {
    throw new Error("LinkedIn value is not a valid URL.");
  }

  if (!record.resumeUrl) {
    throw new Error("Resume Google Drive URL is missing.");
  }

  if (!isHttpUrl(record.resumeUrl)) {
    throw new Error("Resume value is not a valid URL.");
  }

  return record;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
