# Blisspool

A carpool organizer for a trusted group (family/school/team) — no login, no password, no third-party account required.

Stack: React + Vite frontend, Netlify Functions + Netlify Blobs for the backend (a real shared server-side store, not just `localStorage`), hosted on Netlify with GitHub auto-deploy.

## How identity works

There's no real auth. On first visit you pick a name (checked for uniqueness) and set up a profile — kids, car seats, address. Typing an already-taken name "logs you back in" as that person (no password check) — intentional for a small trusted group, not meant to be secure against someone maliciously impersonating another member.

## Core concepts

- **Carpools** are organized per kid — each kid on your profile gets its own section ("Jack's Carpools"), and joining/creating always happens in that context.
- Each carpool has a **day, destination address, and separate drop-off/pick-up times+drivers** — driver assignment is a distinct action from carpool membership, and any member can reassign either driver.
- **Co-parents** can link their profiles (from the profile editor) so that joining/starting a carpool for a shared kid automatically adds the other parent too — never automatically marked as driving, that's always an explicit per-person choice.

## Local development

Requires the [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm install -g netlify-cli`, or use `npx netlify-cli`) since the backend is Netlify Functions, not just a static site — plain `vite`/`npm run dev` won't serve the API routes.

```bash
npm install
npx netlify-cli dev
```

Open the printed URL (typically `http://localhost:8888`, not the Vite default 5173).

Local `netlify dev` uses its own local Blobs store (in `.netlify/`, gitignored) completely separate from the production store — testing and wiping data locally never touches real production data, and vice versa.

## Deploying

This repo is connected to Netlify via GitHub. Any push to `main` auto-deploys — `netlify.toml` has the build command (`npm run build`) and publish dir (`dist`) configured. Netlify Blobs data persists independently of deploys; pushing new code never wipes it.

## How it works

- `src/useProfile.ts` — the visitor's local identity (name/kids/seats/address) in `localStorage`, plus a stable random member id.
- `src/ProfileGate.tsx` — first-visit signup (name → kids/address/seats), handles the "already taken name" recovery flow.
- `src/ProfileEditor.tsx` — edit your profile later; also where you invite/link a co-parent.
- `src/CarpoolsPage.tsx` / `src/CarpoolDetail.tsx` — the per-kid carpool list, and a single carpool's schedule/members/driver assignment.
- `netlify/functions/*.mts` — the backend: carpools (create/list), join, schedule updates, name claiming, and household (co-parent) linking, all backed by a single Netlify Blobs store named `carpools`.
