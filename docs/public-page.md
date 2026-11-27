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

The headings are suggestions; use the ones the product needs.

## Drawings

A page may show drawings. They sit in a `public-page/` folder beside `PUBLIC.md`, and the page shows them with plain HTML, by relative path:

```html
<figure>
<img src="public-page/example.svg" width="392" alt="What the drawing shows, in words.">
<figcaption>What the reader should take from it.</figcaption>
</figure>
```

- **Format:** SVG, each file complete in itself: its own colours, dark mode and motion, and nothing loaded from elsewhere.
- **Alt text:** every drawing has `alt` text that says what it shows.
- **Two widths:** when one drawing can't serve both a phone and a desktop, wrap two in a `<picture>` and give the narrow one a `<source media="(max-width: 40rem)" srcset="public-page/example-tall.svg">`.
- **Live drawings:** a `<picture data-live>` tells the site it may swap each still for the file of the same name ending `-live.svg` and animate it. The still must make sense when the site leaves it as it is.
- **Nothing else:** the page shows only files in its own `public-page/` folder. A site refuses to copy a page that shows a drawing the folder doesn't have.

## Audience

Someone who has never seen the repo. Say what the product does and who it's for, in plain words. No install steps, and no links that only work inside the repo, such as relative links to its files.

## Public safety

The file is published, so this applies in full in private repos too. Never include secrets, internal URLs, workspace or machine ids, personal data, or client details, unless the client is already public about it.

## Publishing

A site copies `PUBLIC.md` and its `public-page/` folder in through a pull request to the site's own repo. That PR is reviewed, and merging it is the approval to publish. Changing `PUBLIC.md` publishes nothing by itself: the page stays as it was until the site copies the file in again.

## Upkeep

`PUBLIC.md` is the file agents keep current as the product changes. The README's short intro is an input to it, never rendered on the site, and only fixed when it becomes wrong.
