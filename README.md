# opencode-image-guard

An OpenCode plugin that caps **image count** per model request for providers with a low per-request image limit.

## The problem

Some provider/model pairs reject a request when it carries too many images. Mistral's `deepseek-v4-1-flash-1017` allows 20:

```
{"object":"error","message":"Total number of images exceeds the maximum allowed of 20.",
 "type":"invalid_request_invalid_args","code":"3051","raw_status_code":400}
```

OpenCode replays the entire session history on every turn. Screenshots from browser tools, `read` on PNGs, and attachments therefore accumulate in the history until the 21st image is reached — after which **every** request fails, including plain-text prompts. `/compact` cannot recover the session either, because the compaction request also carries the images.

Related upstream issues: `anomalyco/opencode#47721`, `#63287`, `#64187`.

## What this does

Before each model request, the plugin:

1. counts image parts across the assembled request — prompt attachments (`type: "media"`) and tool-result images (`type: "file"` with a `data:` URI, nested in `result.value`);
2. if there are more than `MAX_IMAGES`, keeps the **newest** `MAX_IMAGES` and replaces older ones with a short text placeholder naming the file;
3. leaves text, tool calls and tool results untouched.

Only the outgoing request is changed. Stored history is not modified, so session search, memory, and summaries still see the original content. This also makes an already-poisoned session usable again on its next prompt.

Unlike session compaction, this is not lossy: no summary is generated and no text is discarded.

## Install

Copy `image-guard.js` into your global plugins directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp image-guard.js ~/.config/opencode/plugins/
```

On Windows:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"
Copy-Item .\image-guard.js "$env:USERPROFILE\.config\opencode\plugins\"
```

OpenCode auto-loads files in that directory; no `opencode.json` entry is needed. Changes are hot-reloaded.

## Settings

Limits live in one JSON file, read by the plugin on every request and re-read whenever its mtime changes:

```
~/.config/opencode/image-guard.json
```

```json
{
  "version": 1,
  "models": {
    "mistral/deepseek-v4-1-flash-1017": 15,
    "mistral/*": 8
  }
}
```

Resolution order for a request to `provider/model`: exact `provider/model`, then `provider/*`, then `*`. A model with no match is not guarded. Editing the file applies to the next request, with no OpenCode restart.

### CLI

```bash
node bin/image-guard.mjs list
node bin/image-guard.mjs set mistral/deepseek-v4-1-flash-1017 15
node bin/image-guard.mjs set "mistral/*" 8
node bin/image-guard.mjs unset "mistral/*"
node bin/image-guard.mjs init      # write the default file
node bin/image-guard.mjs path      # print the config path
```

### GUI

The companion OpenChamber extension (**[openchamber-image-guard](https://github.com/aaxyat/openchamber-image-guard)**) adds a settings panel that edits the same file: add a model, change its limit, remove it, save. Changes apply to the running plugin immediately.

### Environment fallback

Used only when `image-guard.json` does not exist:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_MAX_IMAGES` | `15` | Cap applied to the models in `IMAGE_GUARD_MODELS`. |
| `IMAGE_GUARD_MODELS` | `mistral/deepseek-v4-1-flash-1017` | Comma-separated `provider/model` list. |

## Log

Each request that drops images appends one line to:

```
~/.local/share/opencode/log/image-guard.log
```

```
2026-11-18T06:44:56.925Z session=ses_… model=mistral/deepseek-v4-1-flash-1017 images=21 dropped=6 kept=15
```

## Verified

OpenCode `2.3.0`, model `mistral/deepseek-v4-1-flash-1017`:

| Scenario | Images in request | Dropped | Result |
| --- | --- | --- | --- |
| 21 file attachments, limit 15 | 21 | 6 | request accepted (before the plugin: HTTP 400 / code 3051) |
| 16 PNGs read via the `read` tool | 16 | 1 | request accepted |
| limit changed to 12 from the CLI, next request | 21 | 9 | accepted with no restart |
| ≤ limit | ≤ limit | 0 | untouched |

## Compatibility

- Uses the OpenCode 2.x plugin API (`session.hook("context")` and `session.hook("compaction")`). The V1 `server` export is a no-op, so a V1 host simply ignores the guard.
- Coexists with context-management plugins (e.g. `@cortexkit/opencode-magic-context`): those operate on persisted history, this only rewrites the outgoing request.
- Hook order is host-defined. If another plugin rebuilds image parts after the context stage, the cap can be undone; the log line is the canary.

## Limitations

- A dropped image can only be re-read if its file still exists; the placeholder carries the filename.
- The plugin does not raise the provider's limit, and does not compensate for other per-request limits (size, token budget).
- It does not prevent an image-heavy request from being *generated*; it only keeps the count under the cap.

## License

MIT — see [LICENSE](LICENSE).
