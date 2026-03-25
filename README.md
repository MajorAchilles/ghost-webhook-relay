# ghost-webhook-relay

A tiny, zero-dependency Node.js Docker container that receives Ghost CMS webhooks and forwards them to GitHub's repository dispatch API — triggering a GitHub Action to back up blog content.

## Why this exists

Ghost webhooks cannot set custom HTTP headers. GitHub's `/dispatches` API requires an `Authorization` header with a Personal Access Token. This relay sits between the two.

```
Ghost (on publish) → POST http://webhook-relay:2369 → GitHub API /dispatches → GitHub Action runs
```

## Environment Variables

| Variable            | Required | Default        | Description                                               |
| ------------------- | -------- | -------------- | --------------------------------------------------------- |
| `GITHUB_TOKEN`      | ✅       | —              | GitHub PAT with `Contents: write` on the target repo      |
| `GITHUB_REPO`       | ✅       | —              | Target repo, e.g. `MajorAchilles/content-blog-amlanjs-in` |
| `GITHUB_EVENT_TYPE` | ❌       | `ghost-backup` | The `event_type` sent to GitHub dispatch                  |
| `PORT`              | ❌       | `2369`         | Port the relay listens on                                 |

## Endpoints

| Method | Path      | Description                                           |
| ------ | --------- | ----------------------------------------------------- |
| `POST` | `/`       | Receives Ghost webhook, dispatches to GitHub          |
| `GET`  | `/health` | Health check — returns `{"status":"ok","repo":"..."}` |

## Usage in docker-compose (Portainer stack)

```yaml
webhook-relay:
  image: ghcr.io/MajorAchilles/ghost-webhook-relay:latest
  restart: always
  environment:
    GITHUB_TOKEN: ${GITHUB_TOKEN}
    GITHUB_REPO: ${GITHUB_REPO}
  networks:
    - ghost_net
```

> Do NOT expose ports to the host. Ghost reaches the relay via the internal Docker network using the service name `webhook-relay`.

In Ghost Admin, set the webhook URL to:

```
http://webhook-relay:2369
```

## Building locally

```bash
docker build -t ghost-webhook-relay .
docker run --rm \
  -e GITHUB_TOKEN=your_pat \
  -e GITHUB_REPO=MajorAchilles/content-blog-amlanjs-in \
  -p 2369:2369 \
  ghost-webhook-relay
```

## Publishing to GitHub Container Registry

```bash
# Tag
docker tag ghost-webhook-relay ghcr.io/MajorAchilles/ghost-webhook-relay:latest

# Push
echo $GITHUB_PAT | docker login ghcr.io -u MajorAchilles --password-stdin
docker push ghcr.io/MajorAchilles/ghost-webhook-relay:latest
```

## Zero dependencies

Uses only Node.js built-ins (`http`, `https`). No `package.json` needed. The image is minimal — based on `node:20-alpine`.
