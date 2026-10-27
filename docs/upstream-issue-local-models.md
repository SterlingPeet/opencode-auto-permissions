# Draft issue for hueyexe/opencode-auto-permissions

**Title:** Reviewer reliability with local OpenAI-compatible models on OpenCode 2.x (options gap, no structured output, fallback policy)

## Summary

I run the reviewer against a self-hosted, OpenAI-compatible model router (`@ai-sdk/openai-compatible` provider) on OpenCode 2.1.4 and 2.2.0. Out of the box, about half of reviews failed. Most writes were auto-rejected while reads passed. Three things stack up, and only the first is a clear bug in this plugin. I'm opening this to ask how you'd like the other two handled, rather than sending code that may not fit the plugin's direction. A small PR for the first point is at `<PR link>`.

## 1. Strict `JSON.parse` of the reviewer reply

On the V2 path (`generateCurrent`), and on the stable text fallback, the reply goes through a bare `JSON.parse`. Local models often wrap a correct decision in Markdown fences, a sentence of prose, or a stray closing tag, so a valid verdict gets counted as a failure. The PR adds a tolerant parse that takes the first complete JSON object and rethrows the original error otherwise, plus one stricter re-ask on the V2 path.

## 2. TUI plugin options are empty unless `cli.json` lists the plugin

On OpenCode 2.1.4 and 2.2.0, the TUI half of a plugin receives options only from `~/.config/opencode/cli.json` `plugins` entries shaped `{ "package": ..., "options": {...} }`. A plugin that the server reports as TUI-capable reaches the TUI as a bare string with no options. See OpenCode `packages/core/src/plugin/module.ts` (options go only to the server `effect`) and `packages/tui/src/plugin/context.tsx` (`serverTuiPlugins` entries are strings, and options are read only from object entries).

With options in `opencode.json` only, `setup()` logs `options: {}`, `model` is unset, and every review silently runs on the requesting session's model. In my case that model returned empty replies about half the time. The README currently says `cli.json` matters only on "older V2 betas" (README lines 26, 72 and 147). It might be worth documenting that current builds need the same entry in both files, and/or detecting `options: {}` in the TUI and warning about it. I'll also raise the dropped options with OpenCode, since it looks unintended there.

## 3. Local-model policy questions

These are design questions rather than bugs:

- **Structured output on V2.** `session.generate` on OpenCode 2.x takes only `{prompt}` and returns text, so the V2 path can't enforce `DECISION_SCHEMA` the way the stable path's `format: json_schema` does. Many OpenAI-compatible servers do enforce `response_format: json_schema`. Would you accept an opt-in option that sends reviews for one named provider straight to its `/chat/completions` with the schema? Or would you rather wait for OpenCode to add structured output to `generate`? I have a design sketch, and I'll ask OpenCode about the `generate` side too.
- **Fallback policy.** The README documents a single fallback to the session model and no same-model retry. With a dedicated local reviewer, the session model is often a heavier model on the same server, so it's the weaker fallback. Retrying the configured reviewer would serve better there. Would an opt-in policy option be in scope, or do you prefer the fixed policy?

Happy to send PRs for whichever of these you'd take.
