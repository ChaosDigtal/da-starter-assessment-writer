const FILE_ID_PATTERNS = [
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
];

const MAX_RESUME_BYTES = 25 * 1024 * 1024;

const EXTENSION_BY_TYPE = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "text/plain": ".txt",
  "application/vnd.oasis.opendocument.text": ".odt",
};

const RESUME_EXTENSIONS = new Set(Object.values(EXTENSION_BY_TYPE));

export function extractDriveFileId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  const allowed =
    host === "drive.google.com" ||
    host === "docs.google.com" ||
    host.endsWith(".googleusercontent.com");
  if (!allowed) return null;

  for (const pattern of FILE_ID_PATTERNS) {
    const match = url.pathname.concat(url.search).match(pattern) || url.href.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function downloadDriveFile(rawUrl) {
  const fileId = extractDriveFileId(rawUrl);
  if (!fileId) {
    throw new Error("Resume URL is not a Google Drive file link.");
  }

  const startUrls = [
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`,
  ];

  let nextUrl = startUrls[0];
  let startIndex = 0;
  const seen = new Set();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (seen.has(nextUrl)) break;
    seen.add(nextUrl);

    const response = await fetch(nextUrl, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
    });

    if (!response.ok) {
      await cancelBody(response);
      if (startIndex < startUrls.length - 1) {
        startIndex += 1;
        nextUrl = startUrls[startIndex];
        continue;
      }
      throw new Error(`Google Drive returned ${response.status} while downloading the resume.`);
    }

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const disposition = response.headers.get("content-disposition") || "";
    const declaredLength = Number(response.headers.get("content-length"));
    const filename = filenameFromResponse(disposition, contentType, fileId);
    const resumeType = RESUME_EXTENSIONS.has(extensionOf(filename));

    if (isHtmlType(contentType) || (!isAttachment(disposition) && !resumeType)) {
      if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) {
        await cancelBody(response);
        throw new Error("That Drive file is not a resume document.");
      }
      const buffer = await readCapped(response, 2 * 1024 * 1024);
      if (!looksLikeHtml(buffer, contentType)) {
        await rejectUnlessResume(filename, buffer.byteLength);
        assertDocumentBytes(buffer, filename);
        const type = contentType && contentType !== "application/octet-stream" ? contentType : typeFromName(filename);
        return new File([buffer], filename, { type });
      }
      const redirect = redirectFromHtml(new TextDecoder().decode(buffer), fileId, startIndex, startUrls);
      if (redirect.error) throw redirect.error;
      startIndex = redirect.startIndex;
      nextUrl = redirect.nextUrl;
      continue;
    }

    try {
      assertResumeFile(filename, declaredLength);
    } catch (error) {
      await cancelBody(response);
      throw error;
    }

    const buffer = await readCapped(response, MAX_RESUME_BYTES);
    if (looksLikeHtml(buffer, "") || looksLikeHtml(buffer, contentType)) {
      const redirect = redirectFromHtml(new TextDecoder().decode(buffer), fileId, startIndex, startUrls);
      if (redirect.error) throw redirect.error;
      startIndex = redirect.startIndex;
      nextUrl = redirect.nextUrl;
      continue;
    }
    assertDocumentBytes(buffer, filename);
    const type = contentType && contentType !== "application/octet-stream" ? contentType : typeFromName(filename);
    return new File([buffer], filename, { type });
  }

  throw new Error("Could not download the resume from Google Drive.");
}

function isAttachment(disposition) {
  return /attachment/i.test(disposition) || /filename\*?=/i.test(disposition);
}

function isHtmlType(contentType) {
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function extensionOf(filename) {
  const match = String(filename).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : "";
}

function assertDocumentBytes(buffer, filename) {
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("Google Drive returned an empty resume.");
  }
  if (looksLikeHtml(buffer, "")) {
    throw new Error("Google Drive returned a web page instead of the resume. Share the file as anyone with the link.");
  }

  const bytes = new Uint8Array(buffer);
  const extension = extensionOf(filename);
  if (extension === ".pdf" && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    throw new Error("Google Drive did not return a PDF. Check that the link is a public resume file.");
  }
  if (extension === ".docx" && !startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new Error("Google Drive did not return a Word document.");
  }
  if (extension === ".doc" && !startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    throw new Error("Google Drive did not return a Word document.");
  }
}

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function assertResumeFile(filename, declaredLength) {
  if (!RESUME_EXTENSIONS.has(extensionOf(filename))) {
    throw new Error(
      filename
        ? `"${filename}" is not a resume. Use a public pdf, doc, docx, rtf, txt, or odt file.`
        : "The Drive file is not a resume document. Use a public pdf, doc, docx, rtf, txt, or odt file.",
    );
  }
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESUME_BYTES) {
    throw new Error("That file is larger than 25 MB, so it was not attached.");
  }
}

async function rejectUnlessResume(filename, size) {
  assertResumeFile(filename, size);
}

function redirectFromHtml(html, fileId, startIndex, startUrls) {
  if (/accounts\.google\.com|servicelogin|sign in\s*-\s*google accounts/i.test(html)) {
    return {
      error: new Error(
        "This Drive file is not publicly shared. Set sharing to “Anyone with the link”, then load again.",
      ),
    };
  }
  const follow = nextDownloadUrl(html, fileId);
  if (follow) return { nextUrl: follow, startIndex };
  if (startIndex < startUrls.length - 1) {
    return { nextUrl: startUrls[startIndex + 1], startIndex: startIndex + 1 };
  }
  return {
    error: new Error("Google Drive did not return a resume file. Check that the link is a file, not a folder."),
  };
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed.
  }
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    throw new Error("That file is larger than 25 MB, so it was not attached.");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("That file is larger than 25 MB, so it was not attached.");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("That file is larger than 25 MB, so it was not attached.");
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

function looksLikeHtml(buffer, contentType) {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) return true;
  const head = new TextDecoder().decode(buffer.slice(0, 240)).trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

function filenameFromResponse(disposition, contentType, fileId) {
  const named = filenameFromDisposition(disposition);
  if (named) return sanitizeFilename(named);
  const extension = EXTENSION_BY_TYPE[contentType] || "";
  if (!extension) return "";
  return `resume-${fileId}${extension}`;
}

function filenameFromDisposition(header) {
  if (!header) return "";
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]+)"/i) || header.match(/filename\s*=\s*([^;]+)/i);
  return plain ? plain[1].trim() : "";
}

function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || "resume";
}

function typeFromName(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return EXTENSION_BY_TYPE["application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".rtf")) return "application/rtf";
  return "application/octet-stream";
}

function nextDownloadUrl(html, fileId) {
  const form =
    html.match(/<form\b[^>]*\bid=["']download-form["'][^>]*>[\s\S]*?<\/form>/i) ||
    html.match(/<form\b[^>]*action=["'][^"']*download[^"']*["'][^>]*>[\s\S]*?<\/form>/i);

  if (form) {
    const block = form[0].replace(/&amp;/g, "&");
    const actionMatch = block.match(/action=["']([^"']+)["']/i);
    const action = actionMatch ? actionMatch[1] : "https://drive.usercontent.google.com/download";
    const params = new URLSearchParams();
    for (const tag of block.matchAll(/<input\b[^>]*>/gi)) {
      const name = tag[0].match(/\bname=["']([^"']+)["']/i);
      const value = tag[0].match(/\bvalue=["']([^"']*)["']/i);
      if (name) params.set(name[1], value ? value[1] : "");
    }
    if (!params.has("id")) params.set("id", fileId);
    if (!params.has("export")) params.set("export", "download");
    const joiner = action.includes("?") ? "&" : "?";
    return `${action}${joiner}${params.toString()}`;
  }

  const confirm = html.match(/confirm=([0-9A-Za-z_-]+)/);
  if (confirm) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${encodeURIComponent(confirm[1])}`;
  }
  return null;
}
