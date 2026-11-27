# Public page

A product's public page is published from one folder in its repo: `docs/public-page/`. This doc is that folder's contract.

## Location

Everything for the page sits in `docs/public-page/`, one folder per repo:

- **`README.md`:** the page itself. GitHub shows it when someone opens the folder.
- **`images/`:** the page's images, if it has any.
- **Anything that makes the images**, such as a script that draws them. A site never copies it.

A page with no images still lives in the folder.

## Shape

`README.md` is a small frontmatter block, then free-form markdown:

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

## Images

A page may show images: drawings, screenshots or photos. They sit in `images/` beside `README.md`, and the page shows them with plain HTML, by relative path:

```html
<figure>
<img src="images/example.svg" width="392" alt="What the image shows, in words.">
<figcaption>What the reader should take from it.</figcaption>
</figure>
```

- **Format:** SVG for drawings, each file complete in itself: its own colours, dark mode and motion, and nothing loaded from elsewhere. PNG, JPEG or WebP for screenshots and photos.
- **Alt text:** every image has `alt` text that says what it shows.
- **Two widths:** when one image can't serve both a phone and a desktop, wrap two in a `<picture>` and give the narrow one a `<source media="(max-width: 40rem)" srcset="images/example-tall.svg">`.
- **Live drawings:** a `<picture data-live>` tells the site it may swap each still for the file of the same name ending `-live.svg` and animate it. The still must make sense when the site leaves it as it is.
- **Nothing else:** the page shows only files in its own `images/` folder. A site refuses to copy a page that shows an image the folder doesn't have.

## Audience

Someone who has never seen the repo. Say what the product does and who it's for, in plain words. No install steps, and no links that only work inside the repo, such as relative links to its files.

## Public safety

The page and its images are published, so this applies in full in private repos too. Never include secrets, internal URLs, workspace or machine ids, personal data, or client details, unless the client is already public about it.

## Publishing

A site copies `README.md` and `images/` in through a pull request to the site's own repo. That PR is reviewed, and merging it is the approval to publish. Changing the folder publishes nothing by itself: the page stays as it was until the site copies it in again.

## Upkeep

The public page is what agents keep current as the product changes. The short intro in the repo's root README is an input to it, never rendered on the site, and only fixed when it becomes wrong.
