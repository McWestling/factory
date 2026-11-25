# Public page

A product's public page is published from one file in its repo: `PUBLIC.md`. This doc is that file's contract.

## Location

`PUBLIC.md` sits at the root of the product's repo. One file per repo.

## Shape

A small frontmatter block, then free-form markdown:

```markdown
---
name: Example
pitch: One sentence on what it is.
url: https://example.com
---

## What it does

## Who it's for

## How to get it
```

- **`name`:** the product's name.
- **`pitch`:** one sentence on what it is.
- **`url`:** optional. The product's own address.

The headings are suggestions; use the ones the product needs. Text only for now: no images or diagrams.

## Audience

Someone who has never seen the repo. Say what the product does and who it's for, in plain words. No install steps, and no links that only work inside the repo, such as relative links to its files.

## Public safety

The file is published, so this applies in full in private repos too. Never include secrets, internal URLs, workspace or machine ids, personal data, or client details, unless the client is already public about it.

## Publishing

A site copies `PUBLIC.md` in through a pull request to the site's own repo. That PR is reviewed, and merging it is the approval to publish. Changing `PUBLIC.md` publishes nothing by itself: the page stays as it was until the site copies the file in again.

## Upkeep

`PUBLIC.md` is the file agents keep current as the product changes. The README's short intro is an input to it, never rendered on the site, and only fixed when it becomes wrong.
