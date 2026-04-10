const Claim = require('../models/Claim')
const Book = require('../models/Book')
const User = require('../models/User')
const sendMail = require('../config/mailer')
const { createNotification, createBulkNotifications } = require('../services/notificationService')
const { logAudit } = require('../services/auditService')
const FRONTEND_BASE_URL = String(process.env.FRONTEND_URL || 'http://localhost:5173').trim().replace(/\/+$/, '')

const CLAIM_TO_ROLE = {
  translation: 'translator',
  checking: 'checker',
  audio: 'recorder',
  audio_check: 'audio_checker'
}

const STAGE_LABELS = {
  translation: 'Translation',
  checking: 'Text Verification',
  audio: 'Audio Generation',
  audio_check: 'Audio Verification'
}

const resetVersionForExpiredClaim = (version, claimType) => {
  version.isLocked = false
  version.lockedBy = null
  version.lockedUntil = null

  if (claimType === 'translation') {
    version.assignedTranslator = null
    version.translatorDeadline = null
    version.currentStage = 'translation'
    version.textStatus = 'not_started'
  } else if (claimType === 'checking') {
    version.assignedChecker = null
    version.checkerDeadline = null
    version.currentStage = 'checking'
    version.textStatus = 'translation_submitted'
  } else if (claimType === 'audio') {
    version.assignedRecorder = null
    version.recorderDeadline = null
    version.currentStage = 'audio_generation'
    version.audioStatus = 'audio_generated'
  } else if (claimType === 'audio_check') {
    version.assignedAudioChecker = null
    version.audioCheckerDeadline = null
    version.currentStage = 'audio_checking'
    version.audioStatus = 'audio_submitted'
  }

  version.interestEmailSent = true
  version.interestEmailSentAt = new Date()
}

const expireOverdueClaimsForUser = async (userId) => {
  const overdueClaims = await Claim.find({
    claimedBy: userId,
    status: 'active',
    deadline: { $lt: new Date() }
  })

  if (overdueClaims.length === 0) return

  for (const claim of overdueClaims) {
    claim.status = 'expired'
    await claim.save()

    const book = await Book.findById(claim.book)
    if (!book) continue

    const version = book.languageVersions.find((item) => item.language === claim.language)
    if (!version) continue

    resetVersionForExpiredClaim(version, claim.claimType)
    await book.save()
  }
}

const findPendingRecorderRevisionTask = async (userId) => {
  const book = await Book.findOne({
    languageVersions: {
      $elemMatch: {
        assignedRecorder: userId,
        currentStage: 'audio_generation',
        audioStatus: 'audio_generated',
        audioRejectionCount: { $gt: 0 }
      }
    }
  }).select('title bookNumber languageVersions')

  if (!book) return null

  const version = (book.languageVersions || []).find((item) => {
    const isAssignedToRecorder = item.assignedRecorder && item.assignedRecorder.toString() === userId.toString()
    return isAssignedToRecorder &&
      item.currentStage === 'audio_generation' &&
      item.audioStatus === 'audio_generated' &&
      Number(item.audioRejectionCount || 0) > 0
  })

  if (!version) return null

  return {
    bookId: book._id,
    versionId: version._id,
    title: book.title,
    bookNumber: book.bookNumber,
    language: version.language
  }
}

const validateClaimStage = (version, claimType) => {
  if (claimType === 'translation') {
    return version.currentStage === 'translation' &&
      ['not_started', 'translation_in_progress'].includes(version.textStatus)
  }

  if (claimType === 'checking') {
    return version.currentStage === 'checking' &&
      ['translation_submitted', 'checking_in_progress'].includes(version.textStatus)
  }

  if (claimType === 'audio') {
    return version.currentStage === 'audio_generation' && version.textStatus === 'text_approved'
  }

  if (claimType === 'audio_check') {
    return version.currentStage === 'audio_checking' &&
      ['audio_submitted', 'audio_checking_in_progress'].includes(version.audioStatus)
  }

  return false
}

const getClaimLockQuery = (bookId, language, claimType) => {
  const baseQuery = {
    _id: bookId,
    languageVersions: {
      $elemMatch: {
        language,
        isLocked: false
      }
    }
  }

  if (claimType === 'translation') {
    baseQuery.languageVersions.$elemMatch.currentStage = 'translation'
  } else if (claimType === 'checking') {
    baseQuery.languageVersions.$elemMatch.currentStage = 'checking'
  } else if (claimType === 'audio') {
    baseQuery.languageVersions.$elemMatch.currentStage = 'audio_generation'
    baseQuery.languageVersions.$elemMatch.textStatus = 'text_approved'
    baseQuery.languageVersions.$elemMatch.assignedRecorder = null
  } else if (claimType === 'audio_check') {
    baseQuery.languageVersions.$elemMatch.currentStage = 'audio_checking'
    baseQuery.languageVersions.$elemMatch.audioStatus = 'audio_submitted'
  }

  return baseQuery
}

// â”€â”€ Admin sends interest email to language team â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sendInterestEmail = async (req, res) => {
  try {
    const { bookId } = req.params
    const { language, stage } = req.body
    // stage = 'translation' | 'checking' | 'audio' | 'audio_check'

    if (!CLAIM_TO_ROLE[stage]) {
      return res.status(400).json({ message: 'Invalid stage' })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.find(v => v.language === language)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.isLocked) {
      return res.status(400).json({ message: 'This version is already claimed' })
    }

    // Find right role based on stage
    const targetRole = CLAIM_TO_ROLE[stage]

    const teamMembers = await User.find({
      language,
      role: targetRole,
      status: 'approved',
      isActive: true
    }).select('name email')

    if (teamMembers.length === 0) {
      return res.status(404).json({
        message: `No approved ${targetRole}s found for language: ${language}`
      })
    }

    const sentEmails = []
    const failedEmails = []

    for (const member of teamMembers) {
      const mailResult = await sendMail({
        to: member.email,
        subject: `New ${STAGE_LABELS[stage]} Task - ${book.title} (${language})`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
            <p>Pranam <strong>${member.name}</strong>,</p>
            <p>A new task has been opened for your role.</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
              <strong>Book:</strong> ${book.title}<br/>
              <strong>Book Number:</strong> ${book.bookNumber}<br/>
              <strong>Language:</strong> ${language}<br/>
              <strong>Task Stage:</strong> ${STAGE_LABELS[stage]}
            </div>
            <p>Login to LMS and claim this task. The first eligible claimant gets assigned.</p>
            <a href="${FRONTEND_BASE_URL}"
               style="background: #1D9E75; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; display: inline-block;">
              Login to Claim
            </a>
            <p style="color: #888; font-size: 12px;">
              This is an automated message from Shantikunj LMS.
            </p>
          </div>
        `
      })

      if (mailResult?.sent) {
        sentEmails.push(member.email)
      } else {
        failedEmails.push({
          email: member.email,
          reason: mailResult?.error || 'Mail dispatch failed'
        })
      }
    }

    await createBulkNotifications({
      userIds: teamMembers.map((member) => member._id),
      type: 'task',
      title: `${STAGE_LABELS[stage]} task available`,
      message: `${book.title} (${language}) is open for claim.`,
      metadata: { bookId: book._id, language, stage }
    })

    version.interestEmailSent = true
    version.interestEmailSentAt = new Date()
    await book.save()

    res.status(200).json({
      message: `${STAGE_LABELS[stage]} email dispatch completed (${sentEmails.length}/${teamMembers.length} sent)`,
      emailsSentTo: sentEmails,
      failedEmails
    })

    await logAudit({
      req,
      action: 'interest_email_sent',
      entityType: 'book_version',
      entityId: version._id,
      book: book._id,
      versionId: version._id,
      language,
      note: `${stage} email dispatch completed (${sentEmails.length}/${teamMembers.length} sent)`,
      metadata: { stage, targetRole }
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ User claims a book version â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const claimBook = async (req, res) => {
  try {
    const { bookId } = req.params
    const { language, daysCommitted, claimType } = req.body
    // claimType = 'translation' | 'checking' | 'audio' | 'audio_check'
    const userId = req.user._id

    if (!CLAIM_TO_ROLE[claimType]) {
      return res.status(400).json({ message: 'Invalid claim type' })
    }

    await expireOverdueClaimsForUser(userId)

    if (CLAIM_TO_ROLE[claimType] !== req.user.role) {
      return res.status(403).json({
        message: `Role ${req.user.role} cannot claim ${claimType} tasks`
      })
    }

    if (claimType === 'audio' && req.user.role === 'recorder') {
      const pendingRevisionTask = await findPendingRecorderRevisionTask(userId)
      if (pendingRevisionTask) {
        return res.status(400).json({
          message: `You must resubmit your revision task for ${pendingRevisionTask.title} (${pendingRevisionTask.language}) before claiming a new audio book.`
        })
      }
    }

    const committedDays = Number(daysCommitted)
    if (!Number.isInteger(committedDays) || committedDays < 1 || committedDays > 30) {
      return res.status(400).json({ message: 'daysCommitted must be an integer between 1 and 30' })
    }

    const book = await Book.findById(bookId)
    if (!book) return res.status(404).json({ message: 'Book not found' })

    const version = book.languageVersions.find(v => v.language === language)
    if (!version) return res.status(404).json({ message: 'Language version not found' })

    if (version.isLocked) {
      return res.status(400).json({
        message: 'Sorry! This book version has already been claimed by someone else.'
      })
    }

    if (req.user.language !== language) {
      return res.status(403).json({
        message: `You are assigned to ${req.user.language}, not ${language}`
      })
    }

    if (!validateClaimStage(version, claimType)) {
      return res.status(400).json({
        message: `This book version is not ready for ${claimType} claim right now`
      })
    }

    if (claimType === 'audio' && version.assignedRecorder && version.assignedRecorder.toString() !== userId.toString()) {
      return res.status(400).json({
        message: 'This audio task is currently assigned to another recorder for revision.'
      })
    }

    const existingClaim = await Claim.findOne({ claimedBy: userId, status: 'active' })
      .populate('book', 'title bookNumber')

    if (existingClaim) {
      return res.status(400).json({
        message: `You already have an active claim for ${existingClaim.book?.title || 'a book'} until ${new Date(existingClaim.deadline).toLocaleString()}. Complete or release it before claiming another.`
      })
    }

    const deadline = new Date()
    deadline.setDate(deadline.getDate() + committedDays)

    const claimUpdate = {
      'languageVersions.$.isLocked': true,
      'languageVersions.$.lockedBy': userId,
      'languageVersions.$.lockedUntil': deadline
    }

    if (claimType === 'translation') {
      claimUpdate['languageVersions.$.assignedTranslator'] = userId
      claimUpdate['languageVersions.$.translatorDeadline'] = deadline
      claimUpdate['languageVersions.$.textStatus'] = 'translation_in_progress'
    } else if (claimType === 'checking') {
      claimUpdate['languageVersions.$.assignedChecker'] = userId
      claimUpdate['languageVersions.$.checkerDeadline'] = deadline
      claimUpdate['languageVersions.$.textStatus'] = 'checking_in_progress'
    } else if (claimType === 'audio') {
      claimUpdate['languageVersions.$.assignedRecorder'] = userId
      claimUpdate['languageVersions.$.recorderDeadline'] = deadline
      claimUpdate['languageVersions.$.audioStatus'] = 'audio_generated'
    } else if (claimType === 'audio_check') {
      claimUpdate['languageVersions.$.assignedAudioChecker'] = userId
      claimUpdate['languageVersions.$.audioCheckerDeadline'] = deadline
      claimUpdate['languageVersions.$.audioStatus'] = 'audio_checking_in_progress'
    }

    // Atomic lock: only one claimant can succeed.
    const lockQuery = getClaimLockQuery(bookId, language, claimType)
    const lockResult = await Book.updateOne(lockQuery, { $set: claimUpdate })
    if (!lockResult.modifiedCount) {
      return res.status(409).json({
        message: 'This task was claimed by someone else or stage changed. Please refresh and try again.'
      })
    }

    const claim = await Claim.create({
      book: bookId,
      language,
      claimedBy: userId,
      claimType,
      daysCommitted: committedDays,
      deadline
    })

    await sendMail({
      to: req.user.email,
      subject: `Task Claimed â€” ${book.title} (${language})`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
          <p>Pranam <strong>${req.user.name}</strong>,</p>
          <p>You have successfully claimed the following task:</p>
          <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <strong>Book:</strong> ${book.title}<br/>
            <strong>Language:</strong> ${language}<br/>
            <strong>Task:</strong> ${claimType}<br/>
            <strong>Days Committed:</strong> ${committedDays} days<br/>
            <strong>Deadline:</strong> ${deadline.toDateString()}
          </div>
          <p style="color: #888; font-size: 12px;">
            This is an automated message from Shantikunj LMS.
          </p>
        </div>
      `
    })

    await createNotification({
      userId: req.user._id,
      type: 'task',
      title: 'Task claimed successfully',
      message: `${book.title} (${language}) has been assigned to you.`,
      metadata: { bookId: book._id, language, claimType, deadline }
    })

    res.status(201).json({ message: 'Task claimed successfully!', claim, deadline })

    await logAudit({
      req,
      action: 'task_claimed',
      entityType: 'claim',
      entityId: claim._id,
      book: book._id,
      language,
      fromState: 'unclaimed',
      toState: claimType,
      metadata: { claimType, deadline }
    })

  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Get all available (unclaimed) versions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getAvailableBooks = async (req, res) => {
  try {
    await expireOverdueClaimsForUser(req.user._id)

    if (req.user.role === 'regional_team') {
      return res.status(200).json([])
    }

    const userLanguage = req.user.language
    const allowedClaimTypeByRole = {
      translator: 'translation',
      checker: 'checking',
      audio_checker: 'audio_check',
      recorder: 'audio'
    }

    const allowedStagesByRole = {
      translator: ['translation'],
      checker: ['checking'],
      audio_checker: ['audio_checking'],
      recorder: ['audio_generation']
    }

    const claimType = allowedClaimTypeByRole[req.user.role]
    if (!claimType) {
      return res.status(403).json({ message: 'Your role cannot claim tasks' })
    }

    if (req.user.role === 'recorder') {
      const pendingRevisionTask = await findPendingRecorderRevisionTask(req.user._id)
      if (pendingRevisionTask) {
        return res.status(200).json([])
      }
    }

    const elemMatchQuery = {
      language: userLanguage,
      isLocked: false,
      interestEmailSent: true,
      currentStage: { $in: allowedStagesByRole[req.user.role] }
    }

    if (req.user.role === 'recorder') {
      elemMatchQuery.assignedRecorder = null
    }

    const books = await Book.find({
      'languageVersions': {
        $elemMatch: elemMatchQuery
      }
    }).select('title bookNumber description languageVersions')

    // Filter to show only the user's language version
    const filtered = books.map(book => ({
      _id: book._id,
      title: book.title,
      bookNumber: book.bookNumber,
      description: book.description,
      claimType,
      version: book.languageVersions.find(v =>
        v.language === userLanguage && allowedStagesByRole[req.user.role].includes(v.currentStage)
      )
    }))

    res.status(200).json(filtered.filter(item => item.version))
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

// â”€â”€ Get my active claim â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getMyClaim = async (req, res) => {
  try {
    await expireOverdueClaimsForUser(req.user._id)

    const claim = await Claim.findOne({
      claimedBy: req.user._id,
      status: 'active'
    }).populate('book', 'title bookNumber')

    if (!claim) {
      return res.status(200).json({ message: 'No active claim', claim: null })
    }

    res.status(200).json({ claim })
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message })
  }
}

const getMyClaimHistory = async (req, res) => {
  try {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120))
    const claimType = req.query.claimType ? String(req.query.claimType) : null

    const filter = { claimedBy: req.user._id }
    if (claimType) {
      filter.claimType = claimType
    }

    const claims = await Claim.find(filter)
      .populate('book', 'title bookNumber')
      .sort({ updatedAt: -1 })
      .limit(limit)

    return res.status(200).json(claims)
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message })
  }
}

module.exports = {
  sendInterestEmail,
  claimBook,
  getAvailableBooks,
  getMyClaim,
  getMyClaimHistory
}