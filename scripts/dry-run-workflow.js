const path = require('path')
const dotenv = require('dotenv')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const request = require('supertest')

const User = require('../models/User')
const Book = require('../models/Book')
const { TRANSLATION_LANGUAGES } = require('../constants/languages')
const { app } = require('../index')

dotenv.config({ path: path.join(__dirname, '..', '.env') })

const PASSWORD = 'DryRun@123'
const DRY_RUN_LANGUAGE = 'English'

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const readErrorMessage = (response) => {
  const bodyMessage = response?.body?.message
  const bodyError = response?.body?.error
  if (bodyMessage && bodyError) return `${bodyMessage} (${bodyError})`
  if (bodyMessage) return bodyMessage
  if (bodyError) return bodyError
  return response?.text || 'Unknown API error'
}

const assertOk = (response, expectedStatuses = [200, 201]) => {
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status}: ${readErrorMessage(response)}`)
  }
  return response
}

const apiRequest = async ({ method, url, token, body, expectedStatuses }) => {
  let req = request(app)[method](url)

  if (token) {
    req = req.set('Authorization', `Bearer ${token}`)
  }

  if (body) {
    req = req.send(body)
  }

  const response = await req
  return assertOk(response, expectedStatuses)
}

const ensureUser = async ({ email, name, role, language }) => {
  const normalizedEmail = String(email).trim().toLowerCase()
  const hashedPassword = await bcrypt.hash(PASSWORD, 10)
  const requestedRole = role === 'admin' ? null : role
  const requestedLanguage = role === 'admin' ? null : language

  let user = await User.findOne({ email: normalizedEmail })

  if (!user) {
    user = await User.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role,
      requestedRole,
      language,
      requestedLanguage,
      status: 'approved',
      isActive: true,
      authMethod: 'local',
      googleId: null,
      emailVerified: true
    })

    return user
  }

  user.name = name
  user.password = hashedPassword
  user.role = role
  user.requestedRole = requestedRole
  user.language = language
  user.requestedLanguage = requestedLanguage
  user.status = 'approved'
  user.isActive = true
  user.authMethod = 'local'
  user.googleId = null
  user.emailVerified = true
  await user.save()
  return user
}

const loginAndGetToken = async (email) => {
  const response = await apiRequest({
    method: 'post',
    url: '/api/auth/login',
    body: { email, password: PASSWORD },
    expectedStatuses: [200]
  })

  return response.body.token
}

const findVersion = (book, language) => {
  const version = (book.languageVersions || []).find((item) => item.language === language)
  if (!version) {
    throw new Error(`Language version not found for ${language}`)
  }
  return version
}

const getBookAndVersion = async (bookId, language, adminToken) => {
  const response = await apiRequest({
    method: 'get',
    url: `/api/books/${bookId}`,
    token: adminToken,
    expectedStatuses: [200]
  })

  const version = findVersion(response.body, language)
  return {
    book: response.body,
    version
  }
}

const stepResults = []

const runStep = async (label, action) => {
  try {
    const detail = await action()
    stepResults.push({ label, status: 'PASS', detail: detail || '' })
    return detail
  } catch (error) {
    stepResults.push({ label, status: 'FAIL', detail: error.message })
    throw error
  }
}

const printSummary = ({ bookNumber, inviteSummary, publishSummary, finalVersion }) => {
  console.log('\n=== DRY RUN SUMMARY ===')
  console.log(`Book Number: ${bookNumber}`)
  console.log(`Language Tested End-to-End: ${DRY_RUN_LANGUAGE}`)

  console.log('\nStep Results:')
  stepResults.forEach((item, index) => {
    const prefix = item.status === 'PASS' ? 'PASS' : 'FAIL'
    const detail = item.detail ? ` -> ${item.detail}` : ''
    console.log(`${index + 1}. [${prefix}] ${item.label}${detail}`)
  })

  if (inviteSummary) {
    console.log('\nAdd-Book Invite Mail Summary:')
    console.log(`- languagesOpenedForClaim: ${inviteSummary.languagesOpenedForClaim}`)
    console.log(`- languagesWithRecipients: ${inviteSummary.languagesWithRecipients}`)
    console.log(`- totalEmailsAttempted: ${inviteSummary.totalEmailsAttempted}`)
    console.log(`- totalEmailsSent: ${inviteSummary.totalEmailsSent}`)
    console.log(`- totalEmailsFailed: ${inviteSummary.totalEmailsFailed}`)
    console.log(`- languagesWithoutRecipients: ${(inviteSummary.languagesWithoutRecipients || []).length}`)
    console.log(`- languagesSkippedByConfig: ${(inviteSummary.languagesSkippedByConfig || []).length}`)
  }

  if (publishSummary) {
    console.log('\nPublish Mail Summary:')
    console.log(`- attempted: ${publishSummary.attempted}`)
    console.log(`- sent: ${publishSummary.sent}`)
    console.log(`- failed: ${publishSummary.failed}`)
  }

  console.log('\nFinal Stored Snapshot Check:')
  console.log(`- currentStage: ${finalVersion.currentStage}`)
  console.log(`- audioStatus: ${finalVersion.audioStatus}`)
  console.log(`- publishedTextFileUrl: ${finalVersion.publishedTextFileUrl || 'MISSING'}`)
  console.log(`- publishedAudioUrl: ${finalVersion.publishedAudioUrl || 'MISSING'}`)
  console.log(`- publishedAt: ${finalVersion.publishedAt || 'MISSING'}`)

  console.log('\nDry run completed.')
}

const main = async () => {
  const runId = Date.now()
  const bookNumber = Number(String(runId).slice(-6))
  const bookTitle = `Dry Run Book ${runId}`

  const coreUsers = {
    admin: {
      email: `dryrun.admin.${runId}@shantikunj.com`,
      name: 'Dry Run Admin',
      role: 'admin',
      language: DRY_RUN_LANGUAGE
    },
    translator: {
      email: `dryrun.translator.${runId}@shantikunj.com`,
      name: 'Dry Run Translator',
      role: 'translator',
      language: DRY_RUN_LANGUAGE
    },
    checker: {
      email: `dryrun.checker.${runId}@shantikunj.com`,
      name: 'Dry Run Text Vetter',
      role: 'checker',
      language: DRY_RUN_LANGUAGE
    },
    spoc: {
      email: `dryrun.spoc.${runId}@shantikunj.com`,
      name: 'Dry Run SPOC',
      role: 'spoc',
      language: DRY_RUN_LANGUAGE
    },
    recorder: {
      email: `dryrun.recorder.${runId}@shantikunj.com`,
      name: 'Dry Run Recorder',
      role: 'recorder',
      language: DRY_RUN_LANGUAGE
    },
    audioChecker: {
      email: `dryrun.audio-checker.${runId}@shantikunj.com`,
      name: 'Dry Run Audio Checker',
      role: 'audio_checker',
      language: DRY_RUN_LANGUAGE
    },
    regionalTeam: {
      email: `dryrun.regional.${runId}@shantikunj.com`,
      name: 'Dry Run Regional Team',
      role: 'regional_team',
      language: DRY_RUN_LANGUAGE
    }
  }

  const inviteUserSetup = async () => {
    for (const language of TRANSLATION_LANGUAGES) {
      const languageSlug = slugify(language)

      await ensureUser({
        email: `dryrun.invite.translator.${languageSlug}@shantikunj.com`,
        name: `Invite Translator ${language}`,
        role: 'translator',
        language
      })

      await ensureUser({
        email: `dryrun.invite.spoc.${languageSlug}@shantikunj.com`,
        name: `Invite SPOC ${language}`,
        role: 'spoc',
        language
      })
    }
  }

  await mongoose.connect(process.env.MONGO_URI)

  let inviteSummary = null
  let publishSummary = null
  let finalVersion = null

  try {
    await runStep('Setup translator + SPOC users for all supported languages', async () => {
      await inviteUserSetup()
      return `${TRANSLATION_LANGUAGES.length} languages prepared`
    })

    await runStep('Setup core role users for end-to-end flow (single language)', async () => {
      for (const value of Object.values(coreUsers)) {
        await ensureUser(value)
      }
      return 'admin/translator/checker/spoc/recorder/audio_checker/regional_team ready'
    })

    const tokens = {}

    await runStep('Login all core users', async () => {
      tokens.admin = await loginAndGetToken(coreUsers.admin.email)
      tokens.translator = await loginAndGetToken(coreUsers.translator.email)
      tokens.checker = await loginAndGetToken(coreUsers.checker.email)
      tokens.spoc = await loginAndGetToken(coreUsers.spoc.email)
      tokens.recorder = await loginAndGetToken(coreUsers.recorder.email)
      tokens.audioChecker = await loginAndGetToken(coreUsers.audioChecker.email)
      return 'all role tokens issued'
    })

    let bookId = ''
    let versionId = ''

    await runStep('Admin adds book and triggers translator/SPOC invite mail for all languages', async () => {
      const response = await apiRequest({
        method: 'post',
        url: '/api/books',
        token: tokens.admin,
        body: {
          title: bookTitle,
          bookNumber,
          description: 'Automated dry run workflow book'
        },
        expectedStatuses: [201]
      })

      inviteSummary = response.body.inviteSummary || null
      bookId = response.body.book?._id
      versionId = findVersion(response.body.book, DRY_RUN_LANGUAGE)._id

      return `bookId=${bookId}, versionId=${versionId}`
    })

    await runStep('Translator claims translation task', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.translator,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'translation',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })
      return 'translation claim success'
    })

    await runStep('Translator submits translation v1', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-translation`,
        token: tokens.translator,
        body: {
          textFileUrl: `https://example.com/${runId}-translation-v1.pdf`
        },
        expectedStatuses: [200]
      })
      return 'submitted for text vetting'
    })

    await runStep('Text vetter claims checking task', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.checker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'checking',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })
      return 'checking claim success'
    })

    await runStep('Text vetter rejects v1 with feedback', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-vetted-text`,
        token: tokens.checker,
        body: {
          decision: 'revision',
          feedback: 'Please fix terminology and punctuation in chapter 2.'
        },
        expectedStatuses: [200]
      })
      return 'sent back to translator'
    })

    await runStep('Translator re-claims and submits corrected translation v2', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.translator,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'translation',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-translation`,
        token: tokens.translator,
        body: {
          textFileUrl: `https://example.com/${runId}-translation-v2.pdf`
        },
        expectedStatuses: [200]
      })

      return 'v2 submitted'
    })

    await runStep('Text vetter approves v2 and sends to SPOC', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.checker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'checking',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-vetted-text`,
        token: tokens.checker,
        body: {
          decision: 'approved',
          textFileUrl: `https://example.com/${runId}-vetted-v2.pdf`
        },
        expectedStatuses: [200]
      })

      return 'moved to SPOC review'
    })

    await runStep('SPOC rejects text once and sends back to translator', async () => {
      await apiRequest({
        method: 'put',
        url: `/api/books/${bookId}/versions/${versionId}/spoc-review`,
        token: tokens.spoc,
        body: {
          decision: 'rejected',
          feedback: 'Improve devotional tone consistency in 3 paragraphs.'
        },
        expectedStatuses: [200]
      })
      return 'sent back by SPOC'
    })

    await runStep('Translator submits corrected translation v3', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.translator,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'translation',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-translation`,
        token: tokens.translator,
        body: {
          textFileUrl: `https://example.com/${runId}-translation-v3.pdf`
        },
        expectedStatuses: [200]
      })

      return 'v3 submitted'
    })

    await runStep('Text vetter approves v3 and sends to SPOC', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.checker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'checking',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-vetted-text`,
        token: tokens.checker,
        body: {
          decision: 'approved',
          textFileUrl: `https://example.com/${runId}-vetted-v3.pdf`
        },
        expectedStatuses: [200]
      })

      return 'text ready for SPOC'
    })

    await runStep('SPOC approves text and opens audio generation', async () => {
      await apiRequest({
        method: 'put',
        url: `/api/books/${bookId}/versions/${versionId}/spoc-review`,
        token: tokens.spoc,
        body: {
          decision: 'approved'
        },
        expectedStatuses: [200]
      })
      return 'moved to audio generation'
    })

    await runStep('Recorder claims and uploads audio v1', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.recorder,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'audio',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio`,
        token: tokens.recorder,
        body: {
          audioUrl: `https://example.com/${runId}-audio-v1.mp3`
        },
        expectedStatuses: [200]
      })

      return 'audio submitted for checking'
    })

    await runStep('Audio checker claims and rejects v1 with feedback', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.audioChecker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'audio_check',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio-review`,
        token: tokens.audioChecker,
        body: {
          decision: 'rejected',
          feedback: 'There is clipping at minute 2:15. Please re-record.'
        },
        expectedStatuses: [200]
      })

      return 'sent back to recorder'
    })

    await runStep('Recorder re-submits corrected audio v2 (assigned revision)', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio`,
        token: tokens.recorder,
        body: {
          audioUrl: `https://example.com/${runId}-audio-v2.mp3`
        },
        expectedStatuses: [200]
      })

      return 'audio v2 submitted'
    })

    await runStep('Audio checker approves v2 and sends to SPOC', async () => {
      const feedbackDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.audioChecker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'audio_check',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio-review`,
        token: tokens.audioChecker,
        body: {
          decision: 'approved',
          feedbackDeadline
        },
        expectedStatuses: [200]
      })

      return 'audio moved to final verification'
    })

    await runStep('SPOC rejects once and sends audio back to recorder', async () => {
      await apiRequest({
        method: 'put',
        url: `/api/books/${bookId}/versions/${versionId}/spoc-audio-approval`,
        token: tokens.spoc,
        body: {
          decision: 'rejected',
          feedback: 'Background music level is high in one segment.'
        },
        expectedStatuses: [200]
      })

      return 'audio sent back by SPOC'
    })

    await runStep('Recorder uploads final corrected audio v3 (assigned revision)', async () => {
      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio`,
        token: tokens.recorder,
        body: {
          audioUrl: `https://example.com/${runId}-audio-v3.mp3`
        },
        expectedStatuses: [200]
      })

      return 'audio v3 submitted'
    })

    await runStep('Audio checker approves final audio and forwards to SPOC', async () => {
      const feedbackDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

      await apiRequest({
        method: 'post',
        url: `/api/claims/books/${bookId}/claim`,
        token: tokens.audioChecker,
        body: {
          language: DRY_RUN_LANGUAGE,
          claimType: 'audio_check',
          daysCommitted: 2
        },
        expectedStatuses: [201]
      })

      await apiRequest({
        method: 'post',
        url: `/api/books/${bookId}/versions/${versionId}/submit-audio-review`,
        token: tokens.audioChecker,
        body: {
          decision: 'approved',
          feedbackDeadline
        },
        expectedStatuses: [200]
      })

      return 'audio ready for SPOC final approval'
    })

    await runStep('SPOC approves audio and sends to admin publish queue', async () => {
      await apiRequest({
        method: 'put',
        url: `/api/books/${bookId}/versions/${versionId}/spoc-audio-approval`,
        token: tokens.spoc,
        body: {
          decision: 'approved'
        },
        expectedStatuses: [200]
      })

      return 'audio approved by SPOC'
    })

    await runStep('Admin publishes the language version', async () => {
      const response = await apiRequest({
        method: 'put',
        url: `/api/books/${bookId}/versions/${versionId}/publish`,
        token: tokens.admin,
        expectedStatuses: [200]
      })

      publishSummary = response.body.publishMailSummary || null
      return response.body.message || 'publish completed'
    })

    await runStep('Verify publish snapshot saved in DB', async () => {
      const { version } = await getBookAndVersion(bookId, DRY_RUN_LANGUAGE, tokens.admin)
      finalVersion = version

      if (version.currentStage !== 'published' || version.audioStatus !== 'published') {
        throw new Error('Final stage/status is not published')
      }

      if (!version.publishedTextFileUrl || !version.publishedAudioUrl || !version.publishedAt) {
        throw new Error('Published text/audio snapshot fields are missing')
      }

      return 'published snapshot fields are present'
    })

    printSummary({
      bookNumber,
      inviteSummary,
      publishSummary,
      finalVersion
    })
  } catch (error) {
    console.error('\nDry run failed:', error.message)
    console.error('\nStep Trace:')
    stepResults.forEach((item, index) => {
      const detail = item.detail ? ` -> ${item.detail}` : ''
      console.error(`${index + 1}. [${item.status}] ${item.label}${detail}`)
    })
    process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}

main()
