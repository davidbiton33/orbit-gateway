# Orbit Gateway 2.1.1 — Installation isolation

Each new installation chooses a unique Compose project name such as `orbit-gateway-abcdefgh12` (or `orbit-clean-abcdefgh12` during clean QA). That name namespaces the containers, isolated bridge network, and **all named volumes**, including GPT Legacy.

- `gateway`: loopback Studio/API, local data and routing. Published default ports 4983/4984; CleanTest selects other available ports.
- `gpt`: browser worker, Compose profile `gpt-docker`, profile volume `<project>_gpt-data`, local noVNC 6081 by default.
- `gpt-legacy`: specialized original GPT engine, profile `gpt-legacy`, profile volume `<project>_legacy-gpt-profile` (NEVER external), private HTTP API and password-protected local noVNC on port 6080 by default.
- `gemini`: browser worker, profile `<project>_gemini-data`, local noVNC 6082 by default.

Every published host port binds only to `127.0.0.1`; service-to-service HTTP runs on a dedicated Compose bridge network and shares a strong generated Bearer Token. `switch-gpt.ps1` starts the selected GPT service, recreates only its own project's front gateway, and stops the unselected GPT service. It does not migrate profiles or conversation history.

`start-clean-test.ps1` first creates a new sibling copy of the software files, excluding any existing environment, cookies, or local data, then invokes the installer with `-CleanTest`. The installer generates a new Compose project and random token, then selects a free range of loopback ports. `verify-clean.ps1` inspects live Docker container project labels and attached volume names to reject foreign mounts. This verifies isolation, but remote website sign-in must still be checked manually.

No old `unified-ai-gateway_gpt_browser_profile` mount is referenced, even for Legacy mode. Legacy login occurs inside its already-running Chrome instance shown via noVNC.
