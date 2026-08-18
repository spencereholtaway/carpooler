# Carpooler

A small multi-user carpool organizer: each visitor gets a profile (name, car seats, kids), posts a trip as a driver, or joins a trip as a rider.

Stack: React + Vite (frontend), Firebase Anonymous Auth (no login screen, no password) + Firestore (database), hosted free on Netlify.

There's no login UI on purpose: the first time someone opens the app it silently assigns their browser a unique ID, then asks them to set up a profile (name, seats, kids). That ID lives in the browser (localStorage), so **the same person on a different browser or device gets treated as a new user** and has to set up their profile again — fine for a small trusted group where everyone knows each other, not "real" identity/security. If that stops being fine, swap in Google sign-in later (the code is a small change).

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com and create a new project (Google Analytics is optional, skip it).
2. In the project, click **Build > Authentication > Get started**, then enable the **Anonymous** sign-in provider.
3. Click **Build > Firestore Database > Create database**, start in production mode, pick any region.
4. In **Project settings > General**, scroll to "Your apps", click the **Web** (`</>`) icon, register an app (no hosting needed).
5. Copy the `firebaseConfig` values it gives you.

## 2. Configure the app locally

```bash
cp .env.example .env
```

Fill in `.env` with the values from step 1 (`VITE_FIREBASE_API_KEY`, etc).

```bash
npm install
npm run dev
```

Open the local URL it prints — you'll be prompted to set up a profile on first visit.

## 3. Deploy the Firestore security rules

The rules in `firestore.rules` restrict trips so only the driver can edit/delete their trip, and other signed-in users can only join/leave (touch the `riders` field). Deploy them with the [Firebase CLI](https://firebase.google.com/docs/cli):

```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # select your project, keep firestore.rules when asked
firebase deploy --only firestore:rules
```

## 4. Deploy to Netlify (free, no custom domain needed)

1. Push this repo to GitHub.
2. In [Netlify](https://app.netlify.com), "Add new site" > "Import an existing project" > pick the repo.
3. Build command `npm run build`, publish directory `dist` (already set in `netlify.toml`).
4. Under **Site configuration > Environment variables**, add the same `VITE_FIREBASE_*` variables from your `.env`.
5. Deploy. You'll get a free `*.netlify.app` URL — no extra Firebase config needed since there's no OAuth redirect to authorize.

## How it works

- `src/firebase.ts` — Firebase app/auth/Firestore setup, reading config from env vars.
- `src/AuthContext.tsx` — silent anonymous sign-in, exposes the current user via `useAuth()`.
- `src/useProfile.ts` / `src/ProfileForm.tsx` — per-user profile (name, seats, kids) stored at `profiles/{uid}`.
- `src/useTrips.ts` — Firestore reads/writes for trips (create, live list, join, leave, delete).
- `src/NewTripForm.tsx` / `src/TripCard.tsx` — the two pieces of trip UI.

Trips are stored in a single `trips` collection; each trip document holds an array of riders (`{ uid, name }`). This is fine at small scale (a family/team/school carpool); if this grows into an app with hundreds of riders per trip, riders would move to a subcollection instead.

## Next steps (not built yet)

- Recurring/weekly trips
- Restricting sign-up to a specific group instead of anyone who's signed in
- Notifications on join/cancel
