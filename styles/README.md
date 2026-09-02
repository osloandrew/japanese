# Stylesheet map

The files in this directory replace the former 7,762-line `styles.css` file.
They are organized by shared shell and feature ownership, with responsive
rules colocated beside their base components. Their order in `index.html`
remains intentional.

## Current order

1. `00-foundations-and-game.css` — tokens, shared primitives, and core Word
   Game rules across desktop and responsive layouts.
2. `01-document-shell.css` — shared document sizing and the header/main/footer
   shell.
3. `10-shell-landing-and-stats.css` — authentication shell, landing page,
   vocabulary profile, My Stats, forms, and footer links.
4. `20-results-and-story-quiz.css` — result cards, filters, sentence results,
   story reading, and story quiz rules across desktop and responsive layouts.
5. `30-stories-and-word-lists.css` — story-list utilities and responsive
   word-list table components.
6. `35-navigation.css` — base and responsive behavior for the shared
   mode/filter/search toolbar and its Word Game controls.
7. `45-feedback-dialog.css` — the shared report-an-issue modal used by word
   definitions and Word Game.

## Refactoring rules

- Do not reorder the stylesheet links without running visual regression checks.
- Add new feature rules, including responsive behavior, to the file that
  already owns that feature.
- Before relocating an existing rule, check for later selectors that override
  it, including responsive and mode-scoped selectors.
- Prefer class selectors for new components. Reduce existing IDs and
  `!important` declarations only in focused cleanup passes that verify every
  affected state.
- Update a file's cache-busting query value in `index.html` whenever that file
  changes.

## Regression checklist

- Run `npm test`.
- Check representative 390px, 1024px, 1025px, and 1440px layouts.
- Exercise empty, populated, focused, and disabled toolbar states.
- Check the feedback dialog at desktop and mobile widths, including keyboard
  focus.

The document shell, shared navigation, Word Game, result views, Stories, and
word lists own their base and responsive behavior. Cross-feature components
with a genuine shared owner, such as the feedback dialog, remain in focused
files of their own.
