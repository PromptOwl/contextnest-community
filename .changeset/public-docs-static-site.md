---
"@promptowl/contextnest-community": minor
---

Public docs sites: a nest that is public with Reader Mode on is now also served as a static, search-engine-ready docs site at `/d/<slug>/…` — complete HTML per page with titles, descriptions, canonicals, structured data, a sitemap, robots.txt, llms.txt and Markdown twins, built from approved content only. Anonymous visitors to the nest's app URL are redirected to the page. Set `DOCS_SITES` to serve a site on its own domain, or run `npm run site:export` to write it out for any static host. Before this, every public docs URL returned the same empty app page to crawlers.
