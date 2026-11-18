#!/usr/bin/env node
// image-guard settings CLI — edits the same config file the plugin reads.
//
//   node bin/image-guard.mjs list
//   node bin/image-guard.mjs set mistral/deepseek-v4-1-flash-1017 15
//   node bin/image-guard.mjs set "mistral/*" 8
//   node bin/image-guard.mjs unset "mistral/*"
//   node bin/image-guard.mjs path
//   node bin/image-guard.mjs init
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const CONFIG = join(homedir(), ".config", "opencode", "image-guard.json")
const DEFAULT_MODEL = "mistral/deepseek-v4-1-flash-1017"

function load() {
  if (!existsSync(CONFIG)) return { version: 1, models: {} }
  const parsed = JSON.parse(readFileSync(CONFIG, "utf8"))
  if (!parsed.models || typeof parsed.models !== "object") parsed.models = {}
  parsed.version ??= 1
  return parsed
}

function save(config) {
  mkdirSync(dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function parseCap(raw) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0 || n > 1000) {
    console.error(`Invalid limit "${raw}": expected an integer between 1 and 1000.`)
    process.exit(2)
  }
  return n
}

function parseModel(raw) {
  if (!raw || !raw.includes("/") || raw.startsWith("/") || raw.endsWith("/")) {
    console.error(`Invalid model "${raw ?? ""}": expected provider/model (for example ${DEFAULT_MODEL}).`)
    process.exit(2)
  }
  return raw
}

const [command, ...args] = process.argv.slice(2)
const config = command === "init" ? { version: 1, models: {} } : load()

switch (command) {
  case "list": {
    const entries = Object.entries(config.models)
    if (entries.length === 0) {
      console.log(`No model limits set. Config: ${CONFIG}`)
      break
    }
    const width = Math.max(...entries.map(([model]) => model.length), 5)
    for (const [model, cap] of entries) console.log(`${model.padEnd(width)}  ${cap}`)
    break
  }
  case "set": {
    const model = parseModel(args[0])
    const cap = parseCap(args[1])
    config.models[model] = cap
    save(config)
    console.log(`Set ${model} -> ${cap} images`)
    break
  }
  case "unset": {
    const model = parseModel(args[0])
    if (!(model in config.models)) {
      console.error(`No limit set for ${model}`)
      process.exit(1)
    }
    delete config.models[model]
    save(config)
    console.log(`Removed ${model}`)
    break
  }
  case "init": {
    if (!config.models[DEFAULT_MODEL]) config.models[DEFAULT_MODEL] = 15
    save(config)
    console.log(`Wrote ${CONFIG}`)
    break
  }
  case "path": {
    console.log(CONFIG)
    break
  }
  default: {
    console.error("Usage: image-guard <list|set|unset|init|path> [model] [limit]")
    process.exit(2)
  }
}
