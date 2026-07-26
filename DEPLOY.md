# DEPLOY.md — moving receipts-bot to a Hetzner VPS

> **This is a runbook, not automation.** Every step below is executed by
> **you, the owner** — SSH access, the Hetzner console, and GitHub auth are
> all owner-only actions. No agent has run any of these steps or has cloud
> access. Read a step fully before pasting; a couple of commands need you
> to fill in a value (`<VPS_IP>`, `<repo-url>`, etc.) first.

Target: Hetzner Cloud **CX22** (2 vCPU / 4GB RAM / 40GB disk), running the
bot 24/7 independent of your Windows PC, using the same `docker-compose.yml`
/ `Dockerfile` already in this repo.

Prerequisite: you've pushed this repo to a **private** GitHub repo
(`.gitignore` already excludes `.env` — confirmed, nothing secret goes to
GitHub).

---

## 1. Create the Hetzner CX22 server

In the Hetzner Cloud console:

1. **New server** → image **Ubuntu 24.04 LTS**.
2. Type: **CX22** (2 vCPU / 4GB / 40GB).
3. **Location**: doesn't need to match your PC — pick whichever Hetzner
   region is closest to your Discord server's voice traffic (bot audio
   relays through Discord's own voice infra either way; region mainly
   affects your SSH latency and, marginally, STT/TTS/API round-trips to
   Deepgram/Anthropic/ElevenLabs). Any EU region is a safe default if
   unsure.
4. **SSH key**: add your public key at creation time (`Add SSH Key` →
   paste contents of `~/.ssh/id_ed25519.pub` or generate one first with
   `ssh-keygen -t ed25519`). **Do not** enable password auth — key-only
   from the start.
5. Create. Note the server's public IP (`<VPS_IP>`).

## 2. Lock down inbound with a Hetzner Cloud Firewall

The bot needs **zero inbound** beyond SSH — it only makes outbound
connections (Discord gateway/voice, Anthropic, Deepgram, ElevenLabs,
GitHub). The admin/health HTTP server (`HTTP_PORT=3000`) already isn't
published to the host in `docker-compose.yml` (no `ports:` mapping) —
same as your local setup — so there's nothing else to open.

In the Hetzner console:

1. **Firewalls** → **Create Firewall**.
2. Inbound rules: **TCP 22 (SSH) only**, source `0.0.0.0/0` (or narrower,
   your home IP/range, if it's static).
3. Delete/skip any other inbound rule Hetzner pre-fills (no HTTP/HTTPS
   needed — this isn't a web server).
4. Apply the firewall to your new server.

This is enforced at the network edge, before traffic even reaches the
box — it's the real perimeter, not just an OS-level `ufw` rule.

## 3. SSH in, create a non-root user, harden SSH

```bash
ssh root@<VPS_IP>

adduser deploy
usermod -aG sudo deploy

# copy your key so the new user can log in
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Then edit `/etc/ssh/sshd_config` (`sudo nano /etc/ssh/sshd_config`) and set:

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
sudo systemctl restart ssh
```

Log out, and confirm you can log back in as `deploy` **before** closing
your root session (so you're not locked out if something's wrong):

```bash
ssh deploy@<VPS_IP>
```

That's the baseline — not a full CIS hardening pass, just root-login-off
+ password-auth-off, which covers the realistic risk for a single-owner
hobby box behind a firewall that only allows port 22 anyway.

## 4. Install Docker Engine + Compose plugin (Docker's official apt repo)

Ubuntu's packaged `docker.io` is older; use Docker's repo instead:

```bash
# as `deploy`, with sudo
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# run docker without sudo
sudo usermod -aG docker deploy
```

Log out/in again (or `newgrp docker`) for the group change to apply, then
confirm:

```bash
docker --version
docker compose version
```

Ubuntu enables and starts the `docker` systemd service automatically on
install — no extra step needed for it to survive reboots (see §8).

## 5. Clone the private repo

You need a way to authenticate `git clone` against a private repo on a
box that's never talked to GitHub before. For a **single-owner,
single-box** setup, a **fine-grained Personal Access Token (PAT)** is the
simpler of the two common options (vs. generating + registering an SSH
deploy key) — one token, scoped to just this repo, revocable anytime from
GitHub settings, no keypair to manage on the box.

1. GitHub → Settings → Developer settings → Fine-grained tokens → generate
   one scoped to just this repo, **Contents: read-only** is enough.
2. On the VPS:

```bash
git clone https://<TOKEN>@github.com/<you>/<repo>.git /home/deploy/receipts-bot
cd /home/deploy/receipts-bot
```

The token ends up sitting in `.git/config` on disk in plaintext — same
risk class as `.env` already living there (§6), which you're already
accepting for this box. If you'd rather not have a bearer token at rest
in git config, the alternative is an SSH **deploy key**: `ssh-keygen -t
ed25519 -f ~/.ssh/deploy_key` on the VPS, add the `.pub` under the repo's
**Settings → Deploy keys** (read-only), then clone via
`git@github.com:<you>/<repo>.git`. Either works; pick one and move on —
this doesn't need to be precious for a single hobby box.

## 6. Get `.env` onto the box — via `scp`, never via git

Real secrets (`DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `ADMIN_API_TOKEN`, etc.) must **never** touch git,
even a private repo — `.gitignore` already excludes `.env`, keep it that
way. Copy the file directly from your PC:

```powershell
# from your Windows PC, in the repo directory
scp .env deploy@<VPS_IP>:/home/deploy/receipts-bot/.env
```

`.env` and `.env.example` are confirmed in sync (same keys, same order) —
if you've added anything to one since, diff them before you copy.

One thing to note so it doesn't look wrong when you open the file on the
box: `.env`'s `DATABASE_URL` says `localhost` — that's only used for the
non-Docker `npm run dev` path. `docker-compose.yml` overrides it for the
`bot` service to point at the `postgres` service by name at container
start, same as it already does on your PC. No edit needed.

## 7. Bring it up

The CX22 has 2 real vCPUs — the base `docker-compose.yml` caps (bot 1.5
cpu + postgres 1.0 cpu = 2.5) are sized for your PC and would over-commit
this box. A second file, `docker-compose.prod.yml`, layers on lower VPS
caps (bot 1.0 + postgres 0.5, leaving headroom for the OS). Bring it up
**with both files, on the VPS only**:

```bash
cd /home/deploy/receipts-bot
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Why not just name it `docker-compose.override.yml`? That exact filename
auto-merges into *every* plain `docker compose up`, on *any* machine, in
this same directory — including your PC. If this file were named that,
the next `docker compose up -d --build` you run locally would silently
inherit the VPS's lower CPU caps too. Naming it `docker-compose.prod.yml`
and requiring the explicit `-f` flag keeps the two machines' caps
independent — don't rename it later without keeping that in mind.

Verify:

```bash
docker compose ps
docker compose logs bot --tail 30
```

Look for the same signal you check locally — the bot logging in as
`discord client ready` and slash commands registered — plus `postgres`
showing `healthy` in `docker compose ps`.

## 8. Reboot survival — already covered, no systemd unit needed

`docker-compose.yml` already sets `restart: unless-stopped` on both
`postgres` and `bot`. Combined with Docker's own daemon starting on boot
(enabled by default on Ubuntu after the apt install in §4), that's the
whole story: VPS reboots → `dockerd` starts → it restarts any container
that wasn't explicitly stopped → your stack comes back up on its own. You
don't need a separate systemd unit wrapping `docker compose up`.

## 9. Lightweight Postgres backups (cron + pg_dump)

This is a hobby box, not an enterprise deployment — no need for a backup
tool beyond a nightly dump. This is a reasonable default; treat exact
cadence/retention as adjustable if backend/frodo publish more specific
guidance later.

```bash
sudo mkdir -p /home/deploy/receipts-bot/backups
sudo chown deploy:deploy /home/deploy/receipts-bot/backups
```

Add a script `/home/deploy/receipts-bot/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /home/deploy/receipts-bot
STAMP=$(date +%Y%m%d)
docker compose exec -T postgres pg_dump -U receipts_bot receipts_bot \
  | gzip > "backups/receipts_bot_${STAMP}.sql.gz"
# keep 14 days
find backups -name '*.sql.gz' -mtime +14 -delete
```

```bash
chmod +x /home/deploy/receipts-bot/backup.sh
crontab -e
# add:
0 3 * * * /home/deploy/receipts-bot/backup.sh >> /home/deploy/receipts-bot/backups/backup.log 2>&1
```

Restore, if ever needed:

```bash
gunzip -c backups/receipts_bot_<STAMP>.sql.gz | docker compose exec -T postgres psql -U receipts_bot receipts_bot
```

Not covered here (deliberately, for a hobby box): offsite/off-VPS backup
copies of the cron dump itself. If the disk dies, the `.sql.gz` files die
with it — that's what the Hetzner snapshot below covers instead.

**Also enable Hetzner Cloud snapshots** (console → your server →
**Snapshots**, roughly 20% of the server's monthly cost) as a full-disk
safety net alongside the cron dump above — additive, not a replacement.
The cron dump lives on the same disk as everything else, so a deleted
VPS or a failed disk takes it down too; a Hetzner snapshot is stored
Hetzner-side, independent of this disk, and survives that. Different
failure modes: the dump gives you a granular, scriptable restore of just
the DB (§9 above); the snapshot gives you the whole box back (OS,
Docker, repo, everything) if the VPS itself is gone.

## 10. Deploying updates later

Once this initial setup is done, shipping a code change is:

```bash
ssh deploy@<VPS_IP>
cd /home/deploy/receipts-bot
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose logs bot --tail 30   # confirm clean restart
```

Keep using the two-file `-f` form on the VPS every time — dropping back
to plain `docker compose up -d --build` here would silently re-apply the
PC-sized caps (bot 1.5 / postgres 1.0 cpu) to the CX22's 2 vCPUs.

`.env` doesn't move through git, so it's untouched by `git pull` — if a
future change adds/renames env vars, `scp` the updated `.env` over again
(§6) before rebuilding.

**Rollback**, if an update misbehaves:

```bash
git log --oneline -5          # find the last-known-good commit
git checkout <good-commit>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Postgres state isn't touched by a code rollback (same named volume,
`postgres-data`, persists across rebuilds) — only restore from a §9
backup if a migration in the bad commit actually changed schema/data in
a way the rollback commit doesn't expect. Check whether the bad deploy
included a DB migration before assuming a plain code rollback is enough.
