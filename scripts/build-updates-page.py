#!/usr/bin/env python3
"""Build the public Updates page from opt-in commits and curated entries.

A commit is public only when its subject starts with ``[update]``. The rest
of the subject becomes the public title; the first paragraph of the commit
body becomes an optional summary. ``updates.json`` supplies fallback content
that is shown only until the first real public update exists in Git history.

Ported from norwegian/scripts/build-updates-page.py. The generated page's
header/nav/footer markup is hand-mirrored from THIS repo's actual
index.html (not blindly copied from norwegian's, which has drifted from
its own index.html in places -- e.g. it still hand-types the old
streak-badge markup instead of the current streak-menu structure). Two
scripts norwegian's version loads are intentionally not referenced here:
progressSharding.js does not exist in this repo (myWordsAuth.js's own
window.ProgressSharding calls are a pre-existing gap in the runtime app,
unrelated to this build), and this page never calls anything in it at
load time anyway.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent.parent
SITE = "https://osloandrew.github.io/japanese"
UPDATE_PREFIX = "[update]"
TRAILER_PREFIXES = ("co-authored-by:", "signed-off-by:", "reviewed-by:")
OSLO_TIMEZONE = ZoneInfo("Europe/Oslo")
UPDATES_BATCH_SIZE = 10


class UpdateBuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class Update:
    published_at: datetime
    title: str
    summary: str = ""


def parse_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise UpdateBuildError(f"Invalid update timestamp: {value!r}") from error
    if parsed.tzinfo is None:
        raise UpdateBuildError(f"Update timestamp must include a timezone: {value!r}")
    return parsed


def first_public_paragraph(body: str) -> str:
    paragraphs: list[list[str]] = []
    current: list[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            if current:
                paragraphs.append(current)
                current = []
            continue
        if line.casefold().startswith(TRAILER_PREFIXES):
            continue
        current.append(line)
    if current:
        paragraphs.append(current)
    return " ".join(paragraphs[0]) if paragraphs else ""


def commit_updates(repo_root: Path) -> list[Update]:
    command = [
        "git",
        "log",
        "--date=iso-strict",
        "--pretty=format:%cI%x1f%s%x1f%b%x1e",
    ]
    try:
        result = subprocess.run(
            command,
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise UpdateBuildError("Unable to read Git history for public updates") from error

    updates: list[Update] = []
    for record in result.stdout.split("\x1e"):
        # Git separates records with a newline after our explicit control
        # character. Strip only line endings: str.strip() would also remove
        # the unit separator that represents an intentionally empty body.
        record = record.strip("\r\n")
        if not record:
            continue
        fields = record.split("\x1f", 2)
        if len(fields) != 3:
            raise UpdateBuildError("Unexpected record while reading Git history")
        timestamp, subject, body = fields
        if not subject.casefold().startswith(UPDATE_PREFIX):
            continue
        title = subject[len(UPDATE_PREFIX) :].strip(" :-–—")
        if not title:
            raise UpdateBuildError("An [update] commit is missing its public title")
        updates.append(
            Update(
                published_at=parse_datetime(timestamp),
                title=title,
                summary=first_public_paragraph(body),
            )
        )
    return updates


def curated_updates(path: Path) -> list[Update]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UpdateBuildError(f"Unable to read {path.name}: {error}") from error
    if not isinstance(payload, list):
        raise UpdateBuildError(f"{path.name} must contain a list")

    updates: list[Update] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise UpdateBuildError(f"{path.name} entry {index + 1} must be an object")
        title = item.get("title")
        timestamp = item.get("publishedAt")
        summary = item.get("summary", "")
        if not isinstance(title, str) or not title.strip():
            raise UpdateBuildError(f"{path.name} entry {index + 1} needs a title")
        if not isinstance(timestamp, str):
            raise UpdateBuildError(f"{path.name} entry {index + 1} needs publishedAt")
        if not isinstance(summary, str):
            raise UpdateBuildError(f"{path.name} entry {index + 1} has an invalid summary")
        updates.append(parse_update(timestamp, title, summary))
    return updates


def parse_update(timestamp: str, title: str, summary: str = "") -> Update:
    return Update(parse_datetime(timestamp), title.strip(), summary.strip())


def combined_updates(repo_root: Path, curated_path: Path) -> list[Update]:
    public_commits = commit_updates(repo_root)
    updates = public_commits if public_commits else curated_updates(curated_path)
    unique: dict[tuple[str, str], Update] = {}
    for update in updates:
        key = (update.published_at.date().isoformat(), update.title.casefold())
        unique.setdefault(key, update)
    return sorted(unique.values(), key=lambda item: item.published_at, reverse=True)


def asset_version(site_root: Path, relative_path: str) -> str:
    digest = hashlib.sha256((site_root / relative_path).read_bytes()).hexdigest()[:10]
    return f"{relative_path}?v={digest}"


def human_timestamp(value: datetime) -> tuple[str, str]:
    oslo_value = value.astimezone(OSLO_TIMEZONE)
    return (
        f"{oslo_value.day} {oslo_value.strftime('%B')} {oslo_value.year}",
        f"{oslo_value.strftime('%H:%M')} Oslo Time",
    )


def render_entries(updates: list[Update]) -> str:
    if not updates:
        return '<p class="updates-empty">No public updates have been posted yet.</p>'
    cards: list[str] = []
    for index, update in enumerate(updates):
        date_label, time_label = human_timestamp(update.published_at)
        summary = (
            f"\n          <p>{html.escape(update.summary)}</p>" if update.summary else ""
        )
        latest_badge = (
            '<span class="update-latest-badge">Latest</span>' if index == 0 else ""
        )
        hidden = " hidden" if index >= UPDATES_BATCH_SIZE else ""
        cards.append(
            f'''<article class="update-entry"{hidden}>
        <div class="update-marker" aria-hidden="true">
          <i class="fas fa-check"></i>
        </div>
        <div class="update-content">
          <div class="update-meta">
            <time class="update-date" datetime="{update.published_at.isoformat()}">
              <span class="update-date-day">{date_label}</span>
              <span class="update-date-separator" aria-hidden="true">·</span>
              <span class="update-date-time">{time_label}</span>
            </time>
            {latest_badge}
          </div>
          <h2>{html.escape(update.title)}</h2>{summary}
        </div>
      </article>'''
        )
    return "\n      ".join(cards)


def render_page(updates: list[Update], site_root: Path) -> str:
    latest = updates[0].published_at.isoformat() if updates else "2026-08-25T00:00:00+02:00"
    foundation_css = asset_version(site_root, "styles/00-foundations-and-game.css")
    shell_css = asset_version(site_root, "styles/01-document-shell.css")
    footer_css = asset_version(site_root, "styles/10-shell-landing-and-stats.css")
    navigation_css = asset_version(site_root, "styles/35-navigation.css")
    updates_css = asset_version(site_root, "styles/50-updates.css")
    # Same handful of self-contained modules index.html loads for My
    # Words/streak (no scripts.js/wordGame.js here; this page never runs a
    # search or a round). spaced_repetition_js must precede word_list_js
    # (its loadWordStrengths() calls window.SpacedRepetition) and
    # word_list_js/story_favorites_js must precede my_words_auth_js (it
    # reads window.MyWordsAPI.STORAGE_KEY/window.StoryFavoritesAPI.STORAGE_KEY
    # at load time too) -- see each file's own top-level code. Unlike
    # norwegian, there is no progressSharding.js in this repo to load here.
    spaced_repetition_js = asset_version(site_root, "spacedRepetition.js")
    word_list_js = asset_version(site_root, "wordList.js")
    story_favorites_js = asset_version(site_root, "storyFavorites.js")
    my_words_auth_js = asset_version(site_root, "myWordsAuth.js")
    streak_js = asset_version(site_root, "streak.js")
    entries = render_entries(updates)
    load_more = (
        '''
        <div class="search-results-load-more">
          <button type="button" class="search-results-load-more-button">Show More Results</button>
        </div>'''
        if len(updates) > UPDATES_BATCH_SIZE
        else ""
    )
    structured_data = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "What's New — Japanese Dictionary",
            "description": "Recent improvements to the Japanese Dictionary and learning tools.",
            "url": f"{SITE}/updates/",
            "dateModified": latest,
        },
        ensure_ascii=False,
    ).replace("</", "<\\/")
    return f'''<!doctype html>
<html lang="en">
  <head>
    <base href="../">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>What's New | Japanese Dictionary</title>
    <meta name="description" content="See the latest improvements to the Japanese Dictionary, stories, vocabulary practice, and learning tools.">
    <meta property="og:title" content="What's New | Japanese Dictionary">
    <meta property="og:description" content="Recent improvements to the Japanese Dictionary and learning tools.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="{SITE}/updates/">
    <meta property="og:image" content="{SITE}/Resources/Icons/android-chrome-512x512.png">
    <meta property="og:image:alt" content="What's New | Japanese Dictionary">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="{SITE}/Resources/Icons/android-chrome-512x512.png">
    <meta name="twitter:image:alt" content="What's New | Japanese Dictionary">
    <link rel="canonical" href="{SITE}/updates/">
    <link rel="icon" type="image/png" sizes="32x32" href="Resources/Icons/favicon-32x32.png">
    <link rel="stylesheet" href="{foundation_css}">
    <link rel="stylesheet" href="{shell_css}">
    <link rel="stylesheet" href="{footer_css}">
    <link rel="stylesheet" href="{navigation_css}">
    <link rel="stylesheet" href="{updates_css}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,100..900&amp;family=Noto+Sans:wght@100..900&amp;family=Source+Sans+3:ital,wght@0,200..900;1,200..900&amp;family=Noto+Serif:wght@100..900&amp;family=Source+Serif+4:opsz,wght@8..60,200..900&amp;display=swap">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" integrity="sha384-PPIZEGYM1v8zp5Py7UjFb79S58UeqCL9pYVnVPURKEqvioPROaVAJKKLzvH2rDnI" crossorigin="anonymous">
    <script type="application/ld+json">{structured_data}</script>
  </head>
  <body>
    <a href="#main-content" class="skip-link">Skip to content</a>
    <header>
      <!-- Same #auth-container as index.html -- account menu, streak menu,
           Google sign-in -- kept real rather than stripped down: a visitor
           who lands here first (from a shared link, a search result) should
           see the same signed-in state and controls as everywhere else, not
           a page that looks logged out. No data-mode attributes on the
           account menu's links: those only mean something to
           initializeNavigation()'s click-interception in scripts.js, which
           this static document doesn't load, so they're plain real
           navigation into the live app instead. Mirrors the CURRENT
           index.html header structure (streak-menu, not the older
           streak-badge norwegian's own generated page still hand-types). -->
      <div class="header-top-row">
        <div id="auth-container" class="auth-container">
          <div class="account-menu">
            <button type="button" id="account-menu-btn" class="account-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu-panel" aria-label="Account menu" title="Account menu">
              <i class="fas fa-circle-user" aria-hidden="true"></i>
            </button>
            <div id="account-menu-panel" class="account-menu-panel hidden" role="menu" aria-label="Account">
              <a class="account-menu-item" role="menuitem" href="?type=my-stats"><i class="fas fa-chart-simple" aria-hidden="true"></i> My Stats</a>
              <a class="account-menu-item" role="menuitem" href="?type=settings"><i class="fas fa-gear" aria-hidden="true"></i> Settings</a>
              <a class="account-menu-item" role="menuitem" href="?type=about"><i class="fas fa-circle-info" aria-hidden="true"></i> About</a>
              <a class="account-menu-item" role="menuitem" href="updates/" aria-current="page"><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> What's New</a>
            </div>
          </div>
          <div id="streak-menu" class="streak-menu hidden">
            <button type="button" id="streak-menu-btn" class="streak-badge" aria-haspopup="dialog" aria-expanded="false" aria-controls="streak-menu-panel" aria-label="Day streak" title="Day streak">
              <i class="fas fa-fire" aria-hidden="true"></i>
              <span id="streak-badge-count">0</span>
            </button>
            <div id="streak-menu-panel" class="streak-menu-panel hidden" role="dialog" aria-label="Day streak and gems"></div>
          </div>
          <button id="google-signin-btn" type="button" class="google-signin-btn" title="Sign in to sync My Words across devices">
            Sign In
          </button>
          <div id="auth-user-info" class="auth-user-info hidden">
            <i class="fas fa-circle-user auth-generic-logo hidden" aria-hidden="true"></i>
            <svg class="auth-google-logo" viewBox="0 0 18 18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.6151z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2582c-.8064.54-1.8368.859-3.0477.859-2.3436 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.2827-1.1168-.2827-1.71s.1027-1.17.2827-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.964 10.71z"/>
              <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5813C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6564 3.5795 9 3.5795z"/>
            </svg>
            <span id="auth-user-name" class="auth-user-name"></span>
            <span id="sync-status" class="sync-status hidden" role="status" title="Your changes are saved on this device but haven't synced to your account yet. We'll keep trying.">
              <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
            </span>
            <button id="google-signout-btn" type="button" class="google-signout-btn" title="Sign out">Sign out</button>
          </div>
        </div>
      </div>
      <a id="site-title" href="./" aria-label="Japanese Dictionary, return to home">
        <span class="site-wordmark-name">Japanese Dictionary</span>
        <span class="site-wordmark-descriptor" aria-hidden="true">Words <span>&middot;</span> Stories <span>&middot;</span> Practice</span>
      </a>
    </header>
    <!-- Same #mode-nav as the main app shell (index.html) -- see
         styles/35-navigation.css, already linked above, for the top
         tab strip / fixed bottom tab bar it renders as. Plain links
         rather than the app's handleTypeChange() JS calls: this is a
         separate static document with none of that loaded, so a real
         navigation is the correct behavior here. Sentences/Stories/Word
         Game point at their own captured static pages (this same build
         pipeline generates sentences/, stories/, word-game/); My Words has
         no such page, so it stays a query-string link into the live app,
         same as the real index.html. None marked active -- What's New
         isn't one of the five primary modes. -->
    <nav id="mode-nav" aria-label="Primary">
      <a class="mode-tab" data-mode="words" href="?type=words">
        <span class="mode-tab-icon" style="mask-image: url(Resources/Photos/words.svg); -webkit-mask-image: url(Resources/Photos/words.svg)" aria-hidden="true"></span>
        <span class="mode-tab-label">Words</span>
      </a>
      <a class="mode-tab" data-mode="sentences" href="sentences/">
        <span class="mode-tab-icon" style="mask-image: url(Resources/Photos/sentences.svg); -webkit-mask-image: url(Resources/Photos/sentences.svg)" aria-hidden="true"></span>
        <span class="mode-tab-label">Sentences</span>
      </a>
      <a class="mode-tab" data-mode="stories" href="stories/">
        <span class="mode-tab-icon" style="mask-image: url(Resources/Photos/stories.svg); -webkit-mask-image: url(Resources/Photos/stories.svg)" aria-hidden="true"></span>
        <span class="mode-tab-label">Stories</span>
      </a>
      <a class="mode-tab" data-mode="word-game" href="word-game/">
        <span class="mode-tab-icon" style="mask-image: url(Resources/Photos/word-game.svg); -webkit-mask-image: url(Resources/Photos/word-game.svg)" aria-hidden="true"></span>
        <span class="mode-tab-label">Word Game</span>
      </a>
      <a class="mode-tab" data-mode="word-list" href="?type=word-list">
        <span class="mode-tab-icon" style="mask-image: url(Resources/Photos/bookmark.svg); -webkit-mask-image: url(Resources/Photos/bookmark.svg)" aria-hidden="true"></span>
        <span class="mode-tab-label">My Words</span>
      </a>
    </nav>
    <main id="main-content" class="updates-main">
      <div class="updates-shell">
        <section class="updates-intro" aria-labelledby="updates-title">
          <div class="updates-icon-chip" aria-hidden="true">
            <i class="fas fa-clock-rotate-left"></i>
          </div>
          <p class="updates-eyebrow">Product updates</p>
          <h1 id="updates-title">What's New</h1>
          <p class="updates-lede">See the latest improvements we're making to help you explore Japanese and practice more effectively.</p>
          <p class="updates-proof-line">
            <span>{len(updates)} update{"" if len(updates) == 1 else "s"}</span>
            <span aria-hidden="true">·</span>
            <span>New improvements added regularly</span>
          </p>
        </section>
        <section class="updates-feed" aria-labelledby="updates-feed-title">
          <div class="updates-feed-header">
            <div>
              <p class="updates-feed-eyebrow">Release notes</p>
              <h2 id="updates-feed-title">Recent improvements</h2>
            </div>
            <span class="updates-count" aria-label="{len(updates)} total updates">{len(updates)}</span>
          </div>
          <div id="updates-list" class="updates-list">
            {entries}
            {load_more}
          </div>
        </section>
      </div>
    </main>
    <footer>
      <div class="links">
        <a href="https://www.linkedin.com/in/afeinberg1/" target="_blank" rel="noopener noreferrer" class="footer-control linkedin-btn" aria-label="Connect with me on LinkedIn">
          <img src="Resources/Icons/linkedin-icon.png" alt="" class="linkedin-icon"><span>LinkedIn</span>
        </a>
        <a href="https://www.buymeacoffee.com/afeinberg4l" target="_blank" rel="noopener noreferrer" class="footer-control coffee-btn" aria-label="Buy me a coffee">
          <i class="fas fa-mug-hot" aria-hidden="true"></i><span>Buy Me a Coffee</span>
        </a>
        <a href="./?feedback=1" class="footer-control feedback-footer-btn">
          <i class="fas fa-comment-dots" aria-hidden="true"></i><span>Feedback</span>
        </a>
        <a href="updates/" class="footer-control updates-footer-link" aria-current="page">
          <i class="fas fa-clock-rotate-left" aria-hidden="true"></i><span>What's New</span>
        </a>
        <select id="site-switcher" class="footer-control site-switcher-select" aria-label="Go to another site">
          <option value="">Languages</option>
          <option value="croatian">Croatian</option><option value="german">German</option>
          <option value="hebrew">Hebrew</option><option value="italian">Italian</option>
          <option value="japanese">Japanese</option><option value="latin">Latin</option>
          <option value="norwegian">Norwegian</option><option value="persian">Persian</option>
          <option value="spanish">Spanish</option><option value="thai">Thai</option>
        </select>
      </div>
      <p class="copyright">© 2026 Japanese Dictionary</p>
    </footer>
    <!-- Same modules index.html loads for My Words sign-in/streak -- see
         the header comment above for the load-order constraints. Not
         deferred: already the last thing before </body>, so there's
         nothing left to wait on. -->
    <script src="{spaced_repetition_js}"></script>
    <script src="{word_list_js}"></script>
    <script src="{story_favorites_js}"></script>
    <script src="{my_words_auth_js}"></script>
    <script src="{streak_js}"></script>
    <script>
      const switcher = document.getElementById("site-switcher");
      switcher.addEventListener("change", () => {{
        if (switcher.value) location.href = `${{location.origin}}/${{switcher.value}}/`;
      }});

      const updatesList = document.getElementById("updates-list");
      const loadMoreUpdates = updatesList?.querySelector(
        ".search-results-load-more-button",
      );
      if (loadMoreUpdates) {{
        loadMoreUpdates.addEventListener("click", () => {{
          const nextUpdates = Array.from(
            updatesList.querySelectorAll(".update-entry[hidden]"),
          ).slice(0, {UPDATES_BATCH_SIZE});
          nextUpdates.forEach((entry) => entry.removeAttribute("hidden"));
          if (!updatesList.querySelector(".update-entry[hidden]")) {{
            loadMoreUpdates.closest(".search-results-load-more")?.remove();
          }}
        }});
      }}

      // Same open/close behavior as initializeAccountMenu() in scripts.js
      // (kept in sync by hand -- this page doesn't load scripts.js itself).
      const accountMenuBtn = document.getElementById("account-menu-btn");
      const accountMenuPanel = document.getElementById("account-menu-panel");
      if (accountMenuBtn && accountMenuPanel) {{
        const positionMenu = () => {{
          const viewportGutter = 8;
          accountMenuPanel.classList.remove("account-menu-panel--opens-right");
          accountMenuPanel.style.removeProperty("--account-menu-available-width");
          const buttonRect = accountMenuBtn.getBoundingClientRect();
          const panelWidth = accountMenuPanel.getBoundingClientRect().width;
          const viewportWidth = document.documentElement.clientWidth;
          const opensRight = buttonRect.right - panelWidth < viewportGutter;
          const availableWidth = opensRight
            ? viewportWidth - buttonRect.left - viewportGutter
            : buttonRect.right - viewportGutter;
          accountMenuPanel.classList.toggle(
            "account-menu-panel--opens-right",
            opensRight,
          );
          accountMenuPanel.style.setProperty(
            "--account-menu-available-width",
            `${{Math.max(0, availableWidth)}}px`,
          );
        }};
        const isMenuOpen = () => !accountMenuPanel.classList.contains("hidden");
        const closeMenu = () => {{
          accountMenuPanel.classList.add("hidden");
          accountMenuBtn.setAttribute("aria-expanded", "false");
        }};
        const openMenu = () => {{
          accountMenuPanel.classList.remove("hidden");
          positionMenu();
          accountMenuBtn.setAttribute("aria-expanded", "true");
        }};
        accountMenuBtn.addEventListener("click", (event) => {{
          event.stopPropagation();
          isMenuOpen() ? closeMenu() : openMenu();
        }});
        document.addEventListener("click", (event) => {{
          if (isMenuOpen() && !event.target.closest(".account-menu")) closeMenu();
        }});
        document.addEventListener("keydown", (event) => {{
          if (event.key === "Escape" && isMenuOpen()) {{
            closeMenu();
            accountMenuBtn.focus();
          }}
        }});
        window.addEventListener("resize", () => {{
          if (isMenuOpen()) positionMenu();
        }});
      }}
    </script>
  </body>
</html>
'''


def build(site_root: Path, repo_root: Path = ROOT, curated_path: Path | None = None) -> Path:
    curated_path = curated_path or repo_root / "updates.json"
    updates = combined_updates(repo_root, curated_path)
    output = site_root / "updates" / "index.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_page(updates, site_root), encoding="utf-8")
    print(f"Wrote {output} with {len(updates)} public update(s).")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=ROOT)
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--curated", type=Path)
    args = parser.parse_args()
    try:
        build(
            args.site_root.resolve(),
            args.repo_root.resolve(),
            args.curated.resolve() if args.curated else None,
        )
    except (UpdateBuildError, OSError) as error:
        raise SystemExit(f"Updates page build failed: {error}") from error


if __name__ == "__main__":
    main()
