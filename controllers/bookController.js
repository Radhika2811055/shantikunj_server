const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const Book = require('../models/Book')
const User = require('../models/User')
const Claim = require('../models/Claim')
const sendMailRaw = require('../config/mailer')
const { createNotification, createBulkNotifications } = require('../services/notificationService')
const { logAudit } = require('../services/auditService')
const { appendTranslationConversionRecord, appendAudioGenerationRecord } = require('../services/excelAuditService')
const { appendSpocApprovalRecord } = require('../services/googleSheetService')
const { TRANSLATION_LANGUAGES } = require('../constants/languages')
const { uploadToCloudinary } = require('../middleware/uploadMiddleware')

let transliterateText = (value) => String(value || '')
try {
  ;({ transliterate: transliterateText } = require('transliteration'))
} catch (_error) {
  // Optional dependency fallback: plain text matching only.
}

const REASSIGNMENT_THRESHOLD = 3
const MIN_DIRECT_ASSIGNMENT_UNCLAIMED_DAYS = 3
const DEFAULT_TRANSLATION_INVITE_LANGUAGES = ['all']
const LANGUAGE_TEAM_ROLES = ['spoc', 'translator', 'checker', 'audio_checker', 'recorder', 'regional_team']
const FRONTEND_BASE_URL = String(process.env.FRONTEND_URL || 'http://localhost:5173').trim().replace(/\/+$/, '')
const DATA_SOURCE_DIR = path.join(__dirname, '..', 'data_source')
const MIN_PDF_FILE_MATCH_SCORE = 40
const ALLOWED_WORKFLOW_EMAIL_SUBJECT_PATTERNS = [
  /new translation task/i,
  /published!/i
]

const isWorkflowEmailAllowed = (mailPayload) => {
  const subject = String(mailPayload?.subject || '').trim()
  if (!subject) return false
  return ALLOWED_WORKFLOW_EMAIL_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject))
}

const sendMail = async (mailPayload) => {
  if (!isWorkflowEmailAllowed(mailPayload)) {
    return {
      sent: false,
      skipped: true,
      skippedByPolicy: true,
      error: 'Email skipped by policy'
    }
  }

  return sendMailRaw(mailPayload)
}

const DIRECT_ASSIGNABLE_STAGE_CONFIG = {
  translation: {
    claimType: 'translation',
    requiredRole: 'translator',
    assigneeField: 'assignedTranslator',
    deadlineField: 'translatorDeadline',
    progressField: 'textStatus',
    allowedProgressValues: ['not_started', 'translation_in_progress'],
    assignedProgressValue: 'translation_in_progress',
    stageLabel: 'Translation'
  },
  checking: {
    claimType: 'checking',
    requiredRole: 'checker',
    assigneeField: 'assignedChecker',
    deadlineField: 'checkerDeadline',
    progressField: 'textStatus',
    allowedProgressValues: ['translation_submitted', 'checking_in_progress'],
    assignedProgressValue: 'checking_in_progress',
    stageLabel: 'Text Vetting'
  },
  audio_generation: {
    claimType: 'audio',
    requiredRole: 'recorder',
    assigneeField: 'assignedRecorder',
    deadlineField: 'recorderDeadline',
    progressField: 'audioStatus',
    allowedProgressValues: ['not_started', 'audio_generated'],
    assignedProgressValue: 'audio_generated',
    stageLabel: 'Audio Generation'
  },
  audio_checking: {
    claimType: 'audio_check',
    requiredRole: 'audio_checker',
    assigneeField: 'assignedAudioChecker',
    deadlineField: 'audioCheckerDeadline',
    progressField: 'audioStatus',
    allowedProgressValues: ['audio_submitted', 'audio_checking_in_progress'],
    assignedProgressValue: 'audio_checking_in_progress',
    stageLabel: 'Audio Verification'
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getInitialInviteLanguageSet = () => {
  const raw = String(process.env.TRANSLATION_INVITE_LANGUAGES || '').trim()
  const values = (raw ? raw.split(',') : DEFAULT_TRANSLATION_INVITE_LANGUAGES)
    .map((item) => String(item || '').trim())
    .filter(Boolean)

  const normalized = new Set(values.map((item) => item.toLowerCase()))
  const allowAll = normalized.has('all')

  return {
    allowAll,
    normalized
  }
}

const sendMailWithRetry = async (mailPayload, maxAttempts = 3) => {
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await sendMail(mailPayload)
      if (result?.sent) {
        return { ok: true, attempts: attempt }
      }

      if (result?.skippedByPolicy) {
        return { ok: true, skipped: true, attempts: attempt }
      }

      const fallbackMessage = result?.skipped
        ? 'Email skipped: EMAIL_USER/EMAIL_PASS missing'
        : 'Mail dispatch failed'
      lastError = new Error(result?.error || fallbackMessage)
      if (result?.details) {
        lastError.details = result.details
      }

      if (result?.skipped) {
        return { ok: false, attempts: attempt, error: lastError }
      }
    } catch (error) {
      lastError = error
    }

    if (attempt < maxAttempts) {
      await wait(900 * attempt)
    }
  }

  return { ok: false, attempts: maxAttempts, error: lastError }
}

const sendTranslationClaimInvites = async (book) => {
  const inviteLanguageConfig = getInitialInviteLanguageSet()

  const inviteSummary = {
    languagesOpenedForClaim: 0,
    languagesWithRecipients: 0,
    languagesInvited: [],
    languagesWithoutRecipients: [],
    languagesSkippedByConfig: [],
    totalEmailsAttempted: 0,
    totalEmailsSent: 0,
    totalEmailsFailed: 0,
    failedEmails: []
  }

  for (const version of book.languageVersions || []) {
    const versionLanguage = String(version.language || '').trim()
    const isConfiguredLanguage = inviteLanguageConfig.allowAll || inviteLanguageConfig.normalized.has(versionLanguage.toLowerCase())

    if (!isConfiguredLanguage) {
      version.interestEmailSent = false
      version.interestEmailSentAt = null
      inviteSummary.languagesSkippedByConfig.push(versionLanguage)
      continue
    }

    const recipients = await User.find({
      language: version.language,
      role: { $in: ['translator', 'spoc'] },
      status: 'approved',
      isActive: true
    }).select('name email role')

    if (recipients.length === 0) {
      version.interestEmailSent = false
      version.interestEmailSentAt = null
      inviteSummary.languagesWithoutRecipients.push(version.language)
      continue
    }

    inviteSummary.languagesOpenedForClaim += 1
    // Keep task claimable even if mail dispatch is skipped/failed.
    version.interestEmailSent = true
    version.interestEmailSentAt = new Date()

    inviteSummary.languagesWithRecipients += 1

    await createBulkNotifications({
      userIds: recipients.map((member) => member._id),
      type: 'task',
      title: 'New translation task available',
      message: `${book.title} (${version.language}) is open for claim.`,
      metadata: {
        bookId: book._id,
        versionId: version._id,
        language: version.language,
        stage: 'translation'
      }
    })

    inviteSummary.totalEmailsAttempted += recipients.length

    let sentCount = 0
    for (const member of recipients) {
      const recipientRoleLabel = member.role === 'spoc' ? 'SPOC' : 'translator'
      const sendResult = await sendMailWithRetry({
        to: member.email,
        subject: `New Translation Task - ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${member.name}</strong>,</p>
            <p>A new book has been added and is now open for translation claim.</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Book Number:</strong> ${book.bookNumber}<br/>
              <strong>Language:</strong> ${version.language}<br/>
              <strong>Role:</strong> ${recipientRoleLabel}<br/>
              <strong>Task Stage:</strong> Translation
            </div>
            <p>Login to LMS and claim this task from Work Queue. The first eligible claimant gets assigned.</p>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Claim
            </a>
            <p style="color: #888; font-size: 12px; margin-top: 14px;">
              This is an automated message from Shantikunj LMS.
            </p>
          </div>
        `
      })

      if (sendResult.ok) {
        sentCount += 1
      } else {
        inviteSummary.failedEmails.push({
          language: version.language,
          role: member.role,
          email: member.email,
          attempts: sendResult.attempts,
          reason: sendResult.error?.message || 'Unknown mail error'
        })
      }

      // Tiny pacing helps avoid provider burst throttling on sequential invite sends.
      await wait(180)
    }

    const failedCount = recipients.length - sentCount

    inviteSummary.totalEmailsSent += sentCount
    inviteSummary.totalEmailsFailed += failedCount

    if (sentCount > 0) {
      inviteSummary.languagesInvited.push(version.language)
    }
  }

  await book.save()
  return inviteSummary
}

const isValidHttpUrl = (value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch (_error) {
    return false
  }
}

const isLikelyLocalUploadPath = (value) => /^(\/|\.\/)?(uploads|data_source)\//i.test(String(value || '').trim())

const isGoogleDriveLink = (value) => value.includes('drive.google.com')
const isDocumentLink = (value) => /\.(pdf|doc|docx|txt)(\?|$)/i.test(value) || isGoogleDriveLink(value)
const isAudioLink = (value) => /\.(mp3|mp4)(\?|$)/i.test(value) || isGoogleDriveLink(value)

const normalizeStoredUrls = (values = []) => {
  return [...new Set(
    values
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  )]
}

const asArray = (value) => (Array.isArray(value) ? value : [])

const sanitizeOptionalString = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

const toSearchableText = (value) => {
  const normalized = sanitizeOptionalString(String(value || ''))
  if (!normalized) return ''

  const transliterated = sanitizeOptionalString(transliterateText(normalized)) || normalized
  return transliterated
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const tokenizeSearchText = (value) => {
  const normalized = toSearchableText(value)
  if (!normalized) return []
  return normalized.split(' ').filter((token) => token.length >= 4)
}

const toConsonantSignature = (value) => {
  const normalized = toSearchableText(value)
  if (!normalized) return ''

  return normalized
    .replace(/[aeiou]/g, '')
    .replace(/(.)\1+/g, '$1')
}

const sanitizeOptionalSize = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed)
}

const sanitizeOptionalDate = (value) => {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

const sanitizeBookNumberCode = (value) => {
  if (value === undefined || value === null) return null

  const normalized = String(value).trim().toUpperCase()
  if (!normalized) return null
  if (normalized.length > 64) return null
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(normalized)) return null

  return normalized
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const toSafeCloudinaryPathPart = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

const extractFileExtension = (value) => {
  const fileName = String(value || '').trim()
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === fileName.length - 1) return ''
  return fileName.slice(lastDot)
}

const inferDocumentExtensionFromMimeType = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized === 'application/pdf') return '.pdf'
  if (normalized === 'application/msword') return '.doc'
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx'
  if (normalized === 'text/plain') return '.txt'
  return ''
}

const isFileUrlForKind = (url, kind) => {
  if (kind === 'audio') return isAudioLink(url)
  return isDocumentLink(url)
}

const sanitizeFileMetadataEntry = (entry, kind) => {
  if (!entry || typeof entry !== 'object') return null

  const url = sanitizeOptionalString(entry.url)
  if (!url || !isValidHttpUrl(url) || !isFileUrlForKind(url, kind)) return null

  return {
    url,
    fileName: sanitizeOptionalString(entry.fileName || entry.filename || entry.originalName),
    mimeType: sanitizeOptionalString(entry.mimeType || entry.mimetype),
    size: sanitizeOptionalSize(entry.size),
    cloudinaryId: sanitizeOptionalString(entry.cloudinaryId || entry.publicId || entry.public_id),
    resourceType: sanitizeOptionalString(entry.resourceType || entry.resource_type),
    format: sanitizeOptionalString(entry.format),
    uploadedAt: sanitizeOptionalDate(entry.uploadedAt),
    uploadedBy: entry.uploadedBy || null
  }
}

const mergeMetadataEntriesByUrl = (entries = []) => {
  const mergedByUrl = new Map()

  for (const entry of entries) {
    if (!entry?.url) continue

    const existing = mergedByUrl.get(entry.url)
    if (!existing) {
      mergedByUrl.set(entry.url, { ...entry })
      continue
    }

    const next = { ...existing }
    const keys = ['fileName', 'mimeType', 'size', 'cloudinaryId', 'resourceType', 'format', 'uploadedAt', 'uploadedBy']
    for (const key of keys) {
      if (entry[key] !== null && entry[key] !== undefined && entry[key] !== '') {
        next[key] = entry[key]
      }
    }
    mergedByUrl.set(entry.url, next)
  }

  return [...mergedByUrl.values()]
}

const normalizeFileMetadata = ({ metadata = [], urls = [], kind }) => {
  const fromMetadata = asArray(metadata)
    .map((entry) => sanitizeFileMetadataEntry(entry, kind))
    .filter(Boolean)

  const fromUrls = normalizeStoredUrls(urls)
    .map((url) => sanitizeFileMetadataEntry({ url }, kind))
    .filter(Boolean)

  return mergeMetadataEntriesByUrl([...fromUrls, ...fromMetadata])
}

const stampMetadataForSave = (entries = [], uploadedBy = null) => {
  const now = new Date()
  return entries.map((entry) => ({
    ...entry,
    uploadedAt: entry.uploadedAt || now,
    uploadedBy: entry.uploadedBy || uploadedBy || null
  }))
}

const buildUploadMetadata = ({ result, file, kind, uploadedBy = null }) => {
  const parsedAsset = parseCloudinaryDeliveryUrl(result?.secure_url || '')

  const metadata = sanitizeFileMetadataEntry({
    url: result?.secure_url,
    fileName: file?.originalname,
    mimeType: file?.mimetype,
    size: file?.size ?? result?.bytes,
    cloudinaryId: result?.public_id,
    resourceType: result?.resource_type || parsedAsset?.resourceType,
    format: result?.format || parsedAsset?.format,
    uploadedAt: result?.created_at || new Date(),
    uploadedBy
  }, kind)

  return metadata
}

const normalizeAudioUrls = ({ audioUrl, audioUrls }) => {
  const fromArray = Array.isArray(audioUrls) ? audioUrls : []
  const fromSingle = audioUrl ? [audioUrl] : []

  const merged = [...fromArray, ...fromSingle]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)

  return [...new Set(merged)]
}

const normalizeDocumentUrls = ({ textFileUrl, textFileUrls }) => {
  const fromArray = Array.isArray(textFileUrls) ? textFileUrls : []
  const fromSingle = textFileUrl ? [textFileUrl] : []

  const merged = [...fromArray, ...fromSingle]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)

  const unique = [...new Set(merged)]
  return unique.filter((item) => isValidHttpUrl(item) && isDocumentLink(item))
}

const normalizeAccessibleDocumentUrls = ({ textFileUrl, textFileUrls }) => {
  const fromArray = Array.isArray(textFileUrls) ? textFileUrls : []
  const fromSingle = textFileUrl ? [textFileUrl] : []

  const merged = [...fromArray, ...fromSingle]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)

  const unique = [...new Set(merged)]
  return unique.filter((item) => isValidHttpUrl(item))
}

const normalizeSourcePdfReference = (candidate) => {
  const normalized = sanitizeOptionalString(candidate)
  if (!normalized) return null

  if (isValidHttpUrl(normalized)) {
    return normalized
  }

  if (/^\/\//.test(normalized)) {
    return `https:${normalized}`
  }

  if (isLikelyLocalUploadPath(normalized)) {
    const withoutDotPrefix = normalized.replace(/^\.\//, '')
    return withoutDotPrefix.startsWith('/') ? withoutDotPrefix : `/${withoutDotPrefix}`
  }

  return null
}

const pickFirstValidUrl = (candidates = []) => {
  for (const candidate of candidates) {
    const normalized = normalizeSourcePdfReference(candidate)
    if (normalized) {
      return normalized
    }
  }

  return null
}

const resolveBookSourcePdfUrl = (book) => {
  const legacyStringCandidates = [book?.sourcePdf, book?.hindiPdf, book?.bookFile]
    .filter((item) => typeof item === 'string')

  const legacyObjectCandidates = [book?.sourcePdf, book?.hindiPdf, book?.bookFile]
    .filter((item) => item && typeof item === 'object')
    .flatMap((item) => [
      item.url,
      item.fileUrl,
      item.secureUrl,
      item.secure_url,
      item.path,
      item.location,
      item.downloadUrl,
      item.href
    ])

  const directUrl = pickFirstValidUrl([
    book?.originalPdfUrl,
    book?.sourcePdfUrl,
    book?.hindiPdfUrl,
    book?.hindiBookUrl,
    book?.bookFileUrl,
    book?.bookPdfUrl,
    book?.pdfUrl,
    book?.originalPdfMeta?.url,
    book?.originalPdfMeta?.fileUrl,
    book?.originalPdfMeta?.secureUrl,
    book?.originalPdfMeta?.secure_url,
    book?.sourcePdfMeta?.url,
    book?.sourcePdfMeta?.fileUrl,
    book?.sourcePdfMeta?.secureUrl,
    book?.sourcePdfMeta?.secure_url,
    ...legacyStringCandidates,
    ...legacyObjectCandidates
  ])

  if (directUrl) {
    return directUrl
  }

  const bookFiles = Array.isArray(book?.bookFiles) ? book.bookFiles : []
  const flattenedCandidates = bookFiles.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (!item || typeof item !== 'object') return []
    return [item.url, item.fileUrl, item.secureUrl, item.secure_url, item.path]
  })

  return pickFirstValidUrl(flattenedCandidates)
}

const getDataSourcePdfFiles = () => {
  try {
    return fs.readdirSync(DATA_SOURCE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.pdf$/i.test(name))
  } catch (_error) {
    return []
  }
}

const toDataSourcePublicUrl = (fileName) => {
  const normalized = sanitizeOptionalString(fileName)
  if (!normalized) return null
  return `/data_source/${encodeURIComponent(normalized)}`
}

const resolveBookSourcePdfFromDataSource = (book) => {
  const fileNames = getDataSourcePdfFiles()
  if (fileNames.length === 0) return null

  const lowerNameMap = new Map(fileNames.map((name) => [name.toLowerCase(), name]))
  const basenameCandidates = [
    book?.originalPdfMeta?.fileName,
    book?.sourcePdfMeta?.fileName,
    book?.sourcePdfFileName,
    book?.hindiPdfFileName,
    book?.bookFile,
    book?.sourcePdf,
    book?.hindiPdf
  ]

  for (const candidate of basenameCandidates) {
    const normalizedCandidate = sanitizeOptionalString(typeof candidate === 'string' ? candidate : null)
    if (!normalizedCandidate) continue

    const baseName = path.basename(normalizedCandidate).toLowerCase()
    const matchedName = lowerNameMap.get(baseName)
    if (matchedName) {
      return toDataSourcePublicUrl(matchedName)
    }
  }

  const searchableTitle = toSearchableText(book?.title)
  const titleTokens = tokenizeSearchText(book?.title)
  const titleSkeletonTokens = titleTokens
    .map((token) => toConsonantSignature(token))
    .filter((token) => token.length >= 4)
  const searchableBookNumber = toSearchableText(book?.bookNumber)
  const compactBookNumber = searchableBookNumber.replace(/\s+/g, '')

  let bestCandidate = null
  let bestScore = 0

  for (const fileName of fileNames) {
    const searchableFileName = toSearchableText(fileName)
    if (!searchableFileName) continue

    let score = 0

    if (compactBookNumber) {
      const compactFileName = searchableFileName.replace(/\s+/g, '')
      if (compactFileName.includes(compactBookNumber)) {
        score += 130
      }
    }

    if (searchableTitle && searchableFileName.includes(searchableTitle)) {
      score += 120
    }

    if (titleTokens.length > 0) {
      const matchedTokenCount = titleTokens.filter((token) => searchableFileName.includes(token)).length
      score += matchedTokenCount * 20
      if (matchedTokenCount === titleTokens.length) {
        score += 40
      }
    }

    if (titleSkeletonTokens.length > 0) {
      const fileSkeletonTokens = searchableFileName
        .split(' ')
        .map((token) => toConsonantSignature(token))
        .filter((token) => token.length >= 4)

      const matchedSkeletonTokenCount = titleSkeletonTokens.filter((token) => (
        fileSkeletonTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))
      )).length

      score += matchedSkeletonTokenCount * 25
      if (matchedSkeletonTokenCount === titleSkeletonTokens.length) {
        score += 50
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestCandidate = fileName
    }
  }

  if (!bestCandidate || bestScore < MIN_PDF_FILE_MATCH_SCORE) {
    return null
  }

  return toDataSourcePublicUrl(bestCandidate)
}

const buildCloudinaryUrlFromPublicId = (publicId) => {
  const normalized = sanitizeOptionalString(publicId)
  if (!normalized) return null

  const { cloudinary } = require('../middleware/uploadMiddleware')

  try {
    const expiresAt = Math.floor(Date.now() / 1000) + (10 * 60)
    const privateDownloadUrl = cloudinary.utils.private_download_url(normalized, undefined, {
      resource_type: 'raw',
      type: 'upload',
      expires_at: expiresAt,
      attachment: false
    })
    if (privateDownloadUrl) return privateDownloadUrl
  } catch (_error) {
    // Fall through to signed delivery URL.
  }

  try {
    const signedUrl = cloudinary.url(normalized, {
      secure: true,
      sign_url: true,
      resource_type: 'raw',
      type: 'upload'
    })
    return sanitizeOptionalString(signedUrl)
  } catch (_error) {
    return null
  }
}

const toAbsoluteServerUrl = (req, value) => {
  const normalized = sanitizeOptionalString(value)
  if (!normalized) return normalized
  if (isValidHttpUrl(normalized)) return normalized

  const protocolHeader = sanitizeOptionalString(req.get('x-forwarded-proto'))
  const protocol = protocolHeader
    ? protocolHeader.split(',')[0].trim()
    : (req.protocol || 'http')

  if (/^\/\//.test(normalized)) {
    return `${protocol}:${normalized}`
  }

  const pathValue = normalized.startsWith('/')
    ? normalized
    : `/${normalized.replace(/^\.\//, '')}`

  const hostHeader = sanitizeOptionalString(req.get('x-forwarded-host')) || sanitizeOptionalString(req.get('host'))
  const host = hostHeader ? hostHeader.split(',')[0].trim() : null

  if (!host) {
    return pathValue
  }

  return `${protocol}://${host}${pathValue}`
}

const normalizeUploadedTranslationFiles = ({ files, file }) => {
  const fromArray = Array.isArray(files) ? files : []
  const fromFields = files && !Array.isArray(files) && typeof files === 'object'
    ? [
      ...(Array.isArray(files.documents) ? files.documents : []),
      ...(Array.isArray(files.document) ? files.document : [])
    ]
    : []
  const fromSingle = file ? [file] : []

  return [...fromArray, ...fromFields, ...fromSingle]
}

const isSameUser = (assignedUserId, currentUserId) => {
  if (!assignedUserId) return false
  return assignedUserId.toString() === currentUserId.toString()
}

const parseCloudinaryDeliveryUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!/(^|\.)res\.cloudinary\.com$/i.test(parsed.hostname)) return null

    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 5) return null

    const resourceType = segments[1]
    const deliveryType = segments[2]
    if (!['image', 'video', 'raw'].includes(resourceType)) return null

    const tail = segments.slice(3)
    const versionIndex = tail.findIndex((part) => /^v\d+$/.test(part))
    if (versionIndex === -1) return null

    const version = Number(tail[versionIndex].slice(1))
    const publicPathWithFormat = decodeURIComponent(tail.slice(versionIndex + 1).join('/'))
    if (!publicPathWithFormat) return null

    const lastSlashIndex = publicPathWithFormat.lastIndexOf('/')
    const lastDotIndex = publicPathWithFormat.lastIndexOf('.')
    const hasFormat = lastDotIndex > lastSlashIndex

    const publicId = hasFormat
      ? publicPathWithFormat.slice(0, lastDotIndex)
      : publicPathWithFormat
    const format = hasFormat
      ? publicPathWithFormat.slice(lastDotIndex + 1)
      : null

    if (!publicId) return null

    return {
      resourceType,
      deliveryType,
      version,
      publicId,
      format
    }
  } catch (_error) {
    return null
  }
}

const toAccessibleTextUrl = (sourceUrl) => {
  const original = String(sourceUrl || '').trim()
  if (!original) return original

  const asset = parseCloudinaryDeliveryUrl(original)
  if (!asset) return original

  const { cloudinary } = require('../middleware/uploadMiddleware')
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + (10 * 60)
    const privateDownloadUrl = cloudinary.utils.private_download_url(asset.publicId, asset.format || undefined, {
      resource_type: asset.resourceType,
      type: asset.deliveryType,
      expires_at: expiresAt,
      attachment: false
    })

    if (privateDownloadUrl) {
      return privateDownloadUrl
    }
  } catch (_error) {
    // Fall through to signed delivery URL.
  }

  const options = {
    secure: true,
    sign_url: true,
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    version: asset.version
  }

  if (asset.format) {
    options.format = asset.format
  }

  const signedDeliveryUrl = cloudinary.url(asset.publicId, options)
  if (signedDeliveryUrl) {
    return signedDeliveryUrl
  }

  return original
}

const toDirectDownloadUrl = (sourceUrl, { fileName = 'book-source' } = {}) => {
  const original = String(sourceUrl || '').trim()
  if (!original) return original

  const asset = parseCloudinaryDeliveryUrl(original)
  if (!asset) return original

  const { cloudinary } = require('../middleware/uploadMiddleware')

  try {
    const expiresAt = Math.floor(Date.now() / 1000) + (10 * 60)
    const extension = asset.format ? `.${asset.format}` : ''
    const attachmentName = `${toSafeCloudinaryPathPart(fileName) || 'book-source'}${extension}`

    const privateDownloadUrl = cloudinary.utils.private_download_url(asset.publicId, asset.format || undefined, {
      resource_type: asset.resourceType,
      type: asset.deliveryType,
      expires_at: expiresAt,
      attachment: attachmentName
    })

    if (privateDownloadUrl) {
      return privateDownloadUrl
    }
  } catch (_error) {
    // Fall through to signed delivery URL with attachment flag.
  }

  const options = {
    secure: true,
    sign_url: true,
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    version: asset.version,
    flags: 'attachment'
  }

  if (asset.format) {
    options.format = asset.format
  }

  const signedAttachmentUrl = cloudinary.url(asset.publicId, options)
  if (signedAttachmentUrl) {
    return signedAttachmentUrl
  }

  return original
}

const canAccessVersionText = (reqUser, version) => {
  if (!reqUser || !version) return false
  if (reqUser.role === 'admin') return true

  if (
    reqUser.role === 'spoc'
    && String(reqUser.language || '').trim().toLowerCase() === String(version.language || '').trim().toLowerCase()
  ) {
    return true
  }

  return [
    version.assignedTranslator,
    version.assignedChecker,
    version.assignedRecorder,
    version.assignedAudioChecker,
    version.lastCheckedBy,
    version.spoc
  ].some((memberId) => isSameUser(memberId, reqUser._id))
}

const notifyTaskCompletion = async ({ userId, book, version, actionLabel, metadata = {} }) => {
  if (!userId || !book || !version) return

  await createNotification({
    userId,
    type: 'task',
    title: 'Task completed successfully',
    message: `${actionLabel} completed for ${book.title} (${version.language}).`,
    metadata: {
      bookId: book._id,
      versionId: version._id,
      language: version.language,
      ...metadata
    }
  })
}

const hasConflictingActiveCheckingClaim = async (checkerId, exclude = null) => {
  const activeClaim = await Claim.findOne({
    claimedBy: checkerId,
    claimType: 'checking',
    status: 'active'
  }).populate('book', 'title')

  if (!activeClaim) {
    return null
  }

  const claimBookId = activeClaim.book?._id?.toString() || activeClaim.book?.toString() || ''
  const claimLanguage = activeClaim.language || ''
  const isExcluded =
    exclude &&
    claimBookId === exclude.bookId?.toString() &&
    claimLanguage === exclude.language

  if (isExcluded) {
    return null
  }

  return activeClaim
}

const normalizeLanguageValue = (value) => String(value || '').trim().toLowerCase()

const assignUnclaimedVersion = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { assigneeId, daysCommitted = 3 } = req.body

    const assignmentDays = Number(daysCommitted)
    if (!Number.isInteger(assignmentDays) || assignmentDays < 1 || assignmentDays > 30) {
      return res.status(400).json({ message: 'daysCommitted must be an integer between 1 and 30' })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    const requesterLanguage = normalizeLanguageValue(req.user.language)
    const versionLanguage = normalizeLanguageValue(version.language)

    if (req.user.role === 'spoc' && requesterLanguage !== versionLanguage) {
      return res.status(403).json({
        message: 'SPOC can assign only within their own language.'
      })
    }

    const now = new Date()
    const lastUnclaimedAnchor = version.updatedAt || version.createdAt || book.updatedAt || book.createdAt
    const minimumUnclaimedMs = MIN_DIRECT_ASSIGNMENT_UNCLAIMED_DAYS * 24 * 60 * 60 * 1000
    const unclaimedAgeMs = now.getTime() - new Date(lastUnclaimedAnchor).getTime()

    if (unclaimedAgeMs < minimumUnclaimedMs) {
      return res.status(400).json({
        message: `Direct assignment is allowed only after task remains unclaimed for at least ${MIN_DIRECT_ASSIGNMENT_UNCLAIMED_DAYS} days.`
      })
    }

    const stageConfig = DIRECT_ASSIGNABLE_STAGE_CONFIG[version.currentStage]
    if (!stageConfig) {
      return res.status(400).json({
        message: `Direct assignment is not available for stage: ${version.currentStage}`
      })
    }

    if (stageConfig.progressField === 'audioStatus' && version.currentStage === 'audio_generation' && version.textStatus !== 'text_approved') {
      return res.status(400).json({ message: 'Audio generation assignment is allowed only after text approval' })
    }

    const currentProgress = String(version[stageConfig.progressField] || '').trim()
    if (!stageConfig.allowedProgressValues.includes(currentProgress)) {
      return res.status(400).json({
        message: `${stageConfig.stageLabel} assignment is not allowed in current state: ${currentProgress || 'unknown'}`
      })
    }

    const existingAssignee = version[stageConfig.assigneeField]
    if (version.isLocked || existingAssignee) {
      return res.status(400).json({ message: 'This task is already claimed or assigned' })
    }

    const assignee = await User.findById(assigneeId)
    if (!assignee || assignee.status !== 'approved' || !assignee.isActive) {
      return res.status(404).json({ message: 'Selected assignee is not available' })
    }

    if (assignee.role !== stageConfig.requiredRole) {
      return res.status(400).json({
        message: `Selected user must be a ${stageConfig.requiredRole.replace('_', ' ')}`
      })
    }

    if (assignee.language !== version.language) {
      return res.status(400).json({ message: 'Selected assignee must belong to the same language' })
    }

    const activeClaimForTask = await Claim.findOne({
      book: book._id,
      language: version.language,
      claimType: stageConfig.claimType,
      status: 'active'
    })

    if (activeClaimForTask) {
      return res.status(409).json({ message: 'This task already has an active claim' })
    }

    const existingAssigneeClaim = await Claim.findOne({
      claimedBy: assignee._id,
      status: 'active'
    }).populate('book', 'title')

    if (existingAssigneeClaim) {
      return res.status(400).json({
        message: `Selected assignee already has an active claim for ${existingAssigneeClaim.book?.title || 'another book'}.`
      })
    }

    const deadline = new Date(now)
    deadline.setDate(deadline.getDate() + assignmentDays)

    await Claim.create({
      book: book._id,
      language: version.language,
      claimedBy: assignee._id,
      claimType: stageConfig.claimType,
      daysCommitted: assignmentDays,
      deadline,
      status: 'active'
    })

    const fromProgress = version[stageConfig.progressField]
    version[stageConfig.assigneeField] = assignee._id
    version[stageConfig.deadlineField] = deadline
    version[stageConfig.progressField] = stageConfig.assignedProgressValue
    version.isLocked = true
    version.lockedBy = assignee._id
    version.lockedUntil = deadline
    await book.save()

    await createNotification({
      userId: assignee._id,
      type: 'task',
      title: 'Task assigned directly',
      message: `${book.title} (${version.language}) was assigned to you for ${stageConfig.stageLabel.toLowerCase()}.`,
      metadata: {
        bookId: book._id,
        versionId: version._id,
        language: version.language,
        claimType: stageConfig.claimType,
        assignedBy: req.user._id,
        deadline
      }
    })

    await logAudit({
      req,
      action: 'task_assigned_directly',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: String(fromProgress || stageConfig.progressField),
      toState: stageConfig.assignedProgressValue,
      metadata: {
        assignedTo: assignee._id,
        assignedRole: stageConfig.requiredRole,
        claimType: stageConfig.claimType,
        daysCommitted: assignmentDays,
        deadline
      }
    })

    return res.status(200).json({
      message: `${stageConfig.stageLabel} task assigned successfully to ${assignee.name}.`,
      version,
      assignment: {
        role: stageConfig.requiredRole,
        claimType: stageConfig.claimType,
        assignee: {
          id: assignee._id,
          name: assignee.name,
          email: assignee.email
        },
        daysCommitted: assignmentDays,
        deadline
      }
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Add a new book (admin only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const addBook = async (req, res) => {
  try {
    const title = sanitizeOptionalString(req.body?.title)
    const description = sanitizeOptionalString(req.body?.description)
    const parsedBookNumber = sanitizeBookNumberCode(req.body?.bookNumber)

    if (!title) {
      return res.status(400).json({ message: 'title is required' })
    }

    if (!parsedBookNumber) {
      return res.status(400).json({ message: 'bookNumber is required and must use letters/numbers with optional _ or - (example: H_KD_06)' })
    }

    const existing = await Book.findOne({ bookNumber: parsedBookNumber })
    if (existing) {
      return res.status(400).json({ message: `Book number ${parsedBookNumber} already exists` })
    }

    let originalPdfUrl = null
    let originalPdfPublicId = null
    let originalPdfMeta = null

    if (req.file) {
      const extension = extractFileExtension(req.file.originalname) || inferDocumentExtensionFromMimeType(req.file.mimetype)
      const safeTitle = toSafeCloudinaryPathPart(title) || 'book'
      const publicId = `books/${parsedBookNumber}-${safeTitle}-${Date.now()}`

      const uploadResult = await uploadToCloudinary(
        req.file.buffer,
        `${publicId}${extension}`,
        'raw'
      )

      const parsedAsset = parseCloudinaryDeliveryUrl(uploadResult?.secure_url || '')

      originalPdfMeta = sanitizeFileMetadataEntry({
        url: uploadResult?.secure_url,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size ?? uploadResult?.bytes,
        cloudinaryId: uploadResult?.public_id || parsedAsset?.publicId,
        resourceType: uploadResult?.resource_type || parsedAsset?.resourceType,
        format: uploadResult?.format || parsedAsset?.format,
        uploadedAt: uploadResult?.created_at || new Date(),
        uploadedBy: req.user?._id || null
      }, 'document')

      originalPdfUrl = originalPdfMeta?.url || null
      originalPdfPublicId = originalPdfMeta?.cloudinaryId || null
    } else {
      const bodySourceUrl = pickFirstValidUrl([
        req.body?.originalPdfUrl,
        req.body?.sourcePdfUrl,
        req.body?.hindiPdfUrl,
        req.body?.bookFileUrl,
        req.body?.bookPdfUrl,
        req.body?.pdfUrl
      ])

      if (bodySourceUrl) {
        originalPdfUrl = bodySourceUrl
        originalPdfPublicId = sanitizeOptionalString(req.body?.originalPdfPublicId)
          || sanitizeOptionalString(req.body?.sourcePdfPublicId)
          || null

        originalPdfMeta = {
          url: bodySourceUrl,
          fileName: sanitizeOptionalString(req.body?.originalPdfFileName)
            || sanitizeOptionalString(req.body?.sourcePdfFileName)
            || null,
          mimeType: /\.pdf(\?|$)/i.test(bodySourceUrl) ? 'application/pdf' : null,
          cloudinaryId: originalPdfPublicId,
          uploadedAt: new Date(),
          uploadedBy: req.user?._id || null
        }
      }
    }

    const languageVersions = TRANSLATION_LANGUAGES.map((language) => ({
      language,
      textStatus: 'not_started',
      audioStatus: 'not_started',
      currentStage: 'translation'
    }))

    const book = await Book.create({
      title,
      bookNumber: parsedBookNumber,
      description,
      originalPdfUrl,
      originalPdfPublicId,
      originalPdfMeta,
      languageVersions,
      createdBy: req.user._id
    })

    // Do not block book creation if invitation dispatch fails.
    let inviteSummary = null
    try {
      inviteSummary = await sendTranslationClaimInvites(book)
    } catch (mailError) {
      console.error('Translation invite dispatch error:', mailError.message)
    }

    res.status(201).json({ message: 'Book added successfully', book, inviteSummary })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Get all books â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getAllBooks = async (req, res) => {
  try {
    const books = await Book.find()
      .populate('createdBy', 'name email')
      .select('-languageVersions')
    res.status(200).json(books)
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Get single book â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getBookById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.bookId)) {
      return res.status(400).json({ message: 'Invalid bookId' })
    }

    const book = await Book.findById(req.params.bookId)
      .populate('createdBy', 'name email')
      .populate('languageVersions.assignedTranslator', 'name email')
      .populate('languageVersions.assignedChecker', 'name email')
      .populate('languageVersions.assignedRecorder', 'name email')
      .populate('languageVersions.assignedAudioChecker', 'name email')
      .populate('languageVersions.spoc', 'name email')

    if (!book) return res.status(404).json({ message: 'Book not found' })
    res.status(200).json(book)
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getTextAccessUrl = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const selectedIndex = Number.parseInt(req.query.index, 10)

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (!canAccessVersionText(req.user, version)) {
      return res.status(403).json({ message: 'You are not allowed to access this text file' })
    }

    const urls = normalizeAccessibleDocumentUrls({
      textFileUrl: version.textFileUrl,
      textFileUrls: version.textFileUrls
    })

    const normalizedTextFilesMeta = normalizeFileMetadata({
      metadata: version.textFilesMeta,
      urls,
      kind: 'document'
    })

    if (urls.length === 0) {
      return res.status(404).json({ message: 'No translation document found for this version' })
    }

    const resolvedIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < urls.length
      ? selectedIndex
      : 0

    const sourceUrl = urls[resolvedIndex]
    const url = toAccessibleTextUrl(sourceUrl)
    const selectedFile = normalizedTextFilesMeta[resolvedIndex] || { url: sourceUrl }

    return res.status(200).json({
      url,
      sourceUrl,
      signed: url !== sourceUrl,
      file: selectedFile,
      files: normalizedTextFilesMeta
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const findBookForSourcePdf = async ({ bookId, bookNumber }) => {
  if (bookId && mongoose.Types.ObjectId.isValid(bookId)) {
    const byId = await Book.findById(bookId)
    if (byId) return byId
  }

  const normalizedBookNumber = sanitizeBookNumberCode(bookNumber)
  if (normalizedBookNumber) {
    const byBookNumber = await Book.findOne({ bookNumber: normalizedBookNumber })
    if (byBookNumber) return byBookNumber

    const caseInsensitive = await Book.findOne({
      bookNumber: { $regex: `^${escapeRegex(normalizedBookNumber)}$`, $options: 'i' }
    })
    if (caseInsensitive) return caseInsensitive
  }

  return null
}

const getSourcePdfAccessUrl = async (req, res) => {
  try {
    const paramBookId = sanitizeOptionalString(req.params.bookId)
    const queryBookId = sanitizeOptionalString(req.query.bookId)
      || sanitizeOptionalString(req.query.id)
    const bookId = paramBookId || queryBookId
    const pathBookNumber = sanitizeOptionalString(req.params.bookNumber)
    const queryBookNumber = sanitizeOptionalString(req.query.bookNumber)
    const requestedBookNumber = pathBookNumber || queryBookNumber

    if (!bookId && !requestedBookNumber) {
      return res.status(400).json({ message: 'Provide either bookId or bookNumber' })
    }

    if (bookId && !mongoose.Types.ObjectId.isValid(bookId) && !requestedBookNumber) {
      return res.status(400).json({ message: 'Invalid bookId' })
    }

    const book = await findBookForSourcePdf({
      bookId,
      bookNumber: requestedBookNumber
    })

    if (!book) {
      return res.status(404).json({ message: 'Book not found' })
    }

    let sourceUrl = resolveBookSourcePdfUrl(book)

    if (!sourceUrl) {
      sourceUrl = buildCloudinaryUrlFromPublicId(
        book?.originalPdfPublicId
        || book?.originalPdfMeta?.cloudinaryId
        || book?.sourcePdfPublicId
        || book?.hindiPdfPublicId
      )
    }

    if (!sourceUrl) {
      sourceUrl = resolveBookSourcePdfFromDataSource(book)
    }

    if (!sourceUrl) {
      return res.status(404).json({ message: 'Hindi PDF not available for this book' })
    }

    const absoluteSourceUrl = toAbsoluteServerUrl(req, sourceUrl)

    const downloadUrl = toDirectDownloadUrl(absoluteSourceUrl, {
      fileName: `${book.bookNumber || 'book'}-hindi-source`
    })

    const absoluteDownloadUrl = toAbsoluteServerUrl(req, downloadUrl)

    return res.status(200).json({
      url: absoluteDownloadUrl,
      downloadUrl: absoluteDownloadUrl,
      sourceUrl: absoluteSourceUrl,
      directDownload: true
    })
  } catch (error) {
    if (error?.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid bookId' })
    }

    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Get my assigned books â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getMyAssignedBooks = async (req, res) => {
  try {
    const userId = req.user._id
    let query = {
      $or: [
        { 'languageVersions.assignedTranslator': userId },
        { 'languageVersions.assignedChecker': userId },
        { 'languageVersions.assignedRecorder': userId },
        { 'languageVersions.assignedAudioChecker': userId }
      ]
    }

    if (req.user.role === 'translator') {
      query = {
        languageVersions: {
          $elemMatch: {
            assignedTranslator: userId,
            currentStage: 'translation',
            textStatus: { $in: ['translation_in_progress', 'not_started'] }
          }
        }
      }
    } else if (req.user.role === 'checker') {
      query = {
        languageVersions: {
          $elemMatch: {
            assignedChecker: userId,
            currentStage: 'checking',
            textStatus: { $in: ['translation_submitted', 'checking_in_progress'] }
          }
        }
      }
    } else if (req.user.role === 'recorder') {
      query = {
        languageVersions: {
          $elemMatch: {
            assignedRecorder: userId,
            currentStage: 'audio_generation',
            audioStatus: { $in: ['audio_generated'] }
          }
        }
      }
    } else if (req.user.role === 'audio_checker') {
      query = {
        languageVersions: {
          $elemMatch: {
            assignedAudioChecker: userId,
            currentStage: 'audio_checking',
            audioStatus: { $in: ['audio_submitted', 'audio_checking_in_progress'] }
          }
        }
      }
    }

    const books = await Book.find(query).populate('createdBy', 'name email')
    res.status(200).json(books)
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const uploadTranslationDocument = async (req, res) => {
  try {
    const { uploadToCloudinary } = require('../middleware/uploadMiddleware')
    const files = normalizeUploadedTranslationFiles(req)

    if (files.length === 0) {
      return res.status(400).json({ message: 'Please upload at least one PDF, DOC, DOCX, or TXT file' })
    }

    const uploadedFiles = await Promise.all(
      files.map(async (item) => {
        const result = await uploadToCloudinary(item.buffer, item.originalname, 'auto')
        const metadata = buildUploadMetadata({
          result,
          file: item,
          kind: 'document',
          uploadedBy: req.user?._id
        })

        return {
          fileUrl: result.secure_url,
          filename: item.originalname,
          size: item.size,
          mimeType: item.mimetype,
          cloudinaryId: result.public_id,
          resourceType: result.resource_type || metadata?.resourceType || null,
          format: result.format || metadata?.format || null,
          metadata
        }
      })
    )

    return res.status(200).json({
      message: uploadedFiles.length === 1
        ? 'Document uploaded successfully'
        : `${uploadedFiles.length} documents uploaded successfully`,
      fileUrl: uploadedFiles[0].fileUrl,
      files: uploadedFiles
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const uploadAudioFile = async (req, res) => {
  try {
    const { uploadToCloudinary } = require('../middleware/uploadMiddleware')
    const files = Array.isArray(req.files) ? req.files : []
    if (files.length === 0) {
      return res.status(400).json({ message: 'Please upload at least one MP3 or MP4 file' })
    }

    const uploadedFiles = await Promise.all(
      files.map(async (file) => {
        const result = await uploadToCloudinary(file.buffer, file.originalname, 'video')
        const metadata = buildUploadMetadata({
          result,
          file,
          kind: 'audio',
          uploadedBy: req.user?._id
        })

        return {
          fileUrl: result.secure_url,
          filename: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          cloudinaryId: result.public_id,
          resourceType: result.resource_type || metadata?.resourceType || null,
          format: result.format || metadata?.format || null,
          metadata
        }
      })
    )

    return res.status(200).json({
      message: 'Audio uploaded successfully',
      fileUrl: uploadedFiles[0].fileUrl,
      files: uploadedFiles
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Translator submits translation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const submitTranslation = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { textFileUrl, textFileUrls, textFilesMeta, textFiles } = req.body

    const legacyDocumentUrls = normalizeDocumentUrls({ textFileUrl, textFileUrls })
    const normalizedTextFilesMeta = normalizeFileMetadata({
      metadata: [...asArray(textFilesMeta), ...asArray(textFiles)],
      urls: legacyDocumentUrls,
      kind: 'document'
    })
    const validDocumentUrls = normalizedTextFilesMeta.map((item) => item.url)

    if (normalizedTextFilesMeta.length === 0) {
      return res.status(400).json({
        message: 'Please provide a valid document link (PDF/DOC/DOCX/TXT or Google Drive link)'
      })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.currentStage !== 'translation' || version.textStatus !== 'translation_in_progress') {
      return res.status(400).json({ message: 'This version is not ready for translation submission' })
    }

    // Only assigned translator can submit
    if (!isSameUser(version.assignedTranslator, req.user._id)) {
      return res.status(403).json({ message: 'You are not assigned as translator for this book' })
    }

    version.textStatus = 'translation_submitted'
    version.textFileUrl = validDocumentUrls[0]
    version.textFileUrls = validDocumentUrls
    version.textFilesMeta = stampMetadataForSave(normalizedTextFilesMeta, req.user?._id)
    version.currentStage = 'checking'
    version.isLocked = false
    version.lockedBy = null
    version.lockedUntil = null
    await book.save()

    try {
      appendTranslationConversionRecord({
        book,
        version,
        submittedBy: req.user,
        textUrls: validDocumentUrls
      })
    } catch (excelError) {
      console.error('Excel audit logging failed for translation submission:', excelError.message)
    }

    // Update claim status
    await Claim.findOneAndUpdate(
      { book: bookId, language: version.language, claimType: 'translation', status: 'active' },
      { status: 'submitted' }
    )

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'Translation submission',
      metadata: { claimType: 'translation' }
    })

    await logAudit({
      req,
      action: 'translation_submitted',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: 'translation_in_progress',
      toState: 'translation_submitted'
    })

    res.status(200).json({ message: 'Translation submitted successfully!', version })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Checker submits vetted text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const submitVettedText = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { textFileUrl, textFilesMeta, textFiles, decision = 'approved', feedback } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.currentStage !== 'checking' || version.textStatus !== 'checking_in_progress') {
      return res.status(400).json({ message: 'This version is not ready for checker submission' })
    }

    if (!isSameUser(version.assignedChecker, req.user._id)) {
      return res.status(403).json({ message: 'You are not assigned as checker for this book' })
    }

    if (!['approved', 'revision'].includes(decision)) {
      return res.status(400).json({ message: 'Invalid decision. Use approved or revision' })
    }

    if (decision === 'revision' && !(feedback || '').trim()) {
      return res.status(400).json({ message: 'Feedback is required when sending for revision' })
    }

    if (decision === 'approved') {
      const checkerActionAt = new Date()
      version.textStatus = 'checking_submitted'

      const approvedTextFilesMeta = normalizeFileMetadata({
        metadata: [...asArray(version.textFilesMeta), ...asArray(textFilesMeta), ...asArray(textFiles)],
        urls: [
          ...(Array.isArray(version.textFileUrls) ? version.textFileUrls : []),
          version.textFileUrl,
          sanitizeOptionalString(textFileUrl)
        ],
        kind: 'document'
      })

      const approvedTextUrls = approvedTextFilesMeta.map((item) => item.url)
      if (approvedTextUrls.length > 0) {
        version.textFileUrl = approvedTextUrls[0]
        version.textFileUrls = approvedTextUrls
        version.textFilesMeta = stampMetadataForSave(approvedTextFilesMeta, req.user?._id)
      }

      if (!version.textFileUrl && Array.isArray(version.textFileUrls) && version.textFileUrls.length > 0) {
        version.textFileUrl = version.textFileUrls[0]
      }
      version.currentStage = 'spoc_review'
      version.feedback = (feedback || '').trim() || null
      version.lastCheckedBy = req.user._id
      version.lastCheckedAt = checkerActionAt
      version.checkerApprovedAt = checkerActionAt
      version.isLocked = false
      version.lockedBy = null
      version.lockedUntil = null
      await book.save()

      await Claim.findOneAndUpdate(
        { book: bookId, language: version.language, claimType: 'checking', status: 'active' },
        { status: 'submitted' }
      )

      await logAudit({
        req,
        action: 'text_check_submitted',
        entityType: 'book_version',
        entityId: version._id,
        book: book._id,
        versionId: version._id,
        language: version.language,
        fromState: 'checking_in_progress',
        toState: 'checking_submitted'
      })

      // Notify SPOC
      const spoc = await User.findOne({
        language: version.language,
        role: 'spoc',
        status: 'approved'
      })

      if (spoc) {
        await sendMail({
          to: spoc.email,
          subject: `Text Ready for Review â€” ${book.title} (${version.language})`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
              <p>Pranam <strong>${spoc.name}</strong>,</p>
              <p>The following book text is ready for your review:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <strong>Book:</strong> ${book.title}<br/>
                <strong>Language:</strong> ${version.language}
              </div>
              <p>Please login to review and approve or reject.</p>
              <a href="${FRONTEND_BASE_URL}"
                 style="background: #1D9E75; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Login to Review
              </a>
            </div>
          `
        })

        await createNotification({
          userId: spoc._id,
          type: 'task',
          title: 'Text ready for SPOC review',
          message: `${book.title} (${version.language}) needs your approval.`,
          metadata: { bookId: book._id, versionId: version._id }
        })
      }

      await notifyTaskCompletion({
        userId: req.user._id,
        book,
        version,
        actionLabel: 'Text vetting',
        metadata: { claimType: 'checking', decision: 'approved' }
      })

      return res.status(200).json({ message: 'Text approved and sent to SPOC review.', version })
    }

    const checkerFeedback = (feedback || '').trim()
    const checkerActionAt = new Date()

    version.feedback = checkerFeedback
    version.currentStage = 'translation'
    version.textStatus = 'translation_in_progress'
    version.textRejectionCount += 1
    version.reassignmentCount += 1
    version.lastCheckedBy = req.user._id
    version.lastCheckedAt = checkerActionAt
    version.checkerRevisionSentAt = checkerActionAt
    version.isLocked = false
    version.lockedBy = null
    version.lockedUntil = null
    version.assignedChecker = null
    version.checkerDeadline = null
    if (textFileUrl) {
      const revisionTextFilesMeta = normalizeFileMetadata({
        metadata: [...asArray(version.textFilesMeta), ...asArray(textFilesMeta), ...asArray(textFiles)],
        urls: [
          ...(Array.isArray(version.textFileUrls) ? version.textFileUrls : []),
          version.textFileUrl,
          textFileUrl
        ],
        kind: 'document'
      })

      const revisionTextUrls = revisionTextFilesMeta.map((item) => item.url)
      if (revisionTextUrls.length > 0) {
        version.textFileUrl = revisionTextUrls[0]
        version.textFileUrls = revisionTextUrls
        version.textFilesMeta = stampMetadataForSave(revisionTextFilesMeta, req.user?._id)
      }
    }
    await book.save()

    await Claim.findOneAndUpdate(
      { book: bookId, language: version.language, claimType: 'checking', status: 'active' },
      { status: 'submitted' }
    )

    await logAudit({
      req,
      action: 'text_sent_back_to_translator',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: 'checking_in_progress',
      toState: 'translation_in_progress',
      note: checkerFeedback
    })

    const translator = version.assignedTranslator ? await User.findById(version.assignedTranslator) : null
    if (translator) {
      await sendMail({
        to: translator.email,
        subject: `Text Revision Required â€” ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #E24B4A;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${translator.name}</strong>,</p>
            <p>Your translated text needs revision after text vetting.</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Language:</strong> ${version.language}<br/>
              <strong>Checker Feedback:</strong><br/>
              <p style="color: #E24B4A;">${checkerFeedback}</p>
            </div>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Revise
            </a>
          </div>
        `
      })

      await createNotification({
        userId: translator._id,
        type: 'feedback',
        title: 'Text revision requested by checker',
        message: `${book.title} (${version.language}) was sent back with corrections.`,
        metadata: { bookId: book._id, versionId: version._id }
      })
    }

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'Text review and revision feedback',
      metadata: { claimType: 'checking', decision: 'revision' }
    })

    return res.status(200).json({ message: 'Text sent back to translator for revision.', version })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ SPOC reviews text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const spocReviewText = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { decision, feedback } = req.body
    const normalizedDecision = String(decision || 'approved').toLowerCase()
    const reviewFeedback = (feedback || '').trim()

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.language !== version.language) {
      return res.status(403).json({ message: `You can only review books for: ${req.user.language}` })
    }

    const hasTextForReview =
      Boolean(String(version.textFileUrl || '').trim()) ||
      (Array.isArray(version.textFileUrls) && version.textFileUrls.some((item) => Boolean(String(item || '').trim())))

    const isStrictReady = version.currentStage === 'spoc_review' && version.textStatus === 'checking_submitted'
    const isLegacyReady = version.currentStage === 'spoc_review' && version.textStatus === 'checking_in_progress' && hasTextForReview

    if (!isStrictReady && !isLegacyReady) {
      return res.status(400).json({ message: 'Text is not ready for SPOC review' })
    }

    const fromTextState = version.textStatus

    if (isLegacyReady) {
      version.textStatus = 'checking_submitted'
    }

    if (!['approved', 'rejected'].includes(normalizedDecision)) {
      return res.status(400).json({ message: 'Invalid decision. Use approved or rejected' })
    }

    if (normalizedDecision === 'rejected' && !reviewFeedback) {
      return res.status(400).json({ message: 'Feedback is required when rejecting and sending back to translator' })
    }

    if (normalizedDecision === 'approved') {
      version.textStatus = 'text_approved'
      version.currentStage = 'audio_generation'
      version.feedback = null
      await book.save()

      // Notify recorder team
      const recorders = await User.find({
        language: version.language,
        role: 'recorder',
        status: 'approved'
      })

      for (const recorder of recorders) {
        await sendMail({
          to: recorder.email,
          subject: `Text Approved â€” Audio Generation Ready â€” ${book.title} (${version.language})`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
              <p>Pranam <strong>${recorder.name}</strong>,</p>
              <p>The text for the following book has been approved and is ready for audio generation:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
                <strong>Book:</strong> ${book.title}<br/>
                <strong>Language:</strong> ${version.language}
              </div>
              <p>Please login to claim and start audio generation.</p>
              <a href="${FRONTEND_BASE_URL}"
                 style="background: #1D9E75; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Login to Claim
              </a>
            </div>
          `
        })
      }

      await createBulkNotifications({
        userIds: recorders.map((recorder) => recorder._id),
        type: 'task',
        title: 'Text approved, audio generation open',
        message: `${book.title} (${version.language}) is ready for recording claim.`,
        metadata: { bookId: book._id, versionId: version._id }
      })

      await logAudit({
        req,
        action: 'spoc_text_approved',
        entityType: 'book_version',
        entityId: version._id,
        book: book._id,
        versionId: version._id,
        language: version.language,
        fromState: fromTextState,
        toState: 'text_approved'
      })

      await notifyTaskCompletion({
        userId: req.user._id,
        book,
        version,
        actionLabel: 'SPOC text approval',
        metadata: { decision: 'approved' }
      })

      return res.status(200).json({
        message: 'Text approved and sent to audio recorder team.',
        version
      })
    }

    version.textStatus = 'translation_in_progress'
    version.currentStage = 'translation'
    version.feedback = reviewFeedback
    version.reassignmentCount += 1
    version.textRejectionCount += 1
    version.assignedChecker = null
    version.checkerDeadline = null
    await book.save()

    const translator = version.assignedTranslator ? await User.findById(version.assignedTranslator) : null
    if (translator) {
      await sendMail({
        to: translator.email,
        subject: `Text Revision Required by SPOC â€” ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #E24B4A;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${translator.name}</strong>,</p>
            <p>The translated text needs revision based on SPOC review.</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Language:</strong> ${version.language}<br/>
              <strong>SPOC Feedback:</strong><br/>
              <p style="color: #E24B4A;">${reviewFeedback}</p>
            </div>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Revise
            </a>
          </div>
        `
      })

      await createNotification({
        userId: translator._id,
        type: 'feedback',
        title: 'Text revision requested by SPOC',
        message: `${book.title} (${version.language}) was sent back with SPOC feedback.`,
        metadata: { bookId: book._id, versionId: version._id }
      })
    }

    await logAudit({
      req,
      action: 'spoc_text_rejected',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: fromTextState,
      toState: 'translation_in_progress',
      note: reviewFeedback
    })

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'SPOC text review',
      metadata: { decision: 'rejected' }
    })

    return res.status(200).json({
      message: 'Text sent back to translator with SPOC feedback.',
      version
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Recorder submits audio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const submitAudio = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { audioUrl, audioUrls, audioFilesMeta, audioFiles } = req.body
    const legacyAudioUrls = normalizeAudioUrls({ audioUrl, audioUrls })
    const normalizedAudioFilesMeta = normalizeFileMetadata({
      metadata: [...asArray(audioFilesMeta), ...asArray(audioFiles)],
      urls: legacyAudioUrls,
      kind: 'audio'
    })
    const normalizedAudioUrls = normalizedAudioFilesMeta.map((item) => item.url)

    if (normalizedAudioFilesMeta.length === 0) {
      return res.status(400).json({
        message: 'Please provide at least one valid audio link (MP3/MP4 or Google Drive link)'
      })
    }

    const hasInvalidAudioLink = normalizedAudioUrls.some((url) => !isValidHttpUrl(url) || !isAudioLink(url))
    if (hasInvalidAudioLink) {
      return res.status(400).json({
        message: 'One or more audio links are invalid. Please use MP3/MP4 or Google Drive links.'
      })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.currentStage !== 'audio_generation' || version.audioStatus !== 'audio_generated') {
      return res.status(400).json({ message: 'This version is not ready for audio submission' })
    }

    if (!isSameUser(version.assignedRecorder, req.user._id)) {
      return res.status(403).json({ message: 'You are not assigned as recorder for this book' })
    }

    version.audioStatus = 'audio_submitted'
    version.audioUrl = normalizedAudioUrls[0]
    version.audioFiles = normalizedAudioUrls
    version.audioFilesMeta = stampMetadataForSave(normalizedAudioFilesMeta, req.user?._id)
    version.currentStage = 'audio_checking'
    version.isLocked = false
    version.lockedBy = null
    version.lockedUntil = null
    await book.save()

    try {
      appendAudioGenerationRecord({
        book,
        version,
        submittedBy: req.user,
        audioUrls: normalizedAudioUrls
      })
    } catch (excelError) {
      console.error('Excel audit logging failed for audio submission:', excelError.message)
    }

    await Claim.findOneAndUpdate(
      { book: bookId, language: version.language, claimType: 'audio', status: 'active' },
      { status: 'submitted' }
    )

    await logAudit({
      req,
      action: 'audio_submitted',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: 'audio_generated',
      toState: 'audio_submitted'
    })

    // Notify audio checkers for audio verification
    const checkers = await User.find({
      language: version.language,
      role: 'audio_checker',
      status: 'approved'
    })

    for (const checker of checkers) {
      await sendMail({
        to: checker.email,
        subject: `Audio Ready for Verification â€” ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${checker.name}</strong>,</p>
            <p>Audio is ready for verification:</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Language:</strong> ${version.language}
            </div>
            <p>Please login to claim and start audio verification.</p>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Claim
            </a>
          </div>
        `
      })
    }

    await createBulkNotifications({
      userIds: checkers.map((checker) => checker._id),
      type: 'task',
      title: 'Audio verification task available',
      message: `${book.title} (${version.language}) audio is ready to verify.`,
      metadata: { bookId: book._id, versionId: version._id }
    })

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'Audio submission',
      metadata: { claimType: 'audio' }
    })

    res.status(200).json({ message: 'Audio submitted! Audio checker team notified.', version })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Checker submits audio review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const submitAudioReview = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { decision, feedback, feedbackDeadline } = req.body
    const normalizedDecision = String(decision || 'approved').toLowerCase()
    const checkerFeedback = (feedback || '').trim()

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.currentStage !== 'audio_checking' || version.audioStatus !== 'audio_checking_in_progress') {
      return res.status(400).json({ message: 'This version is not ready for audio checker submission' })
    }

    if (!isSameUser(version.assignedAudioChecker, req.user._id)) {
      return res.status(403).json({ message: 'You are not assigned as audio checker' })
    }

    if (!['approved', 'rejected'].includes(normalizedDecision)) {
      return res.status(400).json({ message: 'Invalid decision. Use approved or rejected' })
    }

    if (normalizedDecision === 'rejected' && !checkerFeedback) {
      return res.status(400).json({ message: 'Feedback is required when rejecting audio' })
    }

    let parsedFeedbackDeadline = null
    if (normalizedDecision === 'approved') {
      if (!feedbackDeadline) {
        return res.status(400).json({ message: 'feedbackDeadline is required when approving audio' })
      }

      parsedFeedbackDeadline = new Date(feedbackDeadline)
      if (Number.isNaN(parsedFeedbackDeadline.getTime()) || parsedFeedbackDeadline <= new Date()) {
        return res.status(400).json({ message: 'feedbackDeadline must be a valid future datetime' })
      }

      version.audioStatus = 'audio_checking_submitted'
      version.currentStage = 'final_verification'
      version.feedback = checkerFeedback || null
      version.feedbackDeadline = parsedFeedbackDeadline
    } else {
      version.audioStatus = 'audio_generated'
      version.currentStage = 'audio_generation'
      version.feedback = checkerFeedback
      version.feedbackDeadline = null
      version.audioRejectionCount += 1
      version.reassignmentCount += 1
    }

    version.isBlockedBySpoc = false
    version.blockerNote = null
    version.isLocked = false
    version.lockedBy = null
    version.lockedUntil = null
    await book.save()

    await Claim.findOneAndUpdate(
      { book: bookId, language: version.language, claimType: 'audio_check', status: 'active' },
      { status: 'submitted' }
    )

    if (normalizedDecision === 'approved') {
      await logAudit({
        req,
        action: 'audio_check_submitted',
        entityType: 'book_version',
        entityId: version._id,
        book: book._id,
        versionId: version._id,
        language: version.language,
        fromState: 'audio_checking_in_progress',
        toState: 'audio_checking_submitted',
        metadata: { feedbackDeadline: parsedFeedbackDeadline }
      })

      // Notify SPOC
      const spoc = await User.findOne({
        language: version.language,
        role: 'spoc',
        status: 'approved'
      })

      if (spoc) {
        await sendMail({
          to: spoc.email,
          subject: `Audio Ready for Final Approval â€” ${book.title} (${version.language})`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
              <p>Pranam <strong>${spoc.name}</strong>,</p>
              <p>Audio verification is complete and ready for your final approval:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
                <strong>Book:</strong> ${book.title}<br/>
                <strong>Language:</strong> ${version.language}<br/>
                <strong>Feedback Deadline:</strong> ${parsedFeedbackDeadline.toLocaleString()}<br/>
                ${checkerFeedback ? `<strong>Checker Notes:</strong> ${checkerFeedback}` : ''}
              </div>
              <a href="${FRONTEND_BASE_URL}"
                 style="background: #1D9E75; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Login to Approve
              </a>
            </div>
          `
        })

        await createNotification({
          userId: spoc._id,
          type: 'task',
          title: 'Audio ready for final approval',
          message: `${book.title} (${version.language}) is waiting for your final decision.`,
          metadata: { bookId: book._id, versionId: version._id, feedbackDeadline: parsedFeedbackDeadline }
        })
      }

      await notifyTaskCompletion({
        userId: req.user._id,
        book,
        version,
        actionLabel: 'Audio verification submission',
        metadata: { claimType: 'audio_check', decision: 'approved' }
      })

      return res.status(200).json({ message: 'Audio approved and sent to SPOC for final review.', version })
    }

    await logAudit({
      req,
      action: 'audio_sent_back_to_recorder',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: 'audio_checking_in_progress',
      toState: 'audio_generated',
      note: checkerFeedback
    })

    const recorder = version.assignedRecorder ? await User.findById(version.assignedRecorder) : null
    if (recorder) {
      await sendMail({
        to: recorder.email,
        subject: `Audio Revision Required â€” ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #E24B4A;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${recorder.name}</strong>,</p>
            <p>Your audio needs revision after audio checking.</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Language:</strong> ${version.language}<br/>
              <strong>Audio Checker Feedback:</strong><br/>
              <p style="color: #E24B4A;">${checkerFeedback}</p>
            </div>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Revise
            </a>
          </div>
        `
      })

      await createNotification({
        userId: recorder._id,
        type: 'feedback',
        title: 'Audio revision requested by audio checker',
        message: `${book.title} (${version.language}) was sent back with audio correction notes.`,
        metadata: { bookId: book._id, versionId: version._id }
      })
    }

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'Audio review and revision feedback',
      metadata: { claimType: 'audio_check', decision: 'rejected' }
    })

    return res.status(200).json({ message: 'Audio rejected and sent back to recorder for revision.', version })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ SPOC final audio approval â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const spocAudioApproval = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { decision, feedback } = req.body
    const normalizedDecision = String(decision || 'approved').toLowerCase()
    const spocFeedback = (feedback || '').trim()

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.language !== version.language) {
      return res.status(403).json({ message: `You can only approve for: ${req.user.language}` })
    }

    if (version.currentStage !== 'final_verification' || version.audioStatus !== 'audio_checking_submitted') {
      return res.status(400).json({ message: 'Audio is not ready for SPOC final approval' })
    }

    if (!['approved', 'rejected'].includes(normalizedDecision)) {
      return res.status(400).json({ message: 'Invalid decision. Use approved or rejected' })
    }

    if (normalizedDecision === 'rejected' && !spocFeedback) {
      return res.status(400).json({ message: 'Feedback is required when rejecting and sending back to recorder' })
    }

    if (normalizedDecision === 'approved') {
      version.audioStatus = 'audio_approved'
      version.currentStage = 'final_verification'
      version.feedback = null
      version.isBlockedBySpoc = false
      version.blockerNote = null
      await book.save()

      try {
        await appendSpocApprovalRecord({
          book,
          version,
          spocUser: req.user
        })
      } catch (sheetError) {
        console.error('Google Sheet logging failed for SPOC approval:', sheetError.message)
      }

      // Send to admin publish queue via in-app notifications only.
      const admins = await User.find({
        role: 'admin',
        status: 'approved',
        isActive: true
      })

      await createBulkNotifications({
        userIds: admins.map((admin) => admin._id),
        type: 'task',
        title: 'Audio ready for publish review',
        message: `${book.title} (${version.language}) is SPOC-approved and awaiting publish action.`,
        metadata: { bookId: book._id, versionId: version._id, audioStatus: version.audioStatus }
      })

      await logAudit({
        req,
        action: 'spoc_audio_approved',
        entityType: 'book_version',
        entityId: version._id,
        book: book._id,
        versionId: version._id,
        language: version.language,
        fromState: 'audio_checking_submitted',
        toState: 'audio_approved'
      })

      await notifyTaskCompletion({
        userId: req.user._id,
        book,
        version,
        actionLabel: 'SPOC audio approval',
        metadata: { decision: 'approved' }
      })

      return res.status(200).json({
        message: `Audio approved and sent to admin publish queue (${admins.length} admins notified in-app).`,
        version
      })
    }

    if (normalizedDecision === 'rejected') {
      version.audioStatus = 'audio_generated'
      version.currentStage = 'audio_generation'
      version.feedback = spocFeedback
      version.reassignmentCount += 1
      version.audioRejectionCount += 1
      version.feedbackDeadline = null
      version.assignedAudioChecker = null
      version.audioCheckerDeadline = null
      await book.save()

      // Send back to same recorder
      const recorder = await User.findById(version.assignedRecorder)
      if (recorder) {
        await sendMail({
          to: recorder.email,
          subject: `Audio Revision Required â€” ${book.title} (${version.language})`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #E24B4A;">Shantikunj Audiobooks LMS</h2>
              <p>Pranam <strong>${recorder.name}</strong>,</p>
              <p>Your audio submission needs revision:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
                <strong>Book:</strong> ${book.title}<br/>
                <strong>Language:</strong> ${version.language}<br/>
                <strong>Feedback:</strong><br/>
                <p style="color: #E24B4A;">${spocFeedback}</p>
              </div>
              <a href="${FRONTEND_BASE_URL}"
                 style="background: #1D9E75; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; display: inline-block;">
                Login to Revise
              </a>
            </div>
          `
        })

        await createNotification({
          userId: recorder._id,
          type: 'feedback',
          title: 'Audio revision requested',
          message: `${book.title} (${version.language}) audio needs corrections.`,
          metadata: { bookId: book._id, versionId: version._id }
        })
      }

      await logAudit({
        req,
        action: 'spoc_audio_rejected',
        entityType: 'book_version',
        entityId: version._id,
        book: book._id,
        versionId: version._id,
        language: version.language,
        fromState: 'audio_checking_submitted',
        toState: 'audio_generated',
        note: spocFeedback
      })

      await notifyTaskCompletion({
        userId: req.user._id,
        book,
        version,
        actionLabel: 'SPOC audio review',
        metadata: { decision: 'rejected' }
      })

      return res.status(200).json({
        message: 'Audio rejected and sent back to recorder with SPOC feedback.',
        version
      })
    }

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Admin publishes book version â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const publishBook = async (req, res) => {
  try {
    const { bookId, versionId } = req.params

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.audioStatus !== 'audio_approved') {
      return res.status(400).json({ message: 'Only SPOC-approved audio can be published' })
    }

    if (version.isBlockedBySpoc) {
      return res.status(400).json({ message: 'Cannot publish while SPOC blocker is active' })
    }

    const normalizedTextFilesMeta = normalizeFileMetadata({
      metadata: version.textFilesMeta,
      urls: [
        ...(Array.isArray(version.textFileUrls) ? version.textFileUrls : []),
        version.textFileUrl
      ],
      kind: 'document'
    })
    const normalizedTextUrls = normalizedTextFilesMeta.map((item) => item.url)

    const normalizedAudioFilesMeta = normalizeFileMetadata({
      metadata: version.audioFilesMeta,
      urls: [
        ...(Array.isArray(version.audioFiles) ? version.audioFiles : []),
        version.audioUrl
      ],
      kind: 'audio'
    })
    const normalizedAudioUrls = normalizedAudioFilesMeta.map((item) => item.url)

    const hasTranslatedText = Boolean(String(version.translatedText || '').trim()) || normalizedTextUrls.length > 0
    if (!hasTranslatedText) {
      return res.status(400).json({ message: 'Cannot publish without translated text saved for this language version' })
    }

    if (normalizedAudioUrls.length === 0) {
      return res.status(400).json({ message: 'Cannot publish without generated audio saved for this language version' })
    }

    // Ensure canonical asset fields remain populated.
    version.textFileUrl = normalizedTextUrls[0] || null
    version.textFileUrls = normalizedTextUrls
    version.textFilesMeta = stampMetadataForSave(normalizedTextFilesMeta, version.assignedTranslator || req.user?._id)
    version.audioUrl = normalizedAudioUrls[0] || null
    version.audioFiles = normalizedAudioUrls
    version.audioFilesMeta = stampMetadataForSave(normalizedAudioFilesMeta, version.assignedRecorder || req.user?._id)

    // Persist an immutable publish-time snapshot for final archived output.
    version.publishedTextFileUrl = normalizedTextUrls[0] || null
    version.publishedTextFileUrls = normalizedTextUrls
    version.publishedTextFilesMeta = version.textFilesMeta
    version.publishedTranslatedText = String(version.translatedText || '').trim() || null
    version.publishedAudioUrl = normalizedAudioUrls[0] || null
    version.publishedAudioFiles = normalizedAudioUrls
    version.publishedAudioFilesMeta = version.audioFilesMeta
    version.publishedAt = new Date()
    version.publishedBy = req.user._id

    version.audioStatus = 'published'
    version.currentStage = 'published'
    version.isLocked = false
    await book.save()

    // Notify entire language team for this language on publish.
    const teamMembers = await User.find({
      language: version.language,
      role: { $in: LANGUAGE_TEAM_ROLES },
      status: 'approved',
      isActive: true
    }).select('_id name email role')

    const publishMailSummary = {
      attempted: teamMembers.length,
      sent: 0,
      failed: 0,
      failures: []
    }

    for (const member of teamMembers) {
      const sendResult = await sendMailWithRetry({
        to: member.email,
        subject: `ðŸŽ‰ Published! â€” ${book.title} (${version.language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${member.name}</strong>,</p>
            <p>ðŸŽ‰ The following audiobook has been officially published!</p>
            <div style="background: #E1F5EE; padding: 16px; border-radius: 8px;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Language:</strong> ${version.language}
            </div>
            <p>Thank you for your contribution to this divine work! ðŸ™</p>
          </div>
        `
      })

      if (sendResult.ok) {
        publishMailSummary.sent += 1
      } else {
        publishMailSummary.failed += 1
        publishMailSummary.failures.push({
          email: member.email,
          role: member.role,
          reason: sendResult.error?.message || 'Unknown mail error'
        })
      }
    }

    if (teamMembers.length > 0) {
      await createBulkNotifications({
        userIds: teamMembers.map((member) => member._id),
        type: 'system',
        title: 'Audiobook published',
        message: `${book.title} (${version.language}) is now published.`,
        metadata: { bookId: book._id, versionId: version._id }
      })
    }

    await logAudit({
      req,
      action: 'book_version_published',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      fromState: 'audio_approved',
      toState: 'published'
    })

    await notifyTaskCompletion({
      userId: req.user._id,
      book,
      version,
      actionLabel: 'Publishing',
      metadata: { decision: 'published' }
    })

    const mailStatus = publishMailSummary.attempted > 0
      ? `Publication mails sent: ${publishMailSummary.sent}/${publishMailSummary.attempted}.`
      : 'No active approved language team members to notify.'

    res.status(200).json({
      message: `${book.title} (${version.language}) published successfully! ðŸŽ‰ Final text/audio snapshot saved. ${mailStatus}`,
      publishMailSummary,
      version
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Update text status (manual) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const updateTextStatus = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { textStatus, feedback } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    version.textStatus = textStatus
    if (feedback) version.feedback = feedback
    await book.save()

    res.status(200).json({ message: 'Text status updated', version })
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Update audio status (manual) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const updateAudioStatus = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { audioStatus, audioUrl, audioUrls, audioFilesMeta, audioFiles, feedback } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    version.audioStatus = audioStatus
    const normalizedAudioFilesMeta = normalizeFileMetadata({
      metadata: [...asArray(version.audioFilesMeta), ...asArray(audioFilesMeta), ...asArray(audioFiles)],
      urls: normalizeAudioUrls({ audioUrl, audioUrls }),
      kind: 'audio'
    })
    const normalizedAudioUrls = normalizedAudioFilesMeta.map((item) => item.url)

    if (normalizedAudioUrls.length > 0) {
      version.audioUrl = normalizedAudioUrls[0]
      version.audioFiles = normalizedAudioUrls
      version.audioFilesMeta = stampMetadataForSave(normalizedAudioFilesMeta, req.user?._id)
    }
    if (feedback) version.feedback = feedback
    await book.save()

    res.status(200).json({ message: 'Audio status updated', version })
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Assign to checker (admin/spoc) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const assignToChecker = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { checkerId, deadline } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.role === 'spoc' && req.user.language !== version.language) {
      return res.status(403).json({ message: `You can only assign for: ${req.user.language}` })
    }

    const checker = await User.findById(checkerId)
    if (!checker || checker.role !== 'checker' || checker.status !== 'approved' || !checker.isActive) {
      return res.status(400).json({ message: 'Selected user is not an active approved checker' })
    }

    if (checker.language !== version.language) {
      return res.status(400).json({ message: 'Selected checker must belong to the same language' })
    }

    const parsedDeadline = new Date(deadline)
    if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline <= new Date()) {
      return res.status(400).json({ message: 'deadline must be a valid future datetime' })
    }

    const conflictingClaim = await hasConflictingActiveCheckingClaim(checker._id, {
      bookId: book._id,
      language: version.language
    })

    if (conflictingClaim) {
      return res.status(400).json({
        message: `Selected checker already has an active checking claim for ${conflictingClaim.book?.title || 'another book'}.`
      })
    }

    const now = new Date()
    const msInDay = 1000 * 60 * 60 * 24
    const daysCommitted = Math.max(1, Math.ceil((parsedDeadline - now) / msInDay))

    await Claim.updateMany(
      {
        book: book._id,
        language: version.language,
        claimType: 'checking',
        status: 'active'
      },
      { status: 'released' }
    )

    await Claim.create({
      book: book._id,
      language: version.language,
      claimedBy: checker._id,
      claimType: 'checking',
      daysCommitted,
      deadline: parsedDeadline,
      status: 'active'
    })

    version.assignedChecker = checker._id
    version.checkerDeadline = parsedDeadline
    version.textStatus = 'checking_in_progress'
    version.currentStage = 'checking'
    version.isLocked = true
    version.lockedBy = checker._id
    version.lockedUntil = parsedDeadline
    await book.save()

    res.status(200).json({ message: 'Book version assigned to checker', version })
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const setSpocBlocker = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { isBlocked, blockerNote } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.language !== version.language) {
      return res.status(403).json({ message: `You can only manage blocker for: ${req.user.language}` })
    }

    version.isBlockedBySpoc = Boolean(isBlocked)
    version.blockerNote = isBlocked ? (blockerNote || 'Blocked by SPOC') : null
    await book.save()

    await logAudit({
      req,
      action: version.isBlockedBySpoc ? 'spoc_blocker_enabled' : 'spoc_blocker_removed',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      note: version.blockerNote
    })

    return res.status(200).json({
      message: version.isBlockedBySpoc ? 'Blocker enabled' : 'Blocker removed',
      version
    })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const reassignAfterRejections = async (req, res) => {
  try {
    const { bookId, versionId } = req.params
    const { assignmentType, newUserId, deadline } = req.body

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.id(versionId)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (req.user.role === 'spoc' && req.user.language !== version.language) {
      return res.status(403).json({ message: `You can only reassign for: ${req.user.language}` })
    }

    const parsedDeadline = new Date(deadline)
    if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline <= new Date()) {
      return res.status(400).json({ message: 'deadline must be a valid future datetime' })
    }

    const newAssignee = await User.findById(newUserId)
    if (!newAssignee || newAssignee.status !== 'approved' || !newAssignee.isActive) {
      return res.status(404).json({ message: 'New assignee is not available' })
    }

    if (newAssignee.language !== version.language) {
      return res.status(400).json({ message: 'New assignee must belong to the same language' })
    }

    if (assignmentType === 'checker') {
      if (version.textRejectionCount < REASSIGNMENT_THRESHOLD) {
        return res.status(400).json({
          message: `Checker reassignment is allowed after ${REASSIGNMENT_THRESHOLD} text rejections`
        })
      }

      if (newAssignee.role !== 'checker') {
        return res.status(400).json({ message: 'Selected user is not a checker' })
      }

      const conflictingClaim = await hasConflictingActiveCheckingClaim(newAssignee._id, {
        bookId: book._id,
        language: version.language
      })

      if (conflictingClaim) {
        return res.status(400).json({
          message: `Selected checker already has an active checking claim for ${conflictingClaim.book?.title || 'another book'}.`
        })
      }

      await Claim.findOneAndUpdate(
        {
          book: book._id,
          language: version.language,
          claimType: 'checking',
          status: 'active'
        },
        { status: 'released' }
      )

      const daysCommitted = Math.max(1, Math.ceil((parsedDeadline - new Date()) / (1000 * 60 * 60 * 24)))
      await Claim.create({
        book: book._id,
        language: version.language,
        claimedBy: newAssignee._id,
        claimType: 'checking',
        daysCommitted,
        deadline: parsedDeadline,
        status: 'active'
      })

      version.assignedChecker = newAssignee._id
      version.checkerDeadline = parsedDeadline
      version.textStatus = 'checking_in_progress'
      version.currentStage = 'checking'
      version.isLocked = true
      version.lockedBy = newAssignee._id
      version.lockedUntil = parsedDeadline
    } else if (assignmentType === 'recorder') {
      if (version.audioRejectionCount < REASSIGNMENT_THRESHOLD) {
        return res.status(400).json({
          message: `Recorder reassignment is allowed after ${REASSIGNMENT_THRESHOLD} audio rejections`
        })
      }

      if (newAssignee.role !== 'recorder') {
        return res.status(400).json({ message: 'Selected user is not a recorder' })
      }

      await Claim.findOneAndUpdate(
        {
          book: book._id,
          language: version.language,
          claimType: 'audio',
          status: 'active'
        },
        { status: 'released' }
      )

      const daysCommitted = Math.max(1, Math.ceil((parsedDeadline - new Date()) / (1000 * 60 * 60 * 24)))
      await Claim.create({
        book: book._id,
        language: version.language,
        claimedBy: newAssignee._id,
        claimType: 'audio',
        daysCommitted,
        deadline: parsedDeadline,
        status: 'active'
      })

      version.assignedRecorder = newAssignee._id
      version.recorderDeadline = parsedDeadline
      version.audioStatus = 'audio_generated'
      version.currentStage = 'audio_generation'
      version.isLocked = true
      version.lockedBy = newAssignee._id
      version.lockedUntil = parsedDeadline
      version.feedbackDeadline = null
      version.isBlockedBySpoc = false
      version.blockerNote = null
    } else {
      return res.status(400).json({ message: 'assignmentType must be checker or recorder' })
    }

    await book.save()

    await logAudit({
      req,
      action: 'task_reassigned_after_rejections',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language: version.language,
      metadata: { assignmentType, newUserId, deadline: parsedDeadline }
    })

    return res.status(200).json({ message: 'Reassignment completed', version })
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

module.exports = {
  addBook,
  getAllBooks,
  getBookById,
  getTextAccessUrl,
  getSourcePdfAccessUrl,
  uploadTranslationDocument,
  uploadAudioFile,
  assignUnclaimedVersion,
  assignToChecker,
  reassignAfterRejections,
  setSpocBlocker,
  updateTextStatus,
  updateAudioStatus,
  getMyAssignedBooks,
  submitTranslation,
  submitVettedText,
  spocReviewText,
  submitAudio,
  submitAudioReview,
  spocAudioApproval,
  publishBook
}