# Skyline launch kit

Everything needed to launch Skyline: social threads, Show HN, Reddit posts, a 20-second demo shot list and press copy. Replace `[LINK]` with the release page before posting.

The founding story, used across the kit: the app was built overnight by six AI agents, and Skyline watched them build it.

---

## 1. X / Twitter threads

Five drafts. Each post is under 280 characters. Post the first one by default and keep the others for follow-ups or A/B testing. Attach the 20-second demo to post 1. Drafts D and E are the share loop: they point at the Snapshot (S) and Flyover (Shift+S) that Skyline saves for a user to repost.

### Draft A: the story (default)

1/
Six AI coding agents built an app overnight.
Then the app watched them do it.

Meet Skyline: a 3D city of your repo, where every AI agent is a drone that builds it live. Free, open source, 100% local.

2/
Every file is a building. Every folder is a district.

When Claude Code or Codex edits a file, a drone flies to it. The building pulses and sprouts scaffolding while the work happens.

3/
See what each agent costs while it runs.

Input, output and cache tokens, priced per model, live in the agent dock. Subagents nest under the session that spawned them.

4/
Scrub back through the last hour to replay what the agents did.

Or scrub git history from the first commit to HEAD and watch the city grow.

5/
Click any building for the Inspector: who touched it, what it imports, and an Explain button.

Explain runs a local model on your machine. Skyline sends nothing anywhere.

6/
Windows x64, MIT licensed.

Built overnight by a swarm of AI agents. Skyline watched them build it.

Download and source: [LINK]

### Draft B: the visual

1/
Three coding agents, one repo, one city.

[attach the 20-second demo]

Each tower is a file. Each glowing drone is an agent working on it.

2/
Taller building = more lines of code.
Color = language.
Drones fly to the file each agent is touching right now.

3/
Edits from agents that Skyline can't identify (Cursor, you, anything else) show up as "Unattributed", so nothing happens in the dark.

4/
It runs on Windows and reads the session logs that Claude Code and Codex already write. No account, no cloud, no telemetry.

5/
Free, open source (MIT).

Download, source and roadmap: [LINK]

### Draft C: the privacy angle

1/
Claude Code and Codex already write detailed logs of everything your agents do, to your own disk.

I wanted to watch them live without sending a byte anywhere. So I built Skyline.

2/
It reads ~/.claude/projects and ~/.codex/sessions and draws your repo as a 3D city. Agents are drones. Files are buildings.

3/
Tokens and cost per agent, live. Subagents, nested. Replay the last hour. Scrub git history from the first commit.

4/
Digests and explanations come from a local model (Qwen2.5-Coder 1.5B, one optional download). If you skip it, a deterministic fallback still works.

5/
MIT licensed, Windows x64, 100% local. Built overnight by six AI agents, and Skyline watched them do it.

[LINK]

### Draft D: the share loop, snapshot (attach docs/screenshots/snapshot-card.png)

Skyline watched the AI agents that built it.

Press S and it saves a branded city card of your repo, with agents, edits, files and cost. It is copied to your clipboard, ready to paste.

Free and open source: [LINK]

### Draft E: the share loop, flyover (attach the 10-second flyover WebM)

Shift+S records a 10-second flyover of your repo as a city, while your agents are still editing it.

Each drone is an agent. Each pulse is a file being changed.

100% local, MIT licensed: [LINK]

Draft E needs a flyover recorded from the app. The repo does not have one yet.

---

## 2. Show HN

**Title (79 characters):**

Show HN: Skyline – See your AI coding agents as a live 3D city

**First comment (post immediately after submitting):**

Hi HN, I'm one of the authors. Skyline is a Windows desktop app that draws a repo as a 3D city and shows Claude Code, Codex CLI and their subagents as drones that fly to the files they edit.

How it works: it tails the JSONL transcripts that Claude Code writes to ~/.claude/projects and Codex writes to ~/.codex/sessions. It does not send anything anywhere. The only network request is an optional download of a local model (Qwen2.5-Coder 1.5B, about 1.1 GB, from Hugging Face, run with node-llama-cpp). Every LLM feature has a deterministic fallback when the model is not installed.

A few things I would especially like feedback on:

- Cost is an estimate from a model price table in src/shared/pricing.ts. If you are on a subscription plan, the dollar figures are API-equivalent estimates, not your bill. If a number looks wrong, tell me.
- Edits from anything Skyline cannot attribute show up as "Unattributed". That is how Cursor and manual edits look today, since I do not parse Cursor sessions yet.
- The 1.5B model is small. Digests and explanations are useful but basic, and I am looking for better small models for summarizing agent transcripts.

Limits right now: Windows x64 only, unsigned builds (SmartScreen will warn), and Claude Code and Codex are the only agent sources.

The story behind it: the app was built overnight by six AI agents, and Skyline watched them build it. The source is MIT licensed, and every parser lives in `src/main/agents` if you want to check what it reads.

---

## 3. Reddit

### r/ClaudeAI

**Title:** I built a free app that shows your Claude Code agents, and their subagents, working as a 3D city

**Body:**

I kept running three or four Claude Code sessions at once and had no idea which one was touching which file, or what it was costing. So I built Skyline. Point it at a repo and it becomes a city: each file is a building, and each Claude Code session or subagent is a drone that flies to the file it is working on.

What it does with Claude Code:

- Reads your transcripts in ~/.claude/projects. Read-only, nothing uploaded.
- Shows subagents nested under the session that spawned them.
- Live tokens and cost per agent. Cost is an estimate from a price table in one file, and it is API-equivalent, so it is not what a subscription plan bills you.
- Replay: scrub back through what the agents did in the last hour.
- Dispatch: start a Claude Code run from the app, optionally in its own git worktree so it cannot collide with your edits.

It is free and MIT licensed. Windows x64 for now.

Download and source: [LINK]

I would most like to hear where the picture is wrong. If an agent shows as idle when it is working, or the cost looks off, please tell me.

### r/LocalLLaMA

**Title:** Skyline, a local-first app for watching coding agents. Digests come from Qwen2.5-Coder 1.5B via node-llama-cpp, with a heuristic fallback

**Body:**

Skyline renders a repo as a 3D city and shows Claude Code and Codex CLI sessions as drones. I wanted a summary of what the agents did while I was away, without sending the transcripts to anyone, so the digest runs on a local model.

The local model details:

- Qwen2.5-Coder-1.5B-Instruct, Q4_K_M GGUF, pulled from Hugging Face on demand (about 1.1 GB). Nothing is downloaded unless you click the button.
- Loaded lazily, on the first digest or explanation. One shared context of 4096 tokens, one request at a time.
- Prompts are budgeted at about 3 characters per token and compacted from the event log. The totals line (tokens, cost, files, commands) is computed in code, so the model only writes the narrative.
- Temperature 0.3, with a repeat penalty to stop the 1.5B model looping on list items.
- If the model has not answered within 20 seconds, you get the heuristic digest straight away, and the model's version arrives later as an update.
- A full-size digest takes a couple of minutes on a 4-core CPU, which is why the heuristic exists.

Stack: Electron, React, three.js, node-llama-cpp 3. The Windows package includes CPU and Vulkan prebuilds.

What I would like from this sub: suggestions for small models that summarize agent transcripts well, and prompt ideas that keep a 1.5B model from hallucinating file names. The code is MIT: [LINK]

---

## 4. Demo video: 20-second shot list

**Format:** 1920 × 1080, 60 fps, screen capture of a real session on the demo repo (or the Skyline repo itself), no cuts within a shot. Captions in the lower third. Music optional.

**Setup before recording:** Open the demo city ("Try the demo city") or a repo with three agents running. Close other windows. Set the window to 1600 × 900 or larger so the HUD has room. Hide the desktop. Start at the city view, not framed on a building. Do not wait for the 25-second idle auto-orbit; it will not fire in a 20-second clip.

| Time | Scene | Camera and input | On-screen caption |
|---|---|---|---|
| 0:00–0:03 | Cold open on the night city | Intro swoop from high above, descending onto the city. No input. | "Your repo, as a city." |
| 0:03–0:06 | Drones at work | Slow drag to orbit the city a few degrees (damped orbit). Drones are mid-flight, buildings pulsing. | "Every agent is a drone." |
| 0:06–0:09 | Select a building | Click an active, glowing tower. Camera flies to it (fly-to). The Inspector slides in from the right. | "Click any file." |
| 0:09–0:11 | Import arcs | Press `I`. Cyan arcs out, magenta arcs in. Hold. | "Imports, drawn as arcs." |
| 0:11–0:13 | Dock | Hard cut to the left dock. Cursor hovers the Claude card, then the nested subagent card. Tokens and $ visible. | "Tokens and cost, per agent." |
| 0:13–0:16 | Time-lapse | Press `3`, then `Space`. City grows from the first commit, buildings rising in order. | "Watch the city grow from the first commit." |
| 0:16–0:18 | Dispatch | Press `Ctrl` + `K`, type "dispatch", press `Enter`. Dispatch sheet appears with "Isolated worktree" on. | "Launch an agent in its own worktree." |
| 0:18–0:20 | End card | Hold the city, dimmed, with the logo and the line below. | "Skyline. Free. Open source. 100% local." |

**Notes for the editor:**

- Keep the camera moves slow and damped. Do not cut during the intro swoop or the fly-to; those are the shots that sell the 3D.
- Use `Space` once only, so the viewer sees the motion start.
- For a vertical cut (9:16) for short-form platforms, frame on the drone activity in shot 2 and the Inspector in shot 3.

---

## Epic City v2 launch angle

The v2 city (real Kenney models, lit windows, traffic, drone FX, a Director camera) gives a second story: the city films itself. Use it as a follow-up to Draft A, or as the lead for the Director-cam video. Attach `epic-overview.png` or `epic-night-reveal.png` from `docs/screenshots/`.

### Tweet draft V2-1: the visual

Your repo, as a city of real 3D buildings.

Windows light up. Cars drive the streets. Every agent is a drone that flies to the file it edits, with cost popping up as it works.

Press V and the Director camera films it for you.

Skyline is free and 100% local. [LINK]

### Tweet draft V2-2: the hook

Put a camera operator on your codebase.

Skyline's Director camera cuts between reveal, follow, crane and flythrough shots while your agents build the city below. Hands off the mouse, it still gets the shot.

Free, open source, 100% local. [LINK]

### 20-second shot list: Director-cam flyover

**Setup:** open a repo with at least two agents running (or the demo city), wait until the city has been busy for a minute, then press `V`. Reduced motion must be off, or the Director does not run. Keep hands off the mouse and keyboard: the Director runs only after 3 seconds without camera input, and steps aside while you touch the camera. The Director picks its own shots, weighted by what is happening, and holds each for 6 to 12 seconds, so a 20-second clip holds two or three cuts. Do a dry run first, and keep the take whose cuts land on the action. Record at 1920 × 1080, 60 fps, with captions in the lower third as in the demo video.

| Time | Shot kind | Camera | On-screen caption |
|---|---|---|---|
| 0:00–0:05 | Reveal | Opens on the framed city from altitude and descends slowly over the districts. | "Your repo, as a city." |
| 0:05–0:11 | Follow | Tracks one drone as it flies to a file under edit. Cost popups rise from it, and the building under it pulses. | "Every agent is a drone." |
| 0:11–0:16 | Crane | Rises past a construction site with a tower crane and welding sparks, then settles. | "Edits build in real time." |
| 0:16–0:20 | Flythrough or Orbit | Skims between two drones along the streets, with traffic streaks and lamps, then holds on the skyline under the aurora. | "Skyline. Free. Open source. 100% local." |

If a shot kind does not come up in the take (crane and follow need active edits, and flythrough needs two agents), keep the take that has the most motion and put the caption on the next cut.

---

## 5. Press kit

### 50 words

Skyline is a free, open-source, 100% local Windows app that turns your repository into a living 3D city. Claude Code and Codex agents appear as drones flying to the files they edit, with live tokens and cost per agent. Replay agent activity, or scrub git history from the first commit.

### 150 words

Skyline is mission control for AI coding agents, rendered as a living city. Point it at a repository and every file becomes a building and every folder a district. Claude Code and its subagents, and Codex CLI, appear as glowing drones that fly to the files they touch, while buildings pulse and sprout scaffolding during edits. Each agent shows live tokens and an estimated, API-equivalent cost. Replay scrubs through agent activity, and time-lapse scrubs git history from the first commit to HEAD. The Inspector shows who touched a file and can explain it with a local model. Skyline reads the session logs that agents already write to your disk and sends nothing over the network at all, apart from an optional model download. It is free, MIT licensed and currently built for Windows x64. The app was itself built overnight by six AI agents, and Skyline watched them do it.

---

## Before posting

- Replace every `[LINK]` with the release page and confirm the installer is attached.
- Test the download on a clean Windows machine. Confirm the SmartScreen warning is the only one.
- Post the X thread first, then Show HN, then the subreddit posts, spaced over a day. Do not post both subreddits at the same time.
- Reply to comments within the first two hours.
