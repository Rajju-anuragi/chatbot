const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGES = 20;
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const FALLBACK_GEMINI_MODEL = "gemini-3.6-flash";

function loadEnvironment() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function getOutputText(result) {
  if (typeof result.output_text === "string") return result.output_text;
  if (!Array.isArray(result.steps)) return "";

  return result.steps
    .filter((step) => step && step.type === "model_output" && Array.isArray(step.content))
    .flatMap((step) => step.content)
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request must contain valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

async function handleChat(request, response) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 503, {
      error: "Gemini API key is missing. Add GEMINI_API_KEY to the .env file and restart the server.",
    });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    if (!response.destroyed) sendJson(response, error.status || 400, { error: error.message });
    return;
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    sendJson(response, 400, { error: "Send at least one chat message." });
    return;
  }

  const messages = body.messages.slice(-MAX_MESSAGES);
  if (messages.some((message) =>
    !message ||
    !["user", "assistant"].includes(message.role) ||
    typeof message.text !== "string" ||
    !message.text.trim() ||
    message.text.length > 16000
  )) {
    sendJson(response, 400, { error: "One or more chat messages are invalid or too long." });
    return;
  }

  const prompt = messages.map((message) =>
    (message.role === "assistant" ? "Assistant" : "User") + ": " + message.text.trim()
  ).join("\n\n") + "\n\nAssistant:";

  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const models = model === FALLBACK_GEMINI_MODEL
      ? [model]
      : [model, FALLBACK_GEMINI_MODEL];

    for (let index = 0; index < models.length; index += 1) {
      const apiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: models[index],
          input: prompt,
          system_instruction: "You are a helpful multilingual assistant. Reply in the language used by the user unless asked otherwise. Be clear, accurate, and concise.",
          generation_config: { thinking_level: "low" },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const result = await apiResponse.json().catch(() => ({}));

      if (!apiResponse.ok) {
        if (apiResponse.status === 503 && index < models.length - 1) {
          console.warn(`Gemini model ${models[index]} is unavailable; trying ${FALLBACK_GEMINI_MODEL}.`);
          continue;
        }
        const message = result.error && result.error.message
          ? result.error.message
          : `The Gemini API could not answer this request (HTTP ${apiResponse.status}).`;
        sendJson(response, 502, { error: message });
        return;
      }

      const reply = getOutputText(result);
      if (!reply.trim()) {
        console.error("Gemini returned no text output.");
        sendJson(response, 502, { error: "Gemini returned an empty reply. Please try again." });
        return;
      }

      sendJson(response, 200, { reply: reply.trim() });
      return;
    }
  } catch (error) {
    console.error("Gemini request failed.", error);
    const message = error.name === "TimeoutError"
      ? "Gemini did not respond within 45 seconds. The service may be overloaded; please try again."
      : "Could not reach Gemini. Check your internet connection and try again.";
    sendJson(response, 502, { error: message });
  }
}

function serveFile(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname !== "/" && pathname !== "/index.html") {
    response.writeHead(404).end("File not found");
    return;
  }
  const filePath = path.join(ROOT, "index.html");

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end("File not found");
      return;
    }
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else response.end(contents);
  });
}

loadEnvironment();

const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/chat") {
    void handleChat(request, response);
    return;
  }
  if ((request.method === "GET" || request.method === "HEAD") && !request.url.startsWith("/api/")) {
    serveFile(request, response);
    return;
  }
  response.writeHead(404).end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Chat is running at http://localhost:${PORT}`);
});
