# Harness visualization

Stage demo for **From Chatbots to Agents**, 27 November 2026. It shows what the software around a model does.

## Present the demo

Open [dist/harness-replay.html](dist/harness-replay.html) in a browser. Click a stage or use the left and right arrows. Each stage loads its own recording in Step mode. Press Space or **Next step** to advance. Space also finishes an answer that is still streaming. Use **E** for Present or Explain and **R** for Simple or Raw. Turn off Step mode for continuous playback, or turn on Slow motion for longer pauses.

The replay file needs no server and makes no model calls. Run `node build-static.mjs` after changing the page or recordings.

## Stages and recordings

| Stage | What to show | Recording |
| --- | --- | --- |
| 1. Model | Send one question. Watch the model write its answer. | `1-model.jsonl` |
| 2. Chat | Add a question to the messages list. Send the list to the model. Ask a follow-up and see what the next call receives. | `2-chat.jsonl` |
| 3. Tools | The model makes one tool call to run the prepared checker. The result goes into the messages list. The model answers from that result. | `3-tools.jsonl` |
| 4. Loop | The model writes a checker, reads it back and runs it. Follow the return arrow and call count after each result. A reply without a tool call ends the loop. | `4-loop.jsonl` |
| 5. Harness | Watch the permission checks. Then watch the list grow, shrink to a summary plus the latest reply, and answer a follow-up. | `5-harness.jsonl` |

Stages 1–2 share a fixed top row. Stages 3–5 share a fixed full diagram. The boxes keep their positions within each layout. A stage reveals new parts in place and marks them **NEW** before the run. In Stage 3 the return arrow is thin and dashed. In Stage 4 it becomes solid and says **next model call**. Stage 5 adds the harness frame, permission box and size bar. Gold marks the current step and its arrows.

Each chat question has four steps. **Question → Model call → Reply streams → Done.** Each tool adds four steps before the next model call. **Tool call → Start the tool → Tool runs → Result added.** Stage 5 labels the second step **Check permission**. The model may also write text between calls. Click a block in the messages list to inspect it.

Stages 1 and 2 run no checker. Stage 3 runs a prepared checker with one bash call, `node goldbach.cjs`. In Stages 4 and 5 the model writes its own checker during the run. Stages 3–5 each check all 498 even integers from 4 through 998 and find no counterexamples. This checks only that range. Goldbach's conjecture covers every even integer greater than 2.

## Compaction in Stage 5

1. The size bar counts characters in message text, tool arguments and summaries. Separate instructions and tool definitions are outside the count.
2. When an answer finishes and the list exceeds 1,200 characters, the harness asks Pi to compact it. A line marks the small demo limit.
3. Pi asks the model to summarize the older messages. The app reads back Pi's new messages list. The **Summary** block appears and the bar drops. Click **Summary** to read it.
4. The follow-up asks how many numbers the script checked and which primes it found for 998. The model receives the summary and answers **498**, **7** and **991** without using tools again.

The threshold is set for the demo. Pi normally bases automatic compaction on the model's input limit. Here the harness calls Pi's `compact` RPC command. A setting in the session folder keeps a small amount of recent material. Raw view shows Pi's `compaction_start` and `compaction_end` events and the messages read back with `get_messages`.

## Run live

From this folder run `node server.mjs` and open **http://localhost:4173**. If that port is in use, set `PORT` to a free port, such as 4191. Choose **New live session** or type a question and press **Send**. Stage changes load the next recording. Start a new live session in the stage where you want to work. Step mode pauses the display only. **Stop** stops the Pi process owned by this server.

Live mode needs Node 22.18 or later and an authenticated Pi install. The recordings were made with Pi **v0.84.2** and `openai-codex/gpt-6.1-sol:low`. Set `PI_MODEL` to change the model. The server uses `pi` on PATH by default. Set `PI_BIN` and, if needed, `PI_ENTRY` to select a particular install. For a Bun install on Windows, use the following.

```powershell
$env:PORT = '4191'
$env:PI_BIN = Join-Path $env:USERPROFILE '.bun/bin/bun.exe'
$env:PI_ENTRY = Join-Path $env:USERPROFILE '.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
node server.mjs
```

The server starts Pi in RPC mode in a fresh folder under `sandbox/`. In Stage 3 the server copies `sandbox/primes.cjs` into that folder as `goldbach.cjs` before Pi starts. In Stages 4 and 5 the model writes `goldbach.cjs`. The demo uses the existing Pi login and leaves its global settings alone.

Stages 1–2 run with tools off. Stage 3 enables **bash** only. Stages 4 and 5 enable **read**, **write** and **bash**. The local observer accepts reads and writes only for `goldbach.cjs` in that session folder. It accepts exactly `node goldbach.cjs` as a shell request. The harness launches Node with file permission checks, a short timeout and a reduced environment. Use trusted prompts for this local demo. The session folder provides scratch space and cannot isolate an untrusted program from the operating system.

## Inspect and verify

Raw view shows step events, the last request sent to the model, the messages list, tool inputs and results, and reported token usage. Stages 1–4 omit the word “harness” from the display so it can be introduced in Stage 5. Live sessions write to `recordings/sessions/`. The replay menu loads the curated files in `recordings/`. The static build removes local paths, credential fields, cache keys and opaque reasoning signatures. Keep private data out of live prompts and recordings.

Run `node --test test.mjs` for the local protocol and permission checks. Run `node check-static.mjs` with Edge installed to check the standalone file in headless mode. It uses its own Edge process and a profile under `recordings/sessions/`.
