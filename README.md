# EdVise

## Google Drive file picker

The chat input includes a Google Drive button that opens the Google Picker to choose CSV, Excel, PDF, or Word files. To use it:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Drive API** and **Google Picker API**.
3. Create an **OAuth 2.0 Client ID** (Web application) and add your app’s origin (e.g. `http://localhost:5173`).
4. Create an **API key** (restrict it to your origins and the APIs above).
5. For the Picker **App ID**, use the numeric **Project number** from the project dashboard (GCP IAM & Admin → Settings).
6. Copy `frontend/.env.example` to `frontend/.env` and set:
   - `VITE_GOOGLE_CLIENT_ID` — OAuth client ID
   - `VITE_GOOGLE_API_KEY` — API key
   - `VITE_GOOGLE_APP_ID` — project number

If these are unset, the Drive button may fail until the environment is configured.
