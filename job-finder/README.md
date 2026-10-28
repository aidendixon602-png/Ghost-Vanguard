# Modesto Job Finder — 95355 (No-Car Friendly)

A small program to **manage a job search near Modesto, CA 95355**: pick a job
type, click through to apply on trusted sites from the Stanislaus County
Workforce guide, and track every application in one place.

Built for someone **without a car**: remote, walkable and bus-friendly jobs
come first, far-away jobs are tagged `🚗 Usually needs a car`, and every
saved job has a **🚌 Bus route** button (StanRTA / Google Maps transit).

## Run it

Either way works — pick one:

```bash
npm run jobs          # from the repo root, then open the printed URL
```

…or just **double-click `index.html`** in this folder. No account, no
install, no internet needed except to open the job sites themselves.

## What it does

1. **Find jobs** — type a job (or tap a chip: retail, warehouse, caregiver,
   remote customer service…) and every board opens pre-filled with
   *job + Modesto, CA 95355*: Indeed, Google Jobs, ZipRecruiter, Snagajob,
   CalJOBS, Stanislaus County, City of Modesto, Sutter, Kaiser, and more —
   28 searchable sites plus the full ~70-site directory from the
   [Stanislaus Workforce PDF](https://stanworkforce.com/media/zonmxzhn/job-search-website-resources.pdf),
   organized into big boards, local/government, direct employers, specialty,
   veteran and retiree sites.
2. **My tracker** — save jobs, move them Saved → Applied → Interview →
   Offer, set follow-up dates (overdue ones turn red), notes, pay, priority
   and transport. Export to CSV, back up / restore as JSON, print a plan.
3. **Weekly plan** — a Mon–Sun checklist (checkmarks are saved) tuned for
   searching without a car.

## Your data

Everything is saved in your browser on this device (`localStorage`, key
`modesto-job-finder-v1`). Nothing is sent anywhere. Use **⬇ Backup**
before clearing browser data or switching devices.

## Why search links instead of a built-in job list?

Job sites don't offer a free live feed, and a copied list goes stale in
days. Instead, each button builds a *live* search on the real site, so
results are always current — the same strategy the Workforce guide teaches
("type *job title + job city, state* into Google Jobs"), done for you in
one click.
