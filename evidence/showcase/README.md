# Captured French terminal showcase

The two screenshots in the main README show the same actual local Mistral run, using synthetic fixture `m-100` and the existing SQLite quote. They were captured directly from the Terminal window; they are not generated illustrations.

- Run ID: `bb16b0ec-3b28-4c94-baeb-6d732ad77d12`
- Completed at: `2026-09-10T12:53:41.629Z`
- Model: `mistral:7b-instruct-v0.3-q4_K_M`, running in Ollama inside Docker on macOS
- Result: `draft_prepared` in 6 model turns
- Duration: 15.89 seconds, with model/context already warm from earlier runs. This is not a cold-start latency benchmark.
- Quote: `q-m-100`, **636 EUR excluding VAT**, pending human review
- Replay: the quote existed before the run; no duplicate quote or new sale is claimed.

## Inspect the evidence

- [Quote in French](quote.md): products, quantities, prices and status.
- [Activity in French](activity.md): model-selected actions (`IA`) and automatic checks (`CONTRÔLE`), including exact arguments and observed results.
- [Structured result](agent-result.json).
- [Full structured trace](trace.jsonl).
- [Live terminal screenshot](../../docs/images/terminal-live.png).
- [Final quote and actions screenshot](../../docs/images/quote-and-actions.png).

The repeated CRM lookup is the model’s observed behavior and is retained in the record. Prices are calculated and verified by the quote service using the catalogue. The interface explains actions; it does not expose or reconstruct private model reasoning. No approval, payment or external sending occurred.

The implementation also passed all 18 integration tests after the terminal and report changes. These are local checks, not hosted CI results.
