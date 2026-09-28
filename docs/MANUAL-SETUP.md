# Naledi Backbone — Complete Setup Guide
### From nothing installed to a working demo at one URL

This guide assumes you know nothing about this project yet. Follow it top to bottom, in order, and don't skip steps even if they seem obvious — some of them fix real problems that only show up later if skipped.

By the end, you'll have a real Beckn network (with genuine protocol-level message signing and routing) running on your own machine, showing two working demo use cases at a single web address.

> **Older, manual method.** The repository root now has `./setup.sh` and `./start.sh`, which do all of Parts 1-3 below
> for you (including the one config change the starter kit needs) and add the My Journey connection. Prefer those.
>
> **If you follow the manual steps below, you also need this change, which the original steps missed:** in the
> starter kit's `generic-devkit/config/generic-routing-BAPCaller.yaml`, change the `url:` under the `discover` rule
> to `"http://onix-bpp:8082/bpp/receiver"` (it points at an external Discover Service by default), then restart
> the containers. Also copy `edge.Caddyfile` next to the compose file and use the override file from this repository. See
> [INTEGRATION.md](INTEGRATION.md). The manual steps below still work.

---

## Part 1 — Install the tools you need

### 1.1 — WSL (Windows Subsystem for Linux)
If you're on Windows and don't already have a Linux terminal, install WSL first. Open **PowerShell as Administrator** and run:
```
wsl --install
```
Restart your computer if asked. This gives you an Ubuntu-based Linux terminal to run everything else in.

### 1.2 — Docker Desktop
1. Download and install **Docker Desktop** from `docker.com`
2. Open Docker Desktop once installed
3. Click the **gear/settings icon** (top right)
4. Go to **Resources → WSL Integration**
5. Make sure **"Enable integration with my default WSL distro"** is checked, AND your specific distro (usually named `Ubuntu`) has its toggle switched **on**
6. Click **Apply & Restart**

**Verify it worked** — open your WSL terminal and run:
```bash
docker info
```
You should see a big block of text starting with `Client:` and `Server:`. If instead it says `docker: command not found` or `Cannot connect to the Docker daemon`, go back and redo step 1.2 — nothing past this point will work until this succeeds.

### 1.3 — Node.js and git
Check if you already have them:
```bash
node --version
git --version
```
If either command says "not found," install them:
```bash
sudo apt update
sudo apt install -y nodejs npm git
```

---

## Part 2 — Get the real Beckn network running (no custom code yet)

This section gets Meta's — sorry, **Beckn's** — actual reference network adapters running, using their own built-in placeholder apps, just to prove the base network works before we swap in our own code.

### 2.1 — Clone the starter kit
```bash
cd ~
git clone https://github.com/beckn/starter-kit.git
```

### 2.2 — Start it
```bash
cd ~/starter-kit/generic-devkit/install
docker compose -f docker-compose-generic.yml up
```

This will take a few minutes the first time — it's downloading several container images and starting ~6 services (a Registry, a Gateway, two protocol adapters called `onix-bap` and `onix-bpp`, and two placeholder demo apps).

**Leave this terminal running.** Everything happens in the background here.

### 2.3 — Verify it's healthy
Open a **second terminal window** and run:
```bash
cd ~/starter-kit/generic-devkit/install
docker compose -f docker-compose-generic.yml ps
```
Every row should say `Up` (some will also say `healthy`). If anything says `Exited` or `Restarting`, something's wrong — check the first terminal's scrolling log output for red `error` lines around when that service started.

Once you see all services `Up`, stop this base setup for now (we're about to replace part of it):
```bash
docker compose -f docker-compose-generic.yml down
```

---

## Part 3 — Swap in our real application code

The starter kit ships with generic placeholder apps standing in for "the buyer app" and "the seller app." We're replacing those two specific pieces with our actual code — everything else (the real protocol adapters, the registry, the signing/routing) stays exactly as the starter kit provides.

### 3.1 — Get our code
You'll be given (or should already have) these 4 files:
- `frontdoor-bap-server.js`
- `backbone-bpp-server.js`
- `Dockerfile`
- `docker-compose.override-naledi.yml`

### 3.2 — Put them in the right place
```bash
mkdir -p ~/starter-kit/generic-devkit/install/our-backend-naledi
```
Move the 2 `.js` files and the `Dockerfile` into that new folder:
```bash
mv frontdoor-bap-server.js ~/starter-kit/generic-devkit/install/our-backend-naledi/
mv backbone-bpp-server.js ~/starter-kit/generic-devkit/install/our-backend-naledi/
mv Dockerfile ~/starter-kit/generic-devkit/install/our-backend-naledi/
```
Move the compose override file one level up, next to the starter kit's own compose file:
```bash
mv docker-compose.override-naledi.yml ~/starter-kit/generic-devkit/install/
```

**Check it landed correctly:**
```bash
ls ~/starter-kit/generic-devkit/install/our-backend-naledi/
ls ~/starter-kit/generic-devkit/install/docker-compose.override-naledi.yml
```

### 3.3 — Start the real network with OUR code plugged in
```bash
cd ~/starter-kit/generic-devkit/install
docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml up --build
```

The `--build` flag matters — it tells Docker to actually build our 2 JavaScript files into containers, instead of using the starter kit's placeholders.

Wait for the scrolling log to settle down (a good sign: lines ending in `"Server listening on :8081"` and `"Server listening on :8082"`, with no red `error` lines after that).

---

## Part 4 — See it working

Open your web browser and go to:
```
http://localhost:3001/live
```

You should see **two panels side by side**: a phone-shaped app on the left (the "Naledi" side — someone looking for help), and a clean dashboard on the right (the "Provider" side — an organisation reviewing requests).

### Try the whole flow
1. On the left, type a real problem into the text box — e.g. *"I want to register my ELP but don't understand what the municipality needs"* — and click **Find help**
2. You'll see matching providers appear, each tagged **NGO** or **THABO**
3. Click **Select** on one
4. On the right (Provider side), a new request appears — click **Approve**
5. Watch the left side update on its own within a couple of seconds, showing it's now reserved

That whole loop is genuinely passing through the real Beckn protocol adapters — not faked, not simulated client-side.

---

## Part 5 — Making changes and redeploying

Whenever you (or someone else) edits `frontdoor-bap-server.js` or `backbone-bpp-server.js`, you need to redeploy for the change to actually show up:

```bash
cd ~/starter-kit/generic-devkit/install
docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml down
# (replace the changed file(s) in our-backend-naledi/ here)
docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml up --build
```

If a change doesn't seem to show up even after this, force a completely clean rebuild:
```bash
docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml build --no-cache
docker compose -f docker-compose-generic.yml -f docker-compose.override-naledi.yml up
```
...and do a hard refresh in your browser (`Ctrl+Shift+R`), or just open the page in a fresh tab.

---

## Troubleshooting — real problems we actually hit building this

**`docker: command not found` inside WSL, even though Docker Desktop is running**
→ Go back to step 1.2 — WSL Integration wasn't enabled for your specific distro. Toggle it on in Docker Desktop's settings, Apply & Restart.

**A container shows `Exited` in `docker compose ps`**
→ Look at the scrolling logs from the terminal running `docker compose up` — scroll up to find the first `error` line for that specific service. It'll usually name the exact problem (a missing config, a port conflict, etc).

**A `curl` or the browser can't reach `localhost:XXXX` at all**
→ First confirm the container is actually `Up`/`healthy` via `docker compose ps`. If it is, and it's still unreachable, check nothing else on your machine is already using that port: `docker compose ps` will show you the exact port mapping (e.g. `0.0.0.0:3001->3001/tcp`).

**A page loads but shows old/stale content after you changed a file**
→ You forgot to rebuild (`down` then `up --build`), or your browser cached the old page — hard refresh with `Ctrl+Shift+R`.

**`docker compose ... build` fails partway through, or hangs**
→ Usually a network hiccup pulling a base image. Just run the same command again — Docker resumes from where it left off.

---

## What's actually happening under the hood (short version)

- `onix-bap` and `onix-bpp` are the **real** Beckn protocol software — they sign messages, validate them against the official schema, and route them to each other. This is not something we built; it's the actual reference implementation.
- Our two files (`frontdoor-bap-server.js`, `backbone-bpp-server.js`) are the **application logic** sitting behind those adapters — they decide what a "Discover" or "Select" actually means for this specific use case (matching Naledis to NGOs/Thabos), same way a real business would plug their own app in behind the protocol layer.
- Everything is stored **in memory only** — restarting the containers wipes all data. This is intentional for a demo/prototype stage, not a bug.
