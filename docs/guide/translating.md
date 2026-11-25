# Help translate Piik

[中文](./translating.zh-CN.md) · [Contributing](../../CONTRIBUTING.md)

The 3.0 App/Server UI includes Simplified Chinese, English, Traditional Chinese,
Japanese and Korean. The public website, film and guides maintain separate
Chinese/English content. During 3.0 iteration, new and changed copy is maintained
in English and Simplified Chinese. Existing Traditional Chinese, Japanese and
Korean translations remain selectable; missing messages use English. Remove
obsolete keys from every catalog when removing a message. Suggest wording, correct a translation or add a language
through GitHub issues and pull requests.

For a wording suggestion, [open an issue](https://github.com/TNTcraftHIM/Piik/issues/new/choose)
with the language, page/control, current text, proposed text and reason. Include
a screenshot or steps to reach it; remove private invitations, passwords and
personal content. You can send a suggestion without setting up development tools.

## Make your first correction

1. Try the affected screen and read the nearby controls. Check existing
   languages when helpful; the [terminology and voice guide](../standards/naming.md#voice-and-terminology)
   owns names and writing style.
2. Fork Piik and work on a branch from current `main`, following
   [Contributing](../../CONTRIBUTING.md#lean-workflow). Small text edits can also
   be proposed through GitHub's file editor.
3. Find the text in the files below. In a locale file, change the string value
   after the colon. Keep the key and its placeholders. Search the key in the
   source to see where it appears; for example:

   ```sh
   rg -n -F 'host.title' src/client
   ```

4. Preview the affected screen and run the [relevant checks](#preview-and-check).
   For a typo in one language, edit that language. If the underlying meaning
   changes, update English and Simplified Chinese; remove an outdated optional
   translation when it would misrepresent the changed behavior.
5. Open a PR to `main` with the wording problem, languages/surfaces changed and
   preview results. For PR format, follow [Contributing](../../CONTRIBUTING.md#pull-request-scope).

## Find the right text

| Surface | Editable source |
| --- | --- |
| App launcher, shared Browser/App UI and 3.0 site/room UI, including tooltips and accessible labels | [Locale registry](../../src/client/locales/index.ts): [English](../../src/client/locales/en.ts), [Simplified Chinese](../../src/client/locales/zh.ts), [Traditional Chinese](../../src/client/locales/zh-Hant.ts), [Japanese](../../src/client/locales/ja.ts), [Korean](../../src/client/locales/ko.ts) |
| Welcome lines, waiting captions and changing browser-tab titles | Playful pools and title-frame catalogs in each locale file; website welcome lines reuse the English and Simplified Chinese pools |
| Website | [Page markup](../../site/index.html) and [interactive labels](../../site/main.js); text is paired by `en` and `zh-CN` |
| Introduction film | [Film sources](../../site/film/README.md); captions, artwork and playback labels have their own bilingual text |
| README and entry guides | [README pair](../../README.md), [documentation home](./README.md), [getting started](./getting-started.md) and [troubleshooting](./troubleshooting.md), each with a `.zh-CN.md` counterpart |

Edit the source, then rebuild the surface that serves it:

- **App/Server UI:** catalogs are bundled with the web assets. Publish the updated
  App or Server; a remote site's UI comes from that Server.
- **Website/film:** use the [website workflow](../operations/website.md).
- **Guides:** the documentation website renders repository Markdown at its next
  publication. Navigation and search labels live in `site/docs/`.

Update related guides when a control's name changes. Technical references keep
one shared version under [documentation ownership](../standards/documentation.md).

## Preserve meaning and syntax

Write naturally for the target audience. Use the shared glossary for role and
password names. Introductions may be light; actions, errors and deployment steps
must be clear. Preserve the conditions on performance, platform and connection
claims. A cultural reference should still make sense to someone unfamiliar with it.
Machine-assisted drafts need proofreading by someone who understands the language
and the screen; raise unclear source text in the PR instead of guessing.

For App startup failures, update the shared launcher and error explanations
together. Preserve Rust runtime reason codes and raw technical diagnostics.

Locale files are TypeScript objects. These are existing examples:

```ts
// en.ts
"host.title": "{name}'s screen",
// zh.ts
"host.title": "{name} 的屏幕",
```

Keep the lookup key `host.title`. Move `{name}` to fit the sentence, preserving
its spelling, braces and occurrence count. The formatter replaces each variable
once and accepts plain strings. For plural forms, HTML or different sentence
composition, describe the needed change in the PR so the caller and formatter
can be updated together.

Keep quotes, escapes and commas valid. Preserve commands, config keys, URLs,
download filenames and formatting placeholders. Translate
link labels and image descriptions; repair internal anchors when translating
Markdown headings. Keep legal license text and third-party notices intact.

## Add a language

Search existing issues and PRs for the language first. For a larger translation,
start an issue with its language tag, intended coverage and any terminology or
layout questions, so contributors can coordinate work and review.

1. Copy `src/client/locales/en.ts` to a file such as `fr.ts`. Translate the
   messages and title labels, write natural [playful entries](#playful-copy), and
   rename the three exports. Use `satisfies Partial<Record<CopyKey, string>>` for
   the message object, and retain `TitleFrameCatalog`
   and `PlayfulCatalog` from `zh.ts`.
   Chinese currently defines the key set; either existing language can provide
   context. Include only translated messages; the formatter supplies English
   for missing keys. Keep supplied placeholders correct and omit obsolete keys.
2. Import the exports in [locales/index.ts](../../src/client/locales/index.ts)
   and add one registry entry. For example, **after translating** the catalogs:

   ```ts
   fr: { name: "Français", short: "FR", tag: "fr", copy: fr,
     titleFrames: frTitleFrames, playful: frPlayful },
   ```

   Use an ASCII filename/key, the language's native name in `name`, a recognizable
   one-to-three-character button label in `short`, and a matching language tag
   in `tag`. Distinguish coexisting regional/script variants.
   Extra languages appear in the third, shared dropdown after the Chinese and
   English shortcuts. Check language
   selection, saved preferences and App handoff against the
   [system-language policy](../standards/naming.md#interface-languages).
3. Check complete screens and the launch flow, including launcher, room and error
   states. The 3.0 site and room use the shared catalog, with complete
   English/Simplified Chinese coverage and matching placeholders in supplied
   translations. Use the
   [module map](../standards/engineering.md#module-map).
4. State coverage in the PR. Website, film and documentation translations can be
   contributed separately; update their language controls when adding a language.
   For right-to-left scripts, implement and check text direction and layout.

System tags `zh-CN` and `zh-Hans` select Simplified Chinese; `zh-TW`, `zh-HK` and
`zh-Hant` select Traditional Chinese. Saved explicit choices take precedence over
system defaults, and App handoff carries the registered locale. The native
console supports Chinese/English with English fallback for other languages.
Windows window controls and permission prompts use the same five languages;
their shared labels live in [window-controls.json](../../src/client/ui/window-controls.json).

## Playful copy

Each language owns its welcome and waiting arrays, and each playful title has a
fixed `label` plus a `variations` array. Add or remove entries in that language
without matching another language's count, order or references. An empty array
omits the decoration; one entry stays static. Operational keys and title labels
remain literal and complete in English/Simplified Chinese. Errors, pauses, endings, required actions
and slogans stay fixed.

Welcome entries carry `text`. For example:

```ts
{ text: "Your seat is right here." },
```

Waiting entries are plain strings such as `"Pull up a comfy chair."`. Keep them
brief and natural in context. Avoid temporary trends, literal borrowed dialogue
and statements that invent progress, success or remaining time.

Timing follows the [playful-copy lifecycle](../standards/visual-language.md#playful-copy-lifecycle).
Preview welcome text at
`/__tooltip-preview`; use `/__status-preview` for waiting captions and titles.
Check both narrow windows and language changes. The website's build picks up
welcome edits automatically; its other copy remains separate.

## Preview and check

Use the Node/npm versions and local setup in [Run from source](../README.md#run-from-source).
For UI catalog edits, run from the repository root:

```sh
npm ci
npm run typecheck
npm test -- tests/copy.test.ts
```

These checks cover missing keys, empty text, placeholders, language selection
and handoff. Proofread the translation in the running UI too.

Run the local UI and server as described in the source guide. Choose the language
from the top-right controls, open the affected screen and inspect long names or counts
in context. Check narrow windows, keyboard focus, tooltips and accessible labels.
With extra languages registered, verify that the dropdown stays usable near
viewport edges and exposes its expanded/collapsed state to assistive technology.
For new languages, also check a reload, App launch, switching back to English,
and the additional-language menu. Keep meaningful phrases together instead of adding
spaces or hard line breaks to force one desktop layout.

Website and film changes use the [website preview](../operations/website.md#preview).
For Markdown changes, run `node scripts/check-docs.mjs` after staging new files,
then review GitHub's rendered Markdown and translated links. Additional checks
for code changes follow [Contributing](../../CONTRIBUTING.md#verification-entrypoints).

## Further reading

- [OBS translation guide](https://github.com/obsproject/obs-studio/wiki/How-To-Contribute-Translations-For-OBS): proofread in the running application and understand technical terms.
- [Godot translation guide](https://contributing.godotengine.org/en/latest/other/translations.html): locate source context and coordinate terminology.
- [Weblate translation guidance](https://docs.weblate.org/en/latest/user/translating.html#translating-special-text-safely): handle placeholders and markup carefully.
- [W3C language-tag guidance](https://www.w3.org/International/questions/qa-choosing-language-tags): use BCP 47 tags to identify languages and their variants.
- [Unicode CLDR language names](https://cldr.unicode.org/translation/displaynames/languagelocale-names): menu-name reference. Browser `Intl.DisplayNames` can help find native names; choose Piik's short button label in the registry.
