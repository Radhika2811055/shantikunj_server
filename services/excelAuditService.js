const fs = require('fs')
const path = require('path')
const XLSX = require('xlsx')

const DEFAULT_WORKBOOK_PATH = path.join(__dirname, '..', 'exports', 'workflow-audit.xlsx')

const TRANSLATION_SHEET = 'TranslationConversions'
const AUDIO_SHEET = 'AudioGenerations'

const TRANSLATION_HEADERS = [
  'Timestamp',
  'Event',
  'BookObjectId',
  'BookNumber',
  'BookTitle',
  'VersionObjectId',
  'Language',
  'SubmittedByUserId',
  'SubmittedByName',
  'SubmittedByEmail',
  'TextFileUrls'
]

const AUDIO_HEADERS = [
  'Timestamp',
  'Event',
  'BookObjectId',
  'BookNumber',
  'BookTitle',
  'VersionObjectId',
  'Language',
  'SubmittedByUserId',
  'SubmittedByName',
  'SubmittedByEmail',
  'AudioFileUrls'
]

const resolveWorkbookPath = () => {
  const configuredPath = String(process.env.EXCEL_AUDIT_PATH || '').trim()
  if (!configuredPath) return DEFAULT_WORKBOOK_PATH
  if (path.isAbsolute(configuredPath)) return configuredPath
  return path.join(__dirname, '..', configuredPath)
}

const ensureSheet = (workbook, sheetName, headers) => {
  const existing = workbook.Sheets[sheetName]
  if (!existing) {
    const newSheet = XLSX.utils.aoa_to_sheet([headers])
    XLSX.utils.book_append_sheet(workbook, newSheet, sheetName)
    return
  }

  const rows = XLSX.utils.sheet_to_json(existing, { header: 1, blankrows: false })
  const firstRow = Array.isArray(rows[0]) ? rows[0] : []
  const hasValidHeader = headers.every((header, index) => String(firstRow[index] || '').trim() === header)

  if (!hasValidHeader) {
    const repairedRows = [headers, ...rows.filter((row, index) => index > 0)]
    workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(repairedRows)
  }
}

const loadWorkbook = (filePath) => {
  if (fs.existsSync(filePath)) {
    return XLSX.readFile(filePath)
  }

  return XLSX.utils.book_new()
}

const appendRow = (sheet, values) => {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  rows.push(values)
  return XLSX.utils.aoa_to_sheet(rows)
}

const writeAuditRow = (sheetName, headers, values) => {
  const workbookPath = resolveWorkbookPath()
  fs.mkdirSync(path.dirname(workbookPath), { recursive: true })

  const workbook = loadWorkbook(workbookPath)
  ensureSheet(workbook, TRANSLATION_SHEET, TRANSLATION_HEADERS)
  ensureSheet(workbook, AUDIO_SHEET, AUDIO_HEADERS)

  const existingSheet = workbook.Sheets[sheetName]
  workbook.Sheets[sheetName] = appendRow(existingSheet, values)

  XLSX.writeFile(workbook, workbookPath)
}

const appendTranslationConversionRecord = ({ book, version, submittedBy, textUrls = [] }) => {
  const timestamp = new Date().toISOString()

  writeAuditRow(TRANSLATION_SHEET, TRANSLATION_HEADERS, [
    timestamp,
    'translation_submitted',
    String(book?._id || ''),
    String(book?.bookNumber ?? ''),
    String(book?.title || ''),
    String(version?._id || ''),
    String(version?.language || ''),
    String(submittedBy?._id || ''),
    String(submittedBy?.name || ''),
    String(submittedBy?.email || ''),
    Array.isArray(textUrls) ? textUrls.join(' | ') : ''
  ])
}

const appendAudioGenerationRecord = ({ book, version, submittedBy, audioUrls = [] }) => {
  const timestamp = new Date().toISOString()

  writeAuditRow(AUDIO_SHEET, AUDIO_HEADERS, [
    timestamp,
    'audio_submitted',
    String(book?._id || ''),
    String(book?.bookNumber ?? ''),
    String(book?.title || ''),
    String(version?._id || ''),
    String(version?.language || ''),
    String(submittedBy?._id || ''),
    String(submittedBy?.name || ''),
    String(submittedBy?.email || ''),
    Array.isArray(audioUrls) ? audioUrls.join(' | ') : ''
  ])
}

module.exports = {
  appendTranslationConversionRecord,
  appendAudioGenerationRecord
}
