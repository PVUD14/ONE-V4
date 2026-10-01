# Demo site access list

`users.caddy` (any `*.caddy` file) in this folder lists who may open https://demo.oneby8.com
(the sandbox, ADR-046) — every page and every API call. It exists only on the server and is
never committed (it is git-ignored). With no file, the sandbox stays locked to everyone and
oneby8.com is unaffected. Inside, each person still signs in to a demo account. One person
per line:

    priya $2a$14$<bcrypt hash>

Make a hash on the server (type the password at the prompt; it is never shown):

    sudo docker compose exec reverse-proxy caddy hash-password

Then `sudo docker compose exec reverse-proxy caddy reload --config /etc/caddy/Caddyfile`.
Full steps: docs/ops/runbook-demo-site.md.
