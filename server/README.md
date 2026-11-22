# UniDesk self-host kit

Run your **own** connection server and TURN relay, so UniDesk depends on nothing public and works even on strict office, school and mobile networks.

You need a small Linux server with a public IP (any VPS works; 1 vCPU / 1 GB RAM is plenty) and Docker.

## 1. Configure

Edit `turnserver.conf`:

- `user=unidesk:...`: pick a long random password
- `external-ip=...`: your server's public IP

## 2. Start

```bash
docker compose up -d
```

Open these ports in your firewall: **TCP 9000** (signaling), **TCP+UDP 3478**, **TCP 5349**, **UDP 49160–49200** (relay).

For TLS on the signaling server, put it behind a reverse proxy such as Caddy (`your-domain { reverse_proxy localhost:9000 }`) and use port 443.

## 3. Point UniDesk at it

In UniDesk → **Settings → Network**, on *both* computers:

| Field | Value |
|---|---|
| Server | `your-domain` (or IP) |
| Port | `443` with TLS via a proxy, or `9000` without |
| Path | `/` |
| Use TLS | on with a proxy, off for plain `9000` |
| Relay URLs | `turn:YOUR_IP:3478, turn:YOUR_IP:3478?transport=tcp` |
| Username / Password | from `turnserver.conf` |

Press **Save & reconnect**. Video stays end-to-end encrypted, even through your relay.
