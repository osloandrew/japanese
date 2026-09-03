"""Enrich captured pages with page-specific, non-visual metadata.

Deviates from norwegian/scripts/static_metadata.py in one load-bearing way:
this app's updateWordMetadata()/updateStoryMetadata() (scripts.js,
stories.js) deliberately set <link rel="canonical"> to the query-string
lookup URL, not a pretty path — this app has no pretty-path routing at all
(see index.html's #mode-nav comment), so that's correctly the only
dereferenceable address *while running as the live SPA*. But the whole
point of a captured static page is that IT becomes a second, real,
dereferenceable address for that content — so the captured copy must
canonicalize to itself, not to the page it was captured from. Norwegian
doesn't need this fix because its client already sets canonical to the
pretty path directly. set_canonical_link() below is applied by every
capture script (word, story, feature, and stories-index) to correct this
after capture.
"""

from __future__ import annotations

import html
import json
import re

SITE = "https://osloandrew.github.io/japanese"
STRUCTURED_DATA_ID = "page-structured-data"
CANONICAL_LINK_RE = re.compile(
    r'<link\s+[^>]*rel=["\']canonical["\'][^>]*>', re.IGNORECASE
)


def set_og_url(source: str, url: str) -> str:
    """Public wrapper for capture scripts outside this module that also
    need to correct a page's og:url (see set_canonical_link below and this
    module's docstring)."""
    return _set_meta(source, "property", "og:url", url)


def set_canonical_link(source: str, canonical: str) -> str:
    """Replace (or insert) <link rel="canonical"> so a captured page always
    canonicalizes to its own captured URL, regardless of what the live app
    set while rendering it."""
    tag = f'<link rel="canonical" href="{html.escape(canonical, quote=True)}">'
    if CANONICAL_LINK_RE.search(source):
        return CANONICAL_LINK_RE.sub(tag, source, count=1)
    return source.replace("</head>", f"    {tag}\n  </head>", 1)


def _meta_content(source: str, key: str, *, attribute: str = "property") -> str:
    for tag in re.findall(r"<meta\b[^>]*>", source, re.IGNORECASE):
        key_match = re.search(
            rf'\b{attribute}\s*=\s*(["\']){re.escape(key)}\1',
            tag,
            re.IGNORECASE,
        )
        if not key_match:
            continue
        content_match = re.search(
            r'\bcontent\s*=\s*(["\'])(.*?)\1', tag, re.IGNORECASE
        )
        return html.unescape(content_match.group(2)) if content_match else ""
    return ""


def _title(source: str) -> str:
    match = re.search(r"<title>(.*?)</title>", source, re.IGNORECASE | re.DOTALL)
    return html.unescape(match.group(1).strip()) if match else ""


def _ensure_meta(source: str, attribute: str, key: str, content: str) -> str:
    existing = re.compile(
        rf'<meta\s+[^>]*{attribute}=["\']{re.escape(key)}["\'][^>]*>',
        re.IGNORECASE,
    )
    if existing.search(source):
        return source
    tag = (
        f'<meta {attribute}="{html.escape(key, quote=True)}" '
        f'content="{html.escape(content, quote=True)}">'
    )
    return source.replace("</head>", f"    {tag}\n  </head>", 1)


def _set_meta(source: str, attribute: str, key: str, content: str) -> str:
    """Like _ensure_meta, but replaces an existing tag's content instead of
    leaving it alone. Used for og:url, which updateWordMetadata()/
    updateStoryMetadata() set to this word/story's query-string lookup URL
    (see this module's docstring) -- the captured copy's social metadata
    must point at itself instead."""
    existing = re.compile(
        rf'<meta\s+[^>]*{attribute}=["\']{re.escape(key)}["\'][^>]*>',
        re.IGNORECASE,
    )
    tag = (
        f'<meta {attribute}="{html.escape(key, quote=True)}" '
        f'content="{html.escape(content, quote=True)}">'
    )
    if existing.search(source):
        return existing.sub(tag, source, count=1)
    return source.replace("</head>", f"    {tag}\n  </head>", 1)


def _inject_graph(source: str, graph: list[dict[str, object]]) -> str:
    if f'id="{STRUCTURED_DATA_ID}"' in source:
        return source
    payload = json.dumps(
        {"@context": "https://schema.org", "@graph": graph},
        ensure_ascii=False,
        separators=(",", ":"),
    ).replace("</", "<\\/")
    script = (
        f'<script type="application/ld+json" id="{STRUCTURED_DATA_ID}">'
        f"{payload}</script>"
    )
    return source.replace("</head>", f"    {script}\n  </head>", 1)


def _website_node() -> dict[str, object]:
    return {
        "@type": "WebSite",
        "@id": f"{SITE}/#website",
        "url": f"{SITE}/",
        "name": "Japanese Dictionary",
        "inLanguage": ["en", "ja"],
    }


def _breadcrumb_node(
    canonical: str, items: list[tuple[str, str]]
) -> dict[str, object]:
    return {
        "@type": "BreadcrumbList",
        "@id": f"{canonical}#breadcrumb",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": position,
                "name": name,
                "item": url,
            }
            for position, (name, url) in enumerate(items, start=1)
        ],
    }


def _add_social_metadata(
    source: str, page_title: str, description: str, image: str
) -> str:
    values = (
        ("property", "og:site_name", "Japanese Dictionary"),
        ("property", "og:image:alt", page_title),
        ("name", "twitter:title", page_title),
        ("name", "twitter:description", description),
        ("name", "twitter:image", image),
        ("name", "twitter:image:alt", page_title),
    )
    for attribute, key, content in values:
        source = _ensure_meta(source, attribute, key, content)
    return source


def enrich_word_html(source: str, *, word: str, canonical: str) -> str:
    """Add a DefinedTerm graph and complete share metadata to a word page."""
    page_title = _title(source)
    description = _meta_content(source, "description", attribute="name")
    image = _meta_content(source, "og:image")
    # renderWordDefinition() -> updateWordMetadata() set canonical/og:url to
    # this word's query-string lookup URL (deliberately, for the live SPA —
    # see this module's docstring); the captured copy must point at itself
    # instead.
    source = set_canonical_link(source, canonical)
    source = _set_meta(source, "property", "og:url", canonical)
    term_id = f"{canonical}#term"
    graph: list[dict[str, object]] = [
        _website_node(),
        {
            "@type": "WebPage",
            "@id": canonical,
            "url": canonical,
            "name": page_title,
            "description": description,
            "inLanguage": ["en", "ja"],
            "isPartOf": {"@id": f"{SITE}/#website"},
            "mainEntity": {"@id": term_id},
            "breadcrumb": {"@id": f"{canonical}#breadcrumb"},
        },
        {
            "@type": "DefinedTerm",
            "@id": term_id,
            "name": word,
            "description": description,
            "inLanguage": "ja",
            "url": canonical,
            "inDefinedTermSet": {
                "@type": "DefinedTermSet",
                "@id": f"{SITE}/#dictionary",
                "name": "Japanese–English Dictionary",
                "url": f"{SITE}/",
            },
        },
        _breadcrumb_node(
            canonical,
            [("Japanese Dictionary", f"{SITE}/"), (word, canonical)],
        ),
    ]
    source = _add_social_metadata(source, page_title, description, image)
    return _inject_graph(source, graph)


def enrich_story_html(
    source: str,
    *,
    japanese_title: str,
    english_title: str,
    cefr_level: str,
    genre: str,
    canonical: str,
) -> str:
    """Add a LearningResource graph and complete share metadata to a story page."""
    page_title = _title(source)
    description = _meta_content(source, "description", attribute="name")
    image = _meta_content(source, "og:image")
    # displayStory() -> updateStoryMetadata() set canonical/og:url to this
    # story's query-string lookup URL (deliberately, for the live SPA — see
    # this module's docstring); the captured copy must point at itself.
    source = set_canonical_link(source, canonical)
    source = _set_meta(source, "property", "og:url", canonical)
    resource_id = f"{canonical}#learning-resource"
    resource: dict[str, object] = {
        "@type": "LearningResource",
        "@id": resource_id,
        "url": canonical,
        "name": japanese_title,
        "description": description,
        "inLanguage": ["ja", "en"],
        "learningResourceType": "Reading exercise",
        "isAccessibleForFree": True,
    }
    if english_title and english_title != japanese_title:
        resource["alternateName"] = english_title
    if cefr_level:
        resource["educationalLevel"] = cefr_level
    if genre:
        resource["genre"] = genre
    if image:
        resource["image"] = image

    graph: list[dict[str, object]] = [
        _website_node(),
        {
            "@type": "WebPage",
            "@id": canonical,
            "url": canonical,
            "name": page_title,
            "description": description,
            "inLanguage": ["ja", "en"],
            "isPartOf": {"@id": f"{SITE}/#website"},
            "mainEntity": {"@id": resource_id},
            "breadcrumb": {"@id": f"{canonical}#breadcrumb"},
        },
        resource,
        _breadcrumb_node(
            canonical,
            [
                ("Japanese Dictionary", f"{SITE}/"),
                ("Japanese Stories", f"{SITE}/stories/"),
                (japanese_title, canonical),
            ],
        ),
    ]
    source = _add_social_metadata(source, page_title, description, image)
    return _inject_graph(source, graph)
