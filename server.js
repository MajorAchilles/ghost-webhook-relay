const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 2369;
const GITHUB_TOKEN = process.env.PAT_GITHUB;
const REPO_NAME = process.env.REPO_NAME; // e.g. "MajorAchilles/content-blog-amlanjs-in"
const GITHUB_EVENT_TYPE = process.env.GITHUB_EVENT_TYPE || "ghost-backup";

if (!GITHUB_TOKEN) {
  console.error("[relay] ERROR: PAT_GITHUB environment variable is required");
  process.exit(1);
}
if (!REPO_NAME) {
  console.error("[relay] ERROR: REPO_NAME environment variable is required");
  process.exit(1);
}

function dispatchToGitHub(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      event_type: GITHUB_EVENT_TYPE,
      client_payload: payload,
    });

    const options = {
      hostname: "api.github.com",
      path: `/repos/${REPO_NAME}/dispatches`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "ghost-webhook-relay/1.0",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 204) {
          console.log(
            `[relay] ✅ Dispatched to GitHub (${REPO_NAME}) — event: ${GITHUB_EVENT_TYPE}`,
          );
          resolve();
        } else {
          console.error(
            `[relay] ❌ GitHub returned ${res.statusCode}: ${data}`,
          );
          reject(new Error(`GitHub API error: ${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", repo: REPO_NAME }));
    return;
  }

  // Accept any POST to /
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const ghostPayload = body ? JSON.parse(body) : {};
      const payload = {
        timestamp: new Date().toISOString(),
        event: ghostPayload.event || "unknown",
        post: ghostPayload.post?.current
          ? {
              id: ghostPayload.post.current.id,
              title: ghostPayload.post.current.title,
              slug: ghostPayload.post.current.slug,
              status: ghostPayload.post.current.status,
              published_at: ghostPayload.post.current.published_at,
            }
          : null,
      };

      await dispatchToGitHub(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("[relay] Error processing webhook:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Ghost → GitHub webhook relay running on port ${PORT}`);
  console.log(`[relay] Forwarding to repo: ${REPO_NAME}`);
  console.log(`[relay] Event type: ${GITHUB_EVENT_TYPE}`);
});
