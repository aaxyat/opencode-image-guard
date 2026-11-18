// image-guard — caps image parts per model request for providers with a low image limit.
//
// Why: Mistral's deepseek-v4-1-flash-1017 rejects any request carrying more than
// 20 images (HTTP 400, code 3051). OpenCode replays the whole session history on
// every turn, so a session that accumulates screenshots dies permanently.
//
// What: before each model request, keep the newest MAX_IMAGES image parts and
// replace older ones with a short text placeholder. Text and tool results are
// untouched; stored history is not modified.
//
// Applies only to the models listed in IMAGE_GUARD_MODELS.
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_IMAGES = Number.parseInt(process.env.OPENCODE_MAX_IMAGES ?? "15", 10) || 15
const MODELS = new Set(
  (process.env.IMAGE_GUARD_MODELS ?? "mistral/deepseek-v4-1-flash-1017")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
const LOG = join(homedir(), ".local", "share", "opencode", "log", "image-guard.log")

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
    if (!MODELS.has(key)) return

    const images = collectImages(event.messages)
    if (images.length <= MAX_IMAGES) return

    const drop = images.length - MAX_IMAGES
    for (let n = 0; n < drop; n++) {
      const { parts, index, part } = images[n]
      parts[index] = placeholder(part)
    }

    try {
      appendFileSync(
        LOG,
        `${new Date().toISOString()} session=${event.sessionID} model=${key} images=${images.length} dropped=${drop} kept=${MAX_IMAGES}\n`,
      )
    } catch {
      // logging is best-effort
    }
  }

  return Promise.all([
    ctx.session.hook("context", capImages, { providerID: "mistral" }),
    ctx.session.hook("compaction", capImages, { providerID: "mistral" }),
  ]).then(() => () => {})
}

export default {
  id: "image-guard",
  setup: setupV2,
  server: () => ({}),
}
