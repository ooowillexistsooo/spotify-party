# Spotify Party

Put a QR code up at your party. Guests scan it with their phone camera, search for songs, and suggest them. Nothing is added until you tap **Add**; then the song goes straight onto your Spotify playlist.

- Guests don't need a Spotify account or an app. Searches run through the host's account.
- The host picks an existing playlist (one they own or collaborate on) or creates a new one for each party.
- Each party gets its own QR code, plus a full-screen view for a TV or tablet.
- Guests see whether each suggestion was added or skipped. Duplicate suggestions are blocked, and each guest can have at most 10 songs waiting.

## 1. Create a Spotify developer app

You need a **Spotify Premium** account; Spotify requires it for the owner of a development app.

1. Go to <https://developer.spotify.com/dashboard> and log in with your Spotify account.
2. Click **Create app**.
   - **App name / description:** anything, for example "Spotify Party".
   - **Redirect URI:** your app's public URL followed by `/callback`, for example `https://party.example.com/callback`. For trying it on your own computer, use `http://127.0.0.1:3000/callback` (Spotify doesn't allow `localhost`).
   - **Which API/SDKs are you planning to use?** Check **Web API**.
   - Accept the terms and click **Save**.
3. Open the app's **Settings** and copy the **Client ID**. Click **View client secret** and copy the **Client secret**.
4. Open **User Management** and add the name and email of each Spotify account that will *host* parties (up to 5). Guests don't need to be added.

## 2. Run it

Requires Node.js 22.13 or newer.

```sh
cp .env.example .env   # then fill in the values
npm install
npm start
```

| Variable | What it is |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | Client ID from step 1 |
| `SPOTIFY_CLIENT_SECRET` | Client secret from step 1 |
| `BASE_URL` | The public URL guests will open, such as `https://party.example.com`. It must match the redirect URI you registered (minus `/callback`). Defaults to `http://127.0.0.1:3000`. |
| `PORT` | Port to listen on (default `3000`) |
| `DB_PATH` | SQLite file for parties and suggestions (default `data/party.db`) |

Open `BASE_URL`, log in with Spotify, and start a party.

## 3. Put it online

Guests' phones must be able to reach the app, so for a real party, deploy it to any host that runs Node.js with a persistent disk (for the SQLite file) and HTTPS. Set `BASE_URL` to the deployed URL, and add `<BASE_URL>/callback` as a redirect URI in your Spotify app settings.
