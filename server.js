const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 2369;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_EVENT_TYPE = process.env.GITHUB_EVENT_TYPE || "ghost-backup";
const GHOST_ADMIN_API_KEY = process.env.GHOST_ADMIN_API_KEY;
const GHOST_API_URL = process.env.GHOST_API_URL || "http://ghost:2368";

if (!GITHUB_TOKEN) {
  console.error("[relay] ERROR: GITHUB_TOKEN is required");
  process.exit(1);
}
if (!GITHUB_REPO) {
  console.error("[relay] ERROR: GITHUB_REPO is required");
  process.exit(1);
}
if (!GHOST_ADMIN_API_KEY) {
  console.error("[relay] ERROR: GHOST_ADMIN_API_KEY is required");
  process.exit(1);
}

function generateGhostJWT(adminApiKey) {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret)
    throw new Error("GHOST_ADMIN_API_KEY must be in format id:secret");
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", kid: id, typ: "JWT" }),
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" }),
  ).toString("base64url");
  const secretBytes = Buffer.from(secret, "hex");
  const sig = crypto
    .createHmac("sha256", secretBytes)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// Calls Ghost Admin API internally, rewriting any 301/302 redirect back to
// the internal host instead of following it to the public HTTPS URL.
function ghostRequest(path) {
  const internalBase = new URL(GHOST_API_URL);
  return new Promise((resolve, reject) => {
    const jwt = generateGhostJWT(GHOST_ADMIN_API_KEY);
    const options = {
      hostname: internalBase.hostname,
      port: Number(internalBase.port) || 2368,
      path,
      method: "GET",
      headers: {
        Authorization: `Ghost ${jwt}`,
        "Content-Type": "application/json",
      },
    };
    const req = http.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers["location"];
        if (!location)
          return reject(new Error("Redirect with no Location header"));
        const redirectUrl = new URL(location);
        // Follow the path only — keep using internal host, not the public URL
        const internalPath = redirectUrl.pathname + redirectUrl.search;
        console.log(
          `[relay] Rewriting redirect to internal path: ${internalPath}`,
        );
        return ghostRequest(internalPath).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error(
            `[relay] Ghost API status: ${res.statusCode}`,
            data.substring(0, 200),
          );
          return reject(new Error(`Ghost API error: ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error(
            "[relay] Parse error, raw response:",
            data.substring(0, 300),
          );
          reject(new Error("Failed to parse Ghost API response"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function fetchPost(postId) {
  return ghostRequest(
    `/ghost/api/admin/posts/${postId}/?formats=html&include=tags,authors`,
  ).then((data) => data.posts?.[0] || null);
}

function postToMarkdown(post) {
  const tags = (post.tags || []).map((t) => t.name);
  const authors = (post.authors || []).map((a) => a.name);
  const frontmatter = [
    "---",
    `id: ${post.id}`,
    `title: "${post.title?.replace(/"/g, '\\"')}"`,
    `slug: ${post.slug}`,
    `status: ${post.status}`,
    `published_at: ${post.published_at || "null"}`,
    `updated_at: ${post.updated_at || "null"}`,
    `authors: [${authors.map((a) => `"${a}"`).join(", ")}]`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    `feature_image: ${post.feature_image || "null"}`,
    `excerpt: "${(post.custom_excerpt || post.excerpt || "").replace(/"/g, '\\"')}"`,
    "---",
    "",
  ].join("\n");
  return frontmatter + (post.html || "");
}

function dispatchToGitHub(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      event_type: GITHUB_EVENT_TYPE,
      client_payload: payload,
    });
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/dispatches`,
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
          console.log(`[relay] ✅ Dispatched to GitHub (${GITHUB_REPO})`);
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
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", repo: GITHUB_REPO }));
    return;
  }
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
      const postMeta = ghostPayload.post?.current;
      if (!postMeta?.id) {
        console.warn("[relay] No post ID in webhook payload — skipping");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, skipped: true }));
        return;
      }
      console.log(
        `[relay] Webhook received for: "${postMeta.title}" (${postMeta.id})`,
      );

      const fullPost = await fetchPost(postMeta.id);
      if (!fullPost)
        throw new Error(`Post ${postMeta.id} not found in Ghost API`);

      const markdown = postToMarkdown(fullPost);
      const payload = {
        timestamp: new Date().toISOString(),
        event: ghostPayload.event || "unknown",
        post: {
          id: fullPost.id,
          title: fullPost.title,
          slug: fullPost.slug,
          status: fullPost.status,
          published_at: fullPost.published_at,
          tags: (fullPost.tags || []).map((t) => t.name),
        },
        content_b64: Buffer.from(markdown).toString("base64"),
      };

      await dispatchToGitHub(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("[relay] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Ghost → GitHub webhook relay running on port ${PORT}`);
  console.log(`[relay] Forwarding to repo: ${GITHUB_REPO}`);
  console.log(`[relay] Ghost API: ${GHOST_API_URL}`);
});
