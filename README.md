# Server (Express API)

Backend service for the Shantikunj workflow platform.

## Tech

- Express 5
- Mongoose
- JWT auth
- Passport Google OAuth (optional)
- Multer uploads
- Node-cron scheduled follow-up job

## Setup

### 1) Install dependencies

```powershell
npm install
```

### 2) Configure environment

Create `.env` in this folder from `.env.example`.

Required:

- `MONGO_URI`
- `JWT_SECRET`
- `SESSION_SECRET`

Optional but recommended for email/notifications:

- `EMAIL_USER`
- `EMAIL_PASS`
- `SUPPORT_CONTACT_EMAIL`

Optional for frontend links in emails:

- `FRONTEND_URL` (default fallback in code: `http://localhost:5173`)

Optional for Google login:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`

Optional workflow behavior:

- `TRANSLATION_INVITE_LANGUAGES`
- `PORT` (defaults to `5000`)
- `CORS_ORIGINS` (comma-separated allowed origins)
- `EXCEL_AUDIT_PATH` (local XLSX audit trail for translation/audio submissions)

Optional for SPOC approval logs in Google Sheets:

- `GOOGLE_SHEETS_ENABLED` (`true` by default)
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_NAME` (default `SPOC Approvals`)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (single-line env var with `\\n` line breaks)

### 3) Run

```powershell
npm run dev
```

Server URL: `http://localhost:5000`

## Scripts

- `npm start` - start server
- `npm run dev` - run with watch mode
- `npm test` - placeholder

## API Route Groups

All routes are mounted under `/api`.

- `/api/auth` - register/login/profile/password reset/google callback
- `/api/admin` - admin approval and user management
- `/api/books` - workflow operations, assignments, uploads, approvals
- `/api/claims` - role claims and claim history
- `/api/feedback` - version feedback and summaries
- `/api/notifications` - notification inbox management
- `/api/support` - support request lifecycle
- `/api/audit` - audit logs for admin/spoc

## Uploads

- Static files served from `/uploads`
- Folder locations:
  - `uploads/translations`
  - `uploads/audio`

## Scheduler

Daily follow-up job configured in `index.js`:

- Cron: `0 9 * * *` (9:00 AM server time)
- Claim assistance reminder cadence: every 2 days per active claim

## Google Sheet Sync (SPOC approvals)

When a SPOC gives final audio approval, the backend appends one row to Google Sheets with:

- Hindi book name
- Language name
- Translated text and translated file links
- Generated audio links
- SPOC details (name, email, language, user ID)

Setup steps:

1. Create a Google Cloud service account and enable the Google Sheets API.
2. Create a Google Sheet and note its Sheet ID from the URL.
3. Share that Google Sheet with the service account email as **Editor**.
4. Fill the Google Sheet env vars in `.env`.
5. Restart the server.

## Auth & Access Model

Middleware:

- `protect` - verifies JWT and loads user
- `authorise(...)` - role-based access control

Main roles in the system:

- admin
- spoc
- translator
- checker
- recorder
- audio_checker
- regional_team

## Notes for Production Hardening

1. Configure `SESSION_SECRET` separately from `JWT_SECRET`.
2. Set `CORS_ORIGINS` explicitly to trusted frontend domains.
3. Add request validation for all mutation endpoints.
4. Expand API integration tests and role-based authorization tests.
