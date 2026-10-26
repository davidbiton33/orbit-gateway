# Security & privacy

Orbit Gateway is intended for **local, single-user deployment**. It automates ordinary authenticated website sessions rather than using official provider APIs. The authentication state belongs to your Docker volumes; provider passwords are entered manually into the provider page inside the isolated Chrome profile.

- The Studio (`127.0.0.1:4983`), authenticated API (`127.0.0.1:4984`) and each noVNC viewer (`127.0.0.1:6080–6083`) are mapped to loopback only in Docker Compose. Do not expose them through a reverse proxy, tunnel, port forwarding, or shared host access.
- The API requires a bearer token in `.env.docker`; the Studio's same-origin local proxy does not require users to paste the token. Keep this file private, and never check it into a repository.
- The modern worker noVNC viewers do **not** have a separate authentication layer. Legacy GPT noVNC has a VNC password; classic VNC passwords may effectively use only eight characters. Localhost isolation is essential for both modes.
- The provider sessions, browsing data, chat metadata and local projects are persisted in named Docker volumes. Removing volumes or running `docker compose down -v` may irreversibly erase them. Keep backups of anything you cannot afford to lose.
- A signed updater implementation exists, but is disabled until the publisher configures a trusted HTTPS manifest and Ed25519 public key. Do not feed unverified manifests to the updater.
- Because the gateway sends prompts to third-party providers through their websites, those providers can process the prompts under their own terms and privacy policies. Do not assume offline processing.
- Automated interaction may be restricted by the providers' terms or technical controls. Do not use this tool to bypass CAPTCHA, rate limits or other access safeguards.
- This package contains no account tokens, actual `.env` files, Docker volumes, cookie jars or production logs.

This is not a security audit. A Node unit-test suite passing does not prove that browser automation, Docker Desktop or account logins are safe on every host.
