# Help translate Piik

[中文](./translating.zh-CN.md) · [Contributing](../../CONTRIBUTING.md)

Piik currently includes Simplified Chinese and English. You can improve a label,
proofread a guide, or contribute another language. Translations are reviewed
through GitHub issues and pull requests.

For a wording suggestion, [open an issue](https://github.com/TNTcraftHIM/Piik/issues/new/choose)
with the language, page or control, current text, proposed text and a brief reason.
A screenshot or the steps to reach the text help establish context. Remove
private invitations, passwords and personal content from screenshots. A wording
suggestion does not require a development environment.

## Make your first correction

1. Try the affected screen and read the nearby controls. Check both existing
   languages when helpful; the [terminology and voice guide](../reference/naming.md#voice-and-terminology)
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
   changes, update the corresponding messages in every registered language.
5. Open a PR to `main`. Explain the wording problem, the language and surfaces
   changed, and what you checked. Mention anything you could not preview;
   maintainers can help with technical validation. PR format and publication
   follow [Contributing](../../CONTRIBUTING.md#pull-request-scope).

## Find the right text

| Surface | Editable source |
| --- | --- |
| App launcher and shared Browser/App UI, including tooltips and accessible labels | [English](../../src/client/locales/en.ts), [Chinese](../../src/client/locales/zh.ts) |
| Welcome lines and changing browser-tab titles | `welcome.*` messages and the title-frame catalog at the end of those same files |
| Website | [Page markup](../../site/index.html) and [interactive labels](../../site/main.js); text is paired by `en` and `zh-CN` |
| Introduction film | [Film sources](../../site/film/README.md); captions, artwork and playback labels have their own bilingual text |
| App console window | `consoleCopy` in [console.go](../../internal/app/console.go); entries are ordered English, Chinese, visual; retain the third slot even when empty |
| README and entry guides | [README pair](../../README.md), [getting started](./getting-started.md) and [self-hosting](../operations/self-hosting.md), each with a `.zh-CN.md` counterpart |

The App and Server serve the same web UI. Edit source files; build output and
release packages are generated. Translating an App message does not also
translate a website caption. Update related instructions when an action name
changes. Technical references keep one shared version; see
[documentation ownership](../maintenance.md).

## Preserve meaning and syntax

Write naturally for the target audience. Use the shared glossary for role and
password names. Introductions may be light; actions, errors and deployment steps
must be clear. Preserve the conditions on performance, platform and connection
claims. A cultural reference should still make sense to someone unfamiliar with it.
Machine-assisted drafts need proofreading by someone who understands the language
and the screen; raise unclear source text in the PR instead of guessing.

Locale files are TypeScript objects. These are existing examples:

```ts
// en.ts
"host.title": "{name}'s screen",
// zh.ts
"host.title": "{name} 的屏幕",
```

`host.title` is the lookup key; `{name}` is supplied by the application. Move the
placeholder to fit the sentence, preserving its spelling, braces and number of
occurrences. The current formatter substitutes each supplied variable once;
repeating `{name}` would leave the second occurrence visible. It accepts plain
strings, not HTML or ICU plural expressions. If a language needs plural forms
or different sentence composition, describe the actual case so the caller and
formatter can be changed together.

Keep quotes, escapes and commas valid. Preserve commands, config keys, URLs,
download filenames and format markers such as `%s` in Go console text. Translate
link labels and image descriptions; repair internal anchors when translating
Markdown headings. Keep legal license text and third-party notices intact.

## Add a language

Search existing issues and PRs for the language first. For a larger translation,
start an issue with its language tag, intended coverage and any terminology or
layout questions, so contributors can coordinate work and review.

1. Copy `src/client/locales/en.ts` to a file such as `fr.ts`. Translate the
   messages and title frames, rename the two exports, and retain the
   `Record<CopyKey, string>` and `TitleFrameCatalog` types imported from `zh.ts`.
   Chinese currently defines the key set; either existing language can provide
   context. Complete all keys rather than spreading an English catalog over
   missing translations.
2. Import the exports in [locales/index.ts](../../src/client/locales/index.ts)
   and add one registry entry. For example, **after translating** the two exports:

   ```ts
   fr: { name: "Français", short: "FR", tag: "fr", copy: fr, titleFrames: frTitleFrames },
   ```

   Use an ASCII locale filename/key, the language's own name in `name`, a compact
   button label in `short`, and a matching language tag in `tag`. Keep the short
   label recognizable in one to three characters, such as `中`, `EN` or `FR`;
   distinguish regional/script variants when they coexist. The registry supplies
   the language controls, document language, saved selection and App launch handoff.
   Chinese, English and visual mode retain their direct buttons; additional
   languages share one dropdown slot after visual mode. The selected extra
   language's short label appears on that slot, with its full name in the menu.
   Initial selection matches a registered tag or key, then its base language;
   unregistered languages use English. A saved choice takes precedence.
   The shared [system-language policy](../product/presentation-lifecycle.md#visual-language)
   also covers Chinese script and region variants across App, Server UI and website.
3. Check complete screens and the launch flow. New UI languages use English in
   the App console until its own translation is added. Console additions also
   require updating the launcher and loopback accepted-language checks together;
   use the [App module map](../reference/engineering.md#module-map).
4. State coverage in the PR. Website, film and documentation translations can be
   contributed separately; their existing language controls must be updated when
   adding a language there. For right-to-left scripts, include text direction and
   layout verification; a translated catalog alone does not establish RTL support.

Pure-visual mode is an optional presentation, not another language to translate.
The small visual scenes are shared with text modes; translate their labels and
explanations in the normal catalog. Keep the visual option available.

## Preview and check

Use the Node/npm versions and local setup in [Run from source](../README.md#run-from-source).
For UI catalog edits, run from the repository root:

```sh
npm ci
npm run typecheck
npm test -- tests/copy.test.ts
```

Type checking catches missing keys. The copy tests check registered catalogs for
empty text and mismatched placeholders, plus language selection and handoff.
Tests do not judge translation quality.

Run the local UI and server as described in the source guide. Choose the language
from the top-right controls, open the affected screen and inspect long names or counts
in context. Check narrow windows, keyboard focus, tooltips and accessible labels.
With extra languages registered, verify that the dropdown stays usable near
viewport edges and exposes its expanded/collapsed state to assistive technology.
For new languages, also check a reload, App launch, switching back to English,
and the optional visual mode. Keep meaningful phrases together instead of adding
spaces or hard line breaks to force one desktop layout.

Website and film changes use the [website preview](../operations/website.md#preview).
For Markdown changes, run `node scripts/check-docs.mjs` after staging new files,
then review GitHub's rendered Markdown and translated links. Additional checks
for code changes follow [Contributing](../../CONTRIBUTING.md#verification-entrypoints).

## Further reading

Reviewed 2026-09-13. These resources inform context-based proofreading and syntax
preservation; Piik's contribution steps above use its own repository workflow.

- [OBS translation guide](https://github.com/obsproject/obs-studio/wiki/How-To-Contribute-Translations-For-OBS): proofread in the running application and understand technical terms.
- [Godot translation guide](https://contributing.godotengine.org/en/latest/other/translations.html): locate source context and coordinate terminology.
- [Weblate translation guidance](https://docs.weblate.org/en/latest/user/translating.html#translating-special-text-safely): handle placeholders and markup carefully.
- [W3C language-tag guidance](https://www.w3.org/International/questions/qa-choosing-language-tags): use BCP 47 tags to identify languages and their variants.
- [Unicode CLDR language names](https://cldr.unicode.org/translation/displaynames/languagelocale-names): reference names for menus. Browser `Intl.DisplayNames` can help look up native names. Piik's one-to-three-character button labels are editorial choices, not standardized CLDR language names; keep them in the registry with each reviewed translation.
