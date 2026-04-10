const Claim = require('../models/Claim')
const Book = require('../models/Book')
const User = require('../models/User')
const sendMail = require('../config/mailer')
const { createBulkNotifications } = require('../services/notificationService')

const FOLLOW_UP_INTERVAL_DAYS = 2

const CLAIM_ROLE_MAP = {
  translation: 'translator',
  checking: 'checker',
  audio: 'recorder',
  audio_check: 'audio_checker'
}

const STAGE_LABEL = {
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

const sendFollowUps = async () => {
  try {
    console.log('Running follow-up job...')
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    const supportContactEmail = process.env.SUPPORT_CONTACT_EMAIL || process.env.EMAIL_USER || ''

    // Find all active claims
    const activeClaims = await Claim.find({ status: 'active' })
      .populate('claimedBy', 'name email')
      .populate('book', 'title bookNumber')

    const now = new Date()

    for (const claim of activeClaims) {
      // Check if deadline has passed
      if (now > claim.deadline) {
        claim.status = 'expired'
        await claim.save()

        // Notify admin about expired claim
        await sendMail({
          to: process.env.EMAIL_USER,
          subject: `⚠️ Claim Expired — ${claim.book.title} (${claim.language})`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #E24B4A;">Claim Expired</h2>
              <p>The following claim has expired without submission:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px;">
                <strong>Book:</strong> ${claim.book.title}<br/>
                <strong>Language:</strong> ${claim.language}<br/>
                <strong>Claimed By:</strong> ${claim.claimedBy.name}<br/>
                <strong>Email:</strong> ${claim.claimedBy.email}<br/>
                <strong>Deadline:</strong> ${claim.deadline.toDateString()}
              </div>
              <p>Please reassign this book version to another team member.</p>
            </div>
          `
        })

        // Unlock and reopen the specific stage for this claim type.
        const book = await Book.findById(claim.book._id)
        if (!book) continue

        const version = book.languageVersions.find(
          v => v.language === claim.language
        )
        if (version) {
          resetVersionForExpiredClaim(version, claim.claimType)
          await book.save()

          const targetRole = CLAIM_ROLE_MAP[claim.claimType]
          const teamMembers = await User.find({
            language: claim.language,
            role: targetRole,
            status: 'approved',
            isActive: true
          }).select('_id name email')

          for (const member of teamMembers) {
            await sendMail({
              to: member.email,
              subject: `Task Reopened — ${STAGE_LABEL[claim.claimType]} — ${book.title} (${claim.language})`,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px;">
                  <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
                  <p>Pranam <strong>${member.name}</strong>,</p>
                  <p>This task is open again for claim because previous deadline expired:</p>
                  <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
                    <strong>Book:</strong> ${book.title}<br/>
                    <strong>Language:</strong> ${claim.language}<br/>
                    <strong>Task:</strong> ${STAGE_LABEL[claim.claimType]}
                  </div>
                  <p>Login and claim if you are available.</p>
                  <a href="${frontendUrl}"
                     style="background: #1D9E75; color: white; padding: 12px 24px;
                            text-decoration: none; border-radius: 6px; display: inline-block;">
                    Open LMS Dashboard
                  </a>
                </div>
              `
            })
          }

          await createBulkNotifications({
            userIds: teamMembers.map((member) => member._id),
            type: 'task',
            title: 'Task reopened for claim',
            message: `${book.title} (${claim.language}) is open again for ${STAGE_LABEL[claim.claimType].toLowerCase()}.`,
            metadata: { bookId: book._id, language: claim.language, claimType: claim.claimType }
          })
        }

        console.log(`Claim expired: ${claim.book.title} - ${claim.language}`)
        continue
      }

      // Check if reminder interval has passed since last follow-up.
      const lastFollowUp = claim.lastFollowUpSent
      const daysSinceFollowUp = lastFollowUp
        ? (now - new Date(lastFollowUp)) / (1000 * 60 * 60 * 24)
        : (now - new Date(claim.claimedAt)) / (1000 * 60 * 60 * 24)

      if (daysSinceFollowUp >= FOLLOW_UP_INTERVAL_DAYS) {
        const daysLeft = Math.ceil(
          (new Date(claim.deadline) - now) / (1000 * 60 * 60 * 24)
        )

        const followUpResult = await sendMail({
          to: claim.claimedBy.email,
          subject: `Follow-up & Assistance: ${claim.book.title} (${claim.language}) — ${daysLeft} days left`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #1D9E75;">Shantikunj Audiobooks LMS</h2>
              <p>Pranam <strong>${claim.claimedBy.name}</strong>,</p>
              <p>This is a friendly follow-up regarding your book assignment:</p>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
                <strong>Book:</strong> ${claim.book.title}<br/>
                <strong>Language:</strong> ${claim.language}<br/>
                <strong>Task Stage:</strong> ${STAGE_LABEL[claim.claimType]}<br/>
                <strong>Deadline:</strong> ${new Date(claim.deadline).toDateString()}<br/>
                <strong style="color: ${daysLeft <= 2 ? '#E24B4A' : '#1D9E75'}">
                  Days Remaining: ${daysLeft} days
                </strong>
              </div>
              ${daysLeft <= 2
                ? `<p style="color: #E24B4A;"><strong>⚠️ Your deadline is approaching soon!</strong></p>`
                : `<p>We hope your work is going well!</p>`
              }
              <p>If you need any help or assistance, please reach out via the support system in LMS${supportContactEmail ? ` or email us at <strong>${supportContactEmail}</strong>` : ''}.</p>
              <a href="${frontendUrl}" 
                 style="background: #1D9E75; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 6px; display: inline-block; margin: 16px 0;">
                Open LMS Dashboard
              </a>
              <p style="color: #888; font-size: 12px;">
                This is an automated message from Shantikunj LMS.
              </p>
            </div>
          `
        })

        if (followUpResult?.sent) {
          // Update tracking only when follow-up is actually delivered.
          claim.lastFollowUpSent = now
          claim.followUpCount += 1
          await claim.save()
          console.log(`Follow-up sent to ${claim.claimedBy.email} for ${claim.book.title}`)
        } else {
          console.warn(`Follow-up skipped/failed for ${claim.claimedBy.email}: ${followUpResult?.error || 'Unknown mail error'}`)
        }
      }
    }

    console.log('Follow-up job completed!')

  } catch (error) {
    console.error('Follow-up job error:', error.message)
  }
}

module.exports = sendFollowUps