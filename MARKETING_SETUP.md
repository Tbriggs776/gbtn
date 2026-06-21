# Marketing Integrations — Developer Account Setup

This guide walks you (GBTN) through registering the developer apps that let your
clients connect their own ad/analytics accounts in the portal **Settings** tab.

## How the model works (read this first)

- **You register ONE app per platform — as GBTN.** Not one per client.
- The app's credentials (client ID/secret) go into **Vercel environment
  variables, once**. They are never per-client and never shown to clients.
- Each **client** then clicks **"Connect"** in their portal Settings, signs in
  with *their* Google/Meta account, and grants read-only access to *their* ad
  data. They never see a developer account or an API key.
- We store each client's access tokens **encrypted in Supabase Vault** and use
  them only server-side to pull daily metrics. We only ever **read** data — we
  never change anything in a client's ad accounts.

When you finish a platform below, send me the credentials (or add them to Vercel
yourself) and I'll build + test that channel's Connect flow.

---

## Platform 1 — Google (covers GA4, Google Ads, and Business Profile)

One Google Cloud project + one OAuth client covers all three Google channels.

### A. Create the project + OAuth client
1. Go to https://console.cloud.google.com → create a new project (e.g.
   "GBTN Portal").
2. **APIs & Services → Library →** enable each of these:
   - **Google Analytics Data API** (GA4)
   - **Google Ads API**
   - **Business Profile API**
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**
   - App name: Growth by the Numbers; add your support email + domain
   - You can leave it in **"Testing"** mode to start — it works immediately for
     up to 100 connected accounts with no Google verification wait. (Move to
     "Production" later if you outgrow that; sensitive scopes then need Google's
     consent-screen verification, ~1–2 weeks.)
   - Add the scopes:
     - `https://www.googleapis.com/auth/analytics.readonly`
     - `https://www.googleapis.com/auth/adwords`
     - `https://www.googleapis.com/auth/business.manage`
   - Add yourself (and any test clients) as **Test users** while in Testing mode.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**
   - Authorized redirect URI (exact):
     `https://growthbythenumbers.com/api/oauth/google/callback`
   - (Optional, for local testing: `http://localhost:3000/api/oauth/google/callback`)
   - Create → copy the **Client ID** and **Client secret**.

### B. Google Ads developer token (needed for spend → ROAS)
1. Sign in to a **Google Ads manager (MCC) account** (create a free manager
   account if you don't have one: https://ads.google.com/home/tools/manager-accounts/).
2. **Tools → API Center →** apply for a **developer token**.
   - You'll immediately get **Test account** access (works only against test
     accounts).
   - Apply for **Basic access** to read real client accounts — Google reviews
     your use case. **Start this early; it's the longest wait.**
3. Copy the **developer token**.

### C. Business Profile API access (optional, for GBP calls/views)
- The Business Profile API often requires a short **access request form**
  (Google emails approval). Enable the API (step A2) and follow any prompt to
  request access. Not required for ROAS — do this last.

### Credentials to hand off (add to Vercel → Settings → Environment Variables, Production)
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_ADS_DEVELOPER_TOKEN=...        # once Basic access is granted
```

---

## Platform 2 — Meta (Facebook / Instagram Ads)

### A. Create the app
1. Go to https://developers.facebook.com → **My Apps → Create App**.
2. App type: **Business**.
3. In the app dashboard, **add the "Marketing API"** product.
4. **App settings → Basic:** add your **App Domain** (growthbythenumbers.com)
   and a Privacy Policy URL.
5. **Facebook Login → Settings →** add the OAuth redirect URI (exact):
   `https://growthbythenumbers.com/api/oauth/meta/callback`
6. Copy the **App ID** and **App Secret** (Settings → Basic).

### B. App Review + Business Verification (the gate)
- To read **real** clients' ad data you must:
  - Complete **Business Verification** (legal business name, address, docs).
  - Submit **App Review** requesting the **`ads_read`** permission. Meta may ask
    for a screencast showing the connect + read flow.
- This can take **days to a few weeks**. While pending, you can test against ad
  accounts you own / are an admin of using a dev token.
- **Start this early; it's the second longest wait after Google Ads.**

### Credentials to hand off (Vercel env, Production)
```
META_APP_ID=...
META_APP_SECRET=...
```

---

## Summary checklist

- [ ] Google Cloud project created
- [ ] Enabled: Analytics Data API, Google Ads API, Business Profile API
- [ ] OAuth consent screen configured (Testing mode + scopes + test users)
- [ ] OAuth Web client created with the `/api/oauth/google/callback` redirect
- [ ] `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` added to Vercel
- [ ] Google Ads **developer token** applied for (Basic access) → `GOOGLE_ADS_DEVELOPER_TOKEN`
- [ ] Meta Business app created + Marketing API added
- [ ] Meta `/api/oauth/meta/callback` redirect added
- [ ] `META_APP_ID` + `META_APP_SECRET` added to Vercel
- [ ] Meta Business Verification + `ads_read` App Review submitted

## What I do once each is ready

1. **Google client ID/secret in Vercel** → I build the Google **Connect** button
   + **GA4 sync**, and we test live (Testing mode is fine).
2. **Google Ads dev token granted** → I add Google Ads **spend** import → **ROAS**
   goes live on the Marketing dashboard.
3. **Meta App Review cleared** → I add Meta Ads spend.

Each reuses the existing framework (Vault token storage, the daily sync cron,
the per-client Connect card in Settings) — so each is quick to wire once
unblocked. ROAS = imported revenue ÷ ad spend; booking rate = jobs ÷ leads.

## Timeline reality

- **Today / same day:** Google Cloud project, OAuth client, GA4 (Testing mode).
- **Days–weeks:** Google Ads Basic access; Meta App Review + Business
  Verification. Start both as early as possible — they run in parallel.
