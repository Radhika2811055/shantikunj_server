const { google } = require('googleapis')

const SHEET_HEADERS = [
  'Timestamp',
  'Hindi Book Name',
  'Language Name',
  'Translated Text',
  'Translated Text File URLs',
  'Audio Generated URLs',
  'SPOC Name',
  'SPOC Email',
  'SPOC Language',
  'SPOC User ID'
]

const parseBooleanEnv = (value, defaultValue = true) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return defaultValue
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return defaultValue
}

const getPrivateKey = () => {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '')
    .trim()

  if (!raw) return ''

  // Support keys copied as a single-line env var with escaped newlines.
  return raw.replace(/\\n/g, '\n')
}

const normalizeUrlList = (values = []) => {
  return [...new Set(
    values
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  )]
}

const isGoogleSheetConfigured = () => {
  if (!parseBooleanEnv(process.env.GOOGLE_SHEETS_ENABLED, true)) {
    return false
  }

  const spreadsheetId = String(process.env.GOOGLE_SHEET_ID || '').trim()
  const clientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()
  const privateKey = getPrivateKey()

  return Boolean(spreadsheetId && clientEmail && privateKey)
}

const createSheetsClient = async () => {
  const clientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()
  const privateKey = getPrivateKey()

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })

  await auth.authorize()

  return google.sheets({
    version: 'v4',
    auth
  })
}

const ensureWorksheetExists = async ({ sheets, spreadsheetId, sheetName }) => {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  })

  const titles = Array.isArray(metadata.data?.sheets)
    ? metadata.data.sheets.map((item) => String(item?.properties?.title || '').trim()).filter(Boolean)
    : []

  if (titles.includes(sheetName)) {
    return
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName
            }
          }
        }
      ]
    }
  })
}

const ensureHeaderIfEmpty = async ({ sheets, spreadsheetId, sheetName }) => {
  const headerRange = `'${sheetName}'!A1:J1`

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange
  })

  const firstRow = Array.isArray(existing.data?.values)
    ? existing.data.values[0]
    : null

  if (Array.isArray(firstRow) && firstRow.length > 0) {
    return
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: headerRange,
    valueInputOption: 'RAW',
    requestBody: {
      values: [SHEET_HEADERS]
    }
  })
}

const appendSpocApprovalRecord = async ({ book, version, spocUser }) => {
  if (!isGoogleSheetConfigured()) {
    return { skipped: true, reason: 'Google Sheets is disabled or not configured.' }
  }

  const spreadsheetId = String(process.env.GOOGLE_SHEET_ID || '').trim()
  const sheetName = String(process.env.GOOGLE_SHEET_NAME || 'SPOC Approvals').trim()

  const translatedTextFiles = normalizeUrlList([
    ...(Array.isArray(version?.publishedTextFileUrls) ? version.publishedTextFileUrls : []),
    ...(Array.isArray(version?.textFileUrls) ? version.textFileUrls : []),
    version?.publishedTextFileUrl,
    version?.textFileUrl
  ])

  const audioFiles = normalizeUrlList([
    ...(Array.isArray(version?.publishedAudioFiles) ? version.publishedAudioFiles : []),
    ...(Array.isArray(version?.audioFiles) ? version.audioFiles : []),
    version?.publishedAudioUrl,
    version?.audioUrl
  ])

  const translatedText = String(version?.publishedTranslatedText || version?.translatedText || '').trim()

  const row = [
    new Date().toISOString(),
    String(book?.title || '').trim(),
    String(version?.language || '').trim(),
    translatedText,
    translatedTextFiles.join(' | '),
    audioFiles.join(' | '),
    String(spocUser?.name || '').trim(),
    String(spocUser?.email || '').trim(),
    String(spocUser?.language || '').trim(),
    String(spocUser?._id || '').trim()
  ]

  const sheets = await createSheetsClient()

  await ensureWorksheetExists({
    sheets,
    spreadsheetId,
    sheetName
  })

  await ensureHeaderIfEmpty({
    sheets,
    spreadsheetId,
    sheetName
  })

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row]
    }
  })

  return { ok: true }
}

module.exports = {
  appendSpocApprovalRecord,
  isGoogleSheetConfigured
}
