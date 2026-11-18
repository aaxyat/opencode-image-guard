// image-guard — caps image parts per model request for providers with a low image limit.
//
// Why: Mistral's deepseek-v4-1-flash-1017 rejects any request carrying more than
// 20 images (HTTP 400, code 3051). OpenCode replays the whole session history on
// every turn, so a session that accumulates screenshots dies permanently.
//
// What: before each model request, keep the newest N image parts and replace
// older ones with a short text placeholder. Text and tool results are untouched;
// stored history is not modified.
//
// Limits come from ~/.config/opencode/image-guard.json (watched by mtime), with
// environment variables as a fallback when that file does not exist:
//
//   {
//     "version": 1,
//     "models": {
//       "mistral/deepseek-v4-1-flash-1017": 15,
//       "mistral/*": 8
//     }
//   }
//
// Exact model first, then "provider/*", then "*". A model with no match is not
// guarded.
import { appendFileSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG = join(homedir(), ".config", "opencode", "image-guard.json")
const LOG = join(homedir(), ".local", "share", "opencode", "log", "image-guard.log")

const ENV_CAP = Number.parseInt(process.env.OPENCODE_MAX_IMAGES ?? "15", 10) || 15
const ENV_MODELS = (process.env.IMAGE_GUARD_MODELS ?? "mistral/deepseek-v4-1-flash-1017")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

function fallbackConfig() {
  const models = {}
  for (const model of ENV_MODELS) models[model] = ENV_CAP
  return { version: 1, models }
}

let cached = { mtime: -1, config: null }

function loadConfig() {
  try {
    const mtime = statSync(CONFIG).mtimeMs
    if (mtime === cached.mtime) return cached.config
    const config = JSON.parse(readFileSync(CONFIG, "utf8"))
    cached = { mtime, config }
    return config
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try {
        appendFileSync(LOG, `${new Date().toISOString()} config-error ${error?.message ?? error}\n`)
      } catch {}
    }
    return null
  }
}

function capFor(config, key) {
  const models = config?.models
  if (!models || typeof models !== "object") return null
  const provider = key.split("/")[0]
  for (const candidate of [key, `${provider}/*`, "*"]) {
    const raw = models[candidate]
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

// Prompt attachments arrive as `media` parts, tool results as `file` parts whose
// uri is a data: URL, and some provider paths use a plain `image` part.
function isImagePart(part) {
  if (!part || typeof part !== "object") return false
  if (part.type === "media") {
    const mime = String(part.media?.mediaType ?? "")
    return mime.startsWith("image/") || part.media?.kind === "image"
  }
  if (part.type === "file") {
    const mime = String(part.mime ?? part.mediaType ?? "")
    return mime.startsWith("image/") || String(part.uri ?? "").startsWith("data:image/")
  }
  return part.type === "image"
}

// Image parts sit either at the top level of a message's content or inside a
// tool-result's `result.value` content array.
function collectImages(messages) {
  const found = []
  const walk = (parts) => {
    if (!Array.isArray(parts)) return
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part || typeof part !== "object") continue
      if (isImagePart(part)) {
        found.push({ parts, index: i, part })
        continue
      }
      if (part.type === "tool-result" && Array.isArray(part.result?.value)) walk(part.result.value)
    }
  }
  for (const message of messages) {
    if (Array.isArray(message.content)) walk(message.content)
  }
  return found
}

function placeholder(part) {
  const name = part.filename || part.name || part.media?.info?.filename || "image"
  return {
    type: "text",
    text: `[image omitted to stay under the provider's image limit: ${name}. Re-read the file if you need to see it again.]`,
  }
}

function setupV2(ctx) {
  const capImages = (event) => {
    const key = `${event.model.providerID}/${event.model.id}`
    const config = loadConfig() ?? fallbackConfig()
    const max = capFor(config, key)
    if (!max) return

    const images = collectImages(event.messages)
    if (images.length <= max) return

    const drop = images.length - max
    for (let n = 0; n < drop; n++) {
      const { parts, index, part } = images[n]
      parts[index] = placeholder(part)
    }

    try {
      appendFileSync(
        LOG,
        `${new Date().toISOString()} session=${event.sessionID} model=${key} images=${images.length} dropped=${drop} cap=${max}\n`,
      )
    } catch {
      // logging is best-effort
    }
  }

  return Promise.all([
    ctx.session.hook("context", capImages),
    ctx.session.hook("compaction", capImages),
  ]).then(() => () => {})
}

export default {
  id: "image-guard",
  setup: setupV2,
  server: () => ({}),
}
