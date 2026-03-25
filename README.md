# ghost-webhook-relay

A tiny, zero-dependency Node.js Docker container that receives Ghost CMS webhooks, fetches the full post content via the Ghost Admin API, and forwards it to GitHub's repository dispatch API — triggering a GitHub Action to back up blog content as markdown files.

## Why this exists

Ghost webhooks cannot set custom HTTP headers. GitHub's `/dispatches` API requires an `Authorization` header with a Personal Access Token. This relay sits between the two, and also enriches the payload by fetching full post content (Ghost webhooks only include metadata).

```
Ghost (on publish/update)
  → POST http://webhook-relay.internal:2369
    → relay fetches full post via Ghost Admin API
      → GitHub API /dispatches
        → GitHub Action saves posts/{slug}.md to content repo
```

## Environment Variables

| Variable              | Required | Default             | Description                                                                             |
| --------------------- | -------- | ------------------- | --------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`        | ✅       | —                   | GitHub fine-grained PAT with `Actions: write` and `Contents: write` on the content repo |
| `GITHUB_REPO`         | ✅       | —                   | Target repo, e.g. `MajorAchilles/content-blog-amlanjs-in`                               |
| `GHOST_ADMIN_API_KEY` | ✅       | —                   | Ghost Admin API key in `id:secret` format — from Ghost Admin → Settings → Integrations  |
| `GHOST_API_URL`       | ❌       | `http://ghost:2368` | Internal URL to reach Ghost — use the Docker service name                               |
| `GITHUB_EVENT_TYPE`   | ❌       | `ghost-backup`      | The `event_type` sent to GitHub dispatch                                                |
| `PORT`                | ❌       | `2369`              | Port the relay listens on                                                               |

## Endpoints

| Method | Path      | Description                                                     |
| ------ | --------- | --------------------------------------------------------------- |
| `POST` | `/`       | Receives Ghost webhook, fetches full post, dispatches to GitHub |
| `GET`  | `/health` | Health check — returns `{"status":"ok","repo":"..."}`           |

## Usage in docker-compose (Portainer stack)

```yaml
webhook-relay:
  image: ghcr.io/YOUR_GITHUB_USERNAME/ghost-webhook-relay:latest
  restart: always
  environment:
    GITHUB_TOKEN: ${GITHUB_TOKEN}
    GITHUB_REPO: ${GITHUB_REPO}
    GHOST_ADMIN_API_KEY: ${GHOST_ADMIN_API_KEY}
    GHOST_API_URL: http://ghost:2368
  networks:
    ghost_net:
      aliases:
        - webhook-relay.internal
```

> **Important:** Do NOT expose ports to the host. Ghost reaches the relay via the internal Docker network.
>
> The `webhook-relay.internal` alias is required because Ghost's webhook URL validator rejects plain internal hostnames (like `webhook-relay`) that don't resemble a valid domain. The `.internal` suffix satisfies the validator while still resolving correctly via Docker DNS.

In Ghost Admin → Settings → Integrations → your integration → Add webhook, set the Target URL to:

```
http://webhook-relay.internal:2369
```

## Ghost Admin API Key

Get this from Ghost Admin → **Settings → Integrations → your integration**. It is shown as **Admin API key** and looks like:

```
69c3bd1418f3c50001626859:c4cdd49bc3878544fc94c9d38f47c797a2bd26d...
```

The format is `id:secret` — the relay uses this to generate a short-lived JWT for each Admin API call.

## How it works

1. Ghost fires a webhook on post create/update/publish
2. The relay receives the webhook payload (metadata only)
3. The relay generates a Ghost Admin JWT and fetches the full post (HTML + tags + authors) from `GHOST_API_URL`
4. The relay converts the post to a markdown file with YAML frontmatter
5. The markdown is base64-encoded and sent to GitHub's repository dispatch API
6. A GitHub Action in the content repo decodes it and saves `posts/{slug}.md`

### Handling Ghost's internal HTTP→HTTPS redirect

Ghost is configured with an `https://` public URL, so it issues a 301 redirect for any internal HTTP request. The relay handles this by intercepting the redirect and reissuing the request to the **same internal host** using the redirect's path — rather than following it to the public HTTPS URL, which would be unreachable from inside Docker.

The relay also sends `X-Forwarded-Proto: https` on internal requests, which tells Ghost the request is already secure and prevents the redirect loop entirely.

## GitHub Action (content repo)

The content repo needs `.github/workflows/receive-backup.yml`:

```yaml
name: Receive Ghost Content Backup

on:
  repository_dispatch:
    types: [ghost-backup]

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Write post markdown file
        run: |
          mkdir -p posts
          SLUG="${{ github.event.client_payload.post.slug }}"
          STATUS="${{ github.event.client_payload.post.status }}"
          echo "${{ github.event.client_payload.content_b64 }}" | base64 -d > "posts/${SLUG}.md"
          if [ "$STATUS" = "published" ]; then
            mkdir -p published
            echo "${{ github.event.client_payload.content_b64 }}" | base64 -d > "published/${SLUG}.md"
          else
            mkdir -p drafts
            echo "${{ github.event.client_payload.content_b64 }}" | base64 -d > "drafts/${SLUG}.md"
          fi

      - name: Update backup log
        run: |
          mkdir -p backup
          echo "${{ github.event.client_payload.timestamp }} — [${{ github.event.client_payload.event }}] — ${{ github.event.client_payload.post.status }} — ${{ github.event.client_payload.post.title }}" >> backup/backup-log.txt

      - name: Commit and push
        run: |
          git config user.name "Ghost Backup Bot"
          git config user.email "backup@amlanjs.in"
          git add -A
          git diff --staged --quiet || git commit -m "[${{ github.event.client_payload.event }}] ${{ github.event.client_payload.post.title }} (${{ github.event.client_payload.post.status }}) — $(date -u '+%Y-%m-%d')"
          git push
```

> Enable **Read and write permissions** under the content repo's **Settings → Actions → General → Workflow permissions** so the action can push commits.

## GitHub PAT permissions required

The fine-grained PAT needs the following on the content repo:

| Permission | Level           |
| ---------- | --------------- |
| Actions    | Read and write  |
| Contents   | Read and write  |
| Metadata   | Read (required) |

## Building locally

```bash
docker build -t ghost-webhook-relay .
docker run --rm \
  -e GITHUB_TOKEN=your_pat \
  -e GITHUB_REPO=youruser/content-repo \
  -e GHOST_ADMIN_API_KEY=id:secret \
  -e GHOST_API_URL=http://localhost:2368 \
  -p 2369:2369 \
  ghost-webhook-relay
```

## Auto-publish to GitHub Container Registry

Push to `main` or `master` and the included GitHub Action (`.github/workflows/docker-publish.yml`) automatically builds and pushes the image to:

```
ghcr.io/YOUR_GITHUB_USERNAME/ghost-webhook-relay:latest
```

No manual tagging or pushing needed.

## Zero dependencies

Uses only Node.js built-ins (`http`, `https`, `crypto`). No `package.json` needed. The image is minimal — based on `node:20-alpine` and runs as a non-root user.
