# RecHound Tasks

A standalone, mobile-friendly page for viewing and adding tasks — meant to be reachable from your phone, anywhere, without running the full RecHound tracker.

It's the same Tasks tab from the main [rechound-marketing](https://github.com/aunt-tim/rechound-marketing) tracker, pulled out on its own. No revenue data, CRM, or Stripe/Claude keys live here — just the task tree.

## Syncing with the main tracker

This page syncs to the **same** `rechound-state.json` file in your Google Drive that the main tracker uses, but only ever reads/writes the `tasks-nodes` and `tasks-priorityOrder` keys inside it — it merges onto whatever's already there, so it can't touch your CRM or revenue data.

To connect it:

1. Click **☁ Connect Drive** in the header (same button as the main app).
2. Sign in with the same Google account you use on the main tracker.
3. Tasks added here will show up in the main tracker's Tasks tab next time it syncs, and vice versa.

### One-time setup: authorize this URL with Google

The Drive connection uses a Google OAuth **Client ID**, which only allows sign-ins from URLs you've explicitly approved (its "Authorized JavaScript origins"). The default client ID baked into this page is the same one the main tracker uses, which is currently only approved for `http://localhost:3000`.

Before Drive sync will work from the published URL, add this site's URL as an authorized origin:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Open the OAuth 2.0 Client ID used by RecHound (client ID ending in `...apps.googleusercontent.com`, same one shown pre-filled in the "Connect Drive" dialog here).
3. Under **Authorized JavaScript origins**, add this page's published URL (e.g. `https://<your-username>.github.io`).
4. Save. Changes can take a few minutes to a few hours to take effect.

If you'd rather not modify the shared client ID, you can create your own OAuth Client ID in Google Cloud Console (Application type: Web application) and paste it into the "OAuth Client ID" field in the Connect Drive dialog here — it'll be remembered on this device.

## Local development

```
npx serve .
```

No build step — it's plain HTML/CSS/JS.
