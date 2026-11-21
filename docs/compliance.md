# Staying inside Anthropic's rules

Cla-Amp runs Claude Code, which is Anthropic's. This page lists the published
rules Cla-Amp is built to follow, how it follows each one, and where in the
code that is done, so that a change on either side can be checked against it.

It is the author's reading of public pages, written in good faith. It is not
legal advice and not a statement by Anthropic, and Anthropic has not reviewed
or approved Cla-Amp.

## The rules, and how Cla-Amp meets them

Quotes are short extracts; the pages themselves are what counts.

| The rule | Where it is written | How Cla-Amp meets it | Where in the code |
| --- | --- | --- | --- |
| "The Claude Code binary must not be modified." | Claude Code: legal and compliance | Cla-Amp runs the Claude Code program that the Claude Agent SDK package installs, as published. It changes no file of it. | `package.json` (the SDK version), `CLAUDE_BIN` in `main.mjs` |
| Customers "may not remove, disable, or restrict any authentication method built into it". | same | Sign in opens Claude Code's own `auth login` in a console, with every method it offers. Cla-Amp hides, removes or pre-selects none, and passes the person's environment on as it is. | `openClaudeConsole(['auth', 'login'])`, `childEnv` in `main.mjs` |
| "Each end user must authenticate with their own" key, subscription or provider credential; no paying for, reselling or passing along usage. | same | Cla-Amp has no account, key or usage of its own, and no server. Each person signs in to Claude Code themselves and is billed under their own agreement. | nothing to point at: there is no such code |
| Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; sign-in "must complete through Anthropic's own flow". | same | Cla-Amp never sees, reads, stores or sends a password, key or token. Sign-in happens in Claude Code and on Anthropic's page. It asks Claude Code only whether someone is signed in. | `authStatus` in `main.mjs`; `SECURITY.md` |
| The name: you may say "in plain text" that a product "runs Claude Code", but not use the names or logos in your own product's name or logo, or suggest Anthropic built or endorses it. | same | The name is Cla-Amp; its icon is its own. The README says it "runs Claude Code" and that it is unofficial and not endorsed. No Anthropic logo or artwork is included. | `README.md`, `renderer/brand/` |
| "Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product." | Claude Agent SDK: overview | Its own look, name and icon throughout. | skins, `renderer/` |
| Claude Code's use is under Anthropic's usage policy and each person's own terms. | Claude Code: legal and compliance | Said in the README's sign-in section. Cla-Amp adds no way round any limit. | `README.md` |

What Claude Code sends to Anthropic (chats, usage numbers, error reports) and
how each person changes it is on the [privacy page](privacy.md), written from
Anthropic's Data usage page, which is watched like the others.

## The open question

Two sentences pull in different directions for an app like this one:

- The Agent SDK overview says that, "unless previously approved", third-party
  developers may not "offer claude.ai login or rate limits for their products,
  including agents built on the Claude Agent SDK", and points to API keys.
- The legal page says its restriction does not "prevent an end user from
  signing in to the unmodified Claude Code binary with their own Claude
  subscription", and forbids removing or restricting any sign-in method.

Cla-Amp sits where they meet: it runs the unmodified program and leaves its
sign-in alone, and it is also built on the Agent SDK. Until Anthropic says
which reading applies:

- The README names an API account as the documented route for apps built on
  the SDK, and says that using a subscription this way is between the person
  and Anthropic's terms.
- Cla-Amp does not remove the subscription sign-in, since the legal page
  forbids restricting a method Claude Code offers.
- If Anthropic asks for a change, it is made promptly (see the README's "Good
  faith" section).

## For the project's owner to settle

- The legal page says that running Claude Code in a product "requires
  agreeing to our Commercial Terms of Service". Those are the terms accepted
  with a Claude Console (API) account. Whether a free, source-available
  project with no service behind it counts as such a product, and whether the
  owner's own acceptance is what is meant, is part of the question to put to
  Anthropic.
- The same message should ask the open question above.

## Keeping this true

- `npm run policy` (`tools/policy-watch.mjs`) reads the pages above, and the
  terms and usage policy, and says which changed and whether each sentence
  quoted here is still there. A GitHub run does the same every day and fails
  when something changed, which sends the owner a notice.
- When it reports a change: read the changed lines against the table, bring
  the table (and the code, if needed) up to date, then run
  `node tools/policy-watch.mjs --accept`.
- `npm run engine` (`tools/engine-check.mjs`) does the like for the engine's
  own updates: the Agent SDK's and Claude Code's change logs, and the Claude
  desktop app's release notes, which say which Claude Code Anthropic's own
  app carries. See "Taking an engine update" in [code-guide.md](code-guide.md).
- Changing how sign-in is started, what is passed to Claude Code, or the name,
  icon or README wording is a change to this page too: check it first.
