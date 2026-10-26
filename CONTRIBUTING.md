# Contributing
Issues and focused pull requests are welcome. Please attach reproduction steps, environment (Windows or Oracle Linux), and redacted logs.

Do not include session cookies, API tokens, account credentials, or screenshots showing personal conversations.

Run core checks locally:
  npm install
  node --test tests/catalog.test.mjs tests/provider-queue.test.mjs tests/sse.test.mjs tests/update.test.mjs tests/usage-ledger.test.mjs tests/warm-tabs.test.mjs

Other tests validate Windows Docker or Oracle-specific installation and must be run in their corresponding environments. CI currently runs the cross-platform core subset; it does not certify every provider login/image flow.
