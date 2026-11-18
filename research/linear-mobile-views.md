# What Linear's iPhone app can group, filter and display in views

Researched 2026-11-17 from Linear's docs and changelog, plus screenshots of the iPhone app taken the same week.

Linear publishes no feature matrix for mobile. Its docs describe the desktop and web app, and the mobile app is documented only through one short docs section and scattered changelog bullets. So each claim below carries one of three marks:

- **Documented:** a Linear doc or changelog entry says it.
- **Observed:** seen in the iPhone screenshots, not in any doc.
- **Unknown:** no source found. Needs a check on the phone.

## Short answers

- **Grouping:** one level only on the iPhone. No sub-grouping control exists there (observed). Whether a sub-group saved on desktop still renders on the phone is unknown.
- **Project views:** project lists on iOS have display settings for row properties and closed projects (documented). Grouping in iOS project lists is not documented; it is documented for Android only.
- **Navigation:** favorites, favorite folders, pinned projects and pinned initiatives all work on iOS (documented). These give a per-product entry point without new views.
- **Row display:** Labels and Project can both be shown on issue rows (observed). A product label on the row is the only row property that names the product directly.
- **Limits:** no documented cap on views or favorites. Issue views and project views are on every plan. Saved initiative views and sub-initiatives need Enterprise.

## Grouping and sub-grouping

**Observed on the iPhone.** An issue view's display sheet offers:

- `Grouping`, one level. It was set to Project in the screenshots.
- `Ordering`
- `Completed issues`
- `Show sub-issues`
- `Maximum title length`
- Row properties: Status, Priority, Assignee, ID, SLA, Labels, Project, Milestone, Cycle, Due Date, Estimate.

There is no sub-grouping control.

**Documented for desktop.** Issues group by "status, assignee, project, priority, cycle, label, parent issue, team, customer, release, and SLA status" ([Display options](https://linear.app/docs/display-options)). The same page describes sub-grouping, but contradicts itself: one sentence says "Parent issue grouping and sub-grouping are available only in board layout", the next section says "Sub-grouping is available in lists and boards (as rows)". Neither sentence mentions mobile.

**Documented for iOS.** Only one changelog bullet covers iOS issue display settings: "Added a 'Show sub-issues' toggle to issue display settings, allowing users to hide sub-issues from their view" ([2025-10-23](https://linear.app/changelog/page/4)). The fuller text of that bullet says this "aligns mobile issue lists with desktop saved views". That is the only hint that mobile reads a saved view's display settings, and it covers one toggle, not grouping.

**Unknown, check on the phone:**

- Which fields the iPhone `Grouping` picker lists. The desktop list above is the upper bound; the phone may offer fewer.
- Whether a view saved on desktop with a group and a sub-group shows the group on the phone, and whether the sub-group is dropped silently or changes the order.
- Whether changing `Grouping` on the phone is a personal preference or changes the view's saved default. On desktop, changes stay personal unless you press `Set as default` ([Display options](https://linear.app/docs/display-options)).
- Whether group order set on desktop carries over.

No changelog entry from September 2024 (mobile launch) to November 2026 mentions sub-grouping on iOS or Android. The inference is that mobile does not have it, which matches the screenshots.

## Project views

**Documented for desktop.** Project views group by "lead, member, status, health, start date, and target date", and "in project views, you can also group by initiative" ([Display options](https://linear.app/docs/display-options)). Layouts are list, board and timeline.

**Documented for iOS.** "Added display settings to project lists. Customize the properties that display on each row, as well as whether to include closed projects" ([2025-06-05](https://linear.app/changelog/2025-06-05-asks-fields-and-triage-routing)). No grouping is mentioned.

**Documented for Android only.** "Improved display settings for project lists to support grouping, ordering, row properties, etc." ([2025-07-17](https://linear.app/changelog/page/5)). No matching iOS bullet was found. iOS may have gained grouping without a changelog line, or may still lack it.

**Unknown, check on the phone:**

- Whether a custom project view opens on the iPhone at all, and from where. The docs only describe team project lists and project pages on mobile.
- Whether the iOS project list display sheet has a `Grouping` row, and whether Initiative and Status are in it.
- Whether a project view grouped by initiative on desktop keeps that grouping on the phone.

## Navigation

All documented, all on iOS:

- **Favorites.** The Home tab gives quick access to favorites ([Download Linear](https://linear.app/docs/get-the-app)). Favorites can be views, projects, initiatives, labels, teams and more ([Favorites](https://linear.app/docs/favorites)).
- **Favorite folders.** "You can now move a favorite into a folder from its context menu on the Favorites tab" on iOS ([2026-11-04](https://linear.app/changelog/2026-11-04-mobile-diffs)). Android can rename and remove folders from a long-press menu ([2026-05-14](https://linear.app/changelog/page/2)). Creating a folder on iOS is not documented; create folders on desktop to be safe.
- **Pinned items.** You can "rearrange the main navigation items, or pin specific projects, initiatives, and documents for quick access" in the bottom toolbar, from the `•••` menu on each item ([2026-01-22](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile)). Views are not in that list, so a view cannot be pinned to the toolbar. A product's initiative can.
- **Team pages.** "A new navigation menu lets you quickly switch between views of your team's projects, issues, cycles, and Triage" ([2025-03-06](https://linear.app/changelog/page/6)).
- **Attached views as tabs.** "Custom views attached to projects and teams appear as tabs" on mobile ([2025-04-03](https://linear.app/changelog/page/6)). A view attached to a team's Issues page, or to a project, shows up as a tab without being a favorite.
- **Initiative pages.** Initiatives open on mobile, and can be created and pinned there ([2026-02-05](https://linear.app/changelog/page/3), [2026-01-22](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile)).
- **Label views.** A label view lists every issue with that label and can be a favorite ([Label views](https://linear.app/docs/label-views)). Whether a label view opens on iOS is unknown.

So a per-product entry point needs no new view type. The options, lightest first:

1. Pin the product's initiative to the toolbar, or favorite it.
2. Put each product's favorites in a favorite folder named after the product.
3. Attach views to the team's Issues page so they appear as tabs.

**Unknown, check on the phone:**

- What an initiative page shows on the iPhone: its project list only, or issues too. On desktop an initiative lists projects, not issues.
- Whether favorite folders created on desktop show as folders on the iPhone Favorites tab. The November 2026 bullet implies yes.
- Whether initiative-attached view tabs appear on mobile. Those need Enterprise in any case.

## Row display

**Observed.** iPhone issue rows can show Status, Priority, Assignee, ID, SLA, Labels, Project, Milestone, Cycle, Due Date and Estimate. `Maximum title length` trades title space for property space.

**Documented for desktop, absent from the iPhone sheet:** release, links, customers, customer revenue, time in status, created date, updated date, pull requests and commits, Sentry issues ([Display options](https://linear.app/docs/display-options)).

**Inferred.** For telling products apart in one list:

- **Labels** helps if every issue carries a product label. The label name is on the row.
- **Project** names the map or project, not the product. It helps only if you know which product each project belongs to.
- **ID** shows the team prefix. It tells products apart only if each product has its own team.
- There is no initiative property on issue rows, on desktop or mobile. Issues do not belong to initiatives directly.

Grouping by Project and showing Labels on the row is the closest the iPhone gets to two levels in one list.

**Unknown, check on the phone:** how many labels fit on a row before truncation, and whether a product label is still visible when an issue has three or four labels.

## Limits and plan preconditions

**Documented:**

- Custom issue views and project views carry no plan gate. Only "saved initiative views are available on the Enterprise plan" ([Custom Views](https://linear.app/docs/custom-views)).
- Initiatives are on all plans. Sub-initiatives need Enterprise. Team initiatives need Business or Enterprise ([Initiatives](https://linear.app/docs/initiatives), [Sub-initiatives](https://linear.app/docs/sub-initiatives)).
- Free plan: 250 issues and 2 teams. Basic: 5 teams ([Pricing](https://linear.app/pricing), [Teams](https://linear.app/docs/teams)). A team-per-product layout hits the team cap on Free and Basic.
- Team-scoped project labels need Business or Enterprise. Workspace project labels are on all plans ([Teams](https://linear.app/docs/teams)).
- The mobile apps are not tied to a plan in any doc.

**Not documented:** any cap on the number of custom views, favorites or favorite folders. The docs and pricing page state none. Absence of a stated limit is not proof of none, but no doc suggests a practical ceiling at the scale of a few dozen views.

## Preconditions these answers hang on

- **App version.** The screenshots and the latest changelog checked are from November 2026. Moving a favorite into a folder on iOS shipped on 2026-11-04, so the app must be at least that release. Toolbar pinning needs the January 2026 release or later.
- **Plan.** Everything recommended above works on every plan, except initiative views and sub-initiatives (Enterprise) and team initiatives (Business).
- **Settings.** Initiatives must be enabled in workspace settings ([Initiatives](https://linear.app/docs/initiatives)). The SLA row property only matters if SLAs are on.
- **View scope.** A view must be shared, or owned by you, to appear on your phone. Tabs come only from views attached to a team or project.

## Phone checklist

One pass on the iPhone settles every unknown above:

1. Open an issue view, open the display sheet, tap `Grouping`. Write down the list of fields.
2. On desktop, save a view grouped by Project and sub-grouped by Status. Open it on the phone. Note what renders.
3. Change `Grouping` on the phone. Check on desktop whether the view's default changed.
4. Open a custom project view on the phone, if it can be reached. Open its display sheet and look for `Grouping`, Initiative and Status.
5. Open a team's project list. Look for `Grouping` in its display sheet.
6. Open the product's initiative. Note whether it lists projects only.
7. Open the Favorites tab. Check that desktop folders appear, and try creating a folder.
8. Turn on Labels and Project as row properties. Find an issue with several labels and see what is cut off.
9. Favorite a label view on desktop and open it from the phone.

## Sources

- [Display options](https://linear.app/docs/display-options), Linear docs
- [Custom Views](https://linear.app/docs/custom-views), Linear docs
- [Favorites](https://linear.app/docs/favorites), Linear docs
- [Label views](https://linear.app/docs/label-views), Linear docs
- [Download Linear](https://linear.app/docs/get-the-app), Linear docs, the only docs section on the mobile apps
- [Initiatives](https://linear.app/docs/initiatives) and [Sub-initiatives](https://linear.app/docs/sub-initiatives), Linear docs
- [Teams](https://linear.app/docs/teams), Linear docs
- [Pricing](https://linear.app/pricing)
- Changelog: [Mobile Diffs, 2026-11-04](https://linear.app/changelog/2026-11-04-mobile-diffs)
- Changelog: [Customize your navigation in Linear Mobile, 2026-01-22](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile)
- Changelog: [Asks fields and Triage routing, 2025-06-05](https://linear.app/changelog/2025-06-05-asks-fields-and-triage-routing)
- Changelog index pages [2](https://linear.app/changelog/page/2), [3](https://linear.app/changelog/page/3), [4](https://linear.app/changelog/page/4), [5](https://linear.app/changelog/page/5), [6](https://linear.app/changelog/page/6), for entries dated 2025-03-06, 2025-04-03, 2025-07-17, 2025-10-23, 2026-02-05 and 2026-05-14. Index pages shift as new entries land; search the changelog by date if a link no longer shows the entry.

The changelog was read through fetched page summaries, not line by line. A mobile bullet outside the search terms (view, display, group, favorite, folder, pin, tab, label, initiative) could have been missed.
