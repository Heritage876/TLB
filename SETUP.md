# Mobile app and shared online data setup

## Install on phones

This is a responsive, installable web app (PWA), not a separate App Store binary. Host the project on an HTTPS static host such as GitHub Pages, Netlify, or Vercel; service workers and installation do not work from `file://`. Open the hosted URL on the phone, then:

- **Android / Chrome:** use the in-app **Install app** button when offered, or Chrome menu → **Install app** / **Add to Home screen**.
- **iPhone / iPad:** open the URL in Safari → Share → **Add to Home Screen**.

The service worker caches the app shell for offline opening. Shared changes need an internet connection.

## Configure shared cloud data with Supabase

1. Create a Supabase project.
2. In **Authentication → Providers → Email**, turn off email confirmations. This app uses the member index number for sign-in and creates a private synthetic email address for Supabase Auth; it does not collect email addresses.
3. In **SQL Editor**, run the contents of `supabase-schema.sql` once. The table can be read and edited only by signed-in users. New members are allowed to register, so only share the app URL with the intended study group.
4. In **Project Settings → API**, copy the Project URL and the anon/publishable key into `cloud-config.js` (`supabaseUrl` and `supabaseAnonKey`). These browser keys are public by design; never use a `service_role` key here.
5. Deploy the whole project folder to an HTTPS host. Test registration, sign-in, and creating chat messages, announcements, and timetable entries from a second browser/device. The app polls for changes and displays the sync state in its top bar.

Cloud accounts and data are shared in the same study-group table. Passwords are handled by Supabase Auth and are not uploaded in the member records. Existing accounts created before cloud setup remain local-only; members must register again after cloud is configured. Do not enable public/anonymous table policies.

Until cloud configuration is added, the app continues to work in this browser using local storage and will show **Local only — cloud not configured**.
