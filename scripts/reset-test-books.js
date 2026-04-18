const mongoose = require('mongoose')
const dotenv = require('dotenv')
const Book = require('../models/Book')
const Claim = require('../models/Claim')
const Feedback = require('../models/Feedback')
const AuditLog = require('../models/AuditLog')
const Notification = require('../models/Notification')

dotenv.config()

const hasFlag = (flag) => process.argv.includes(flag)

const getArgValue = (name) => {
  const prefix = `${name}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : ''
}

const parseBookNumbers = (raw) => {
  if (!raw) return []

  return [...new Set(
    raw
      .split(',')
      .map((item) => String(item).trim())
      .filter(Boolean)
  )]
}

const buildNotificationFilter = (bookIds) => {
  const stringIds = bookIds.map((id) => String(id))

  return {
    $or: [
      { 'metadata.bookId': { $in: bookIds } },
      { 'metadata.bookId': { $in: stringIds } }
    ]
  }
}

const printBooksPreview = (books) => {
  if (books.length === 0) {
    console.log('No books matched your filter.')
    return
  }

  console.log('Matched books (max 20 shown):')
  books.slice(0, 20).forEach((book, idx) => {
    console.log(`${idx + 1}. #${book.bookNumber} - ${book.title}`)
  })

  if (books.length > 20) {
    console.log(`...and ${books.length - 20} more`)
  }
}

const run = async () => {
  const apply = hasFlag('--apply')
  const includeNotifications = hasFlag('--include-notifications')
  const rawBookNumbers = getArgValue('--bookNumbers')
  const targetBookNumbers = parseBookNumbers(rawBookNumbers)
  const numericBookNumbers = targetBookNumbers
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing in .env')
  }

  const bookFilter = targetBookNumbers.length > 0
    ? {
      $or: [
        { bookNumber: { $in: targetBookNumbers } },
        ...(numericBookNumbers.length > 0 ? [{ bookNumber: { $in: numericBookNumbers } }] : [])
      ]
    }
    : {}

  await mongoose.connect(process.env.MONGO_URI)

  const books = await Book.find(bookFilter).select('_id title bookNumber')
  const bookIds = books.map((book) => book._id)

  const summary = {
    books: books.length,
    claims: 0,
    feedback: 0,
    auditLogs: 0,
    notifications: 0
  }

  if (bookIds.length > 0) {
    summary.claims = await Claim.countDocuments({ book: { $in: bookIds } })
    summary.feedback = await Feedback.countDocuments({ book: { $in: bookIds } })
    summary.auditLogs = await AuditLog.countDocuments({ book: { $in: bookIds } })

    if (includeNotifications) {
      summary.notifications = await Notification.countDocuments(buildNotificationFilter(bookIds))
    }
  }

  console.log('--- Reset Test Books Summary ---')
  console.log(`Mode: ${apply ? 'APPLY (destructive)' : 'DRY RUN (no changes)'}`)
  console.log(`Filter: ${targetBookNumbers.length > 0 ? `bookNumber in [${targetBookNumbers.join(', ')}]` : 'all books'}`)
  console.log(`Books matched: ${summary.books}`)
  console.log(`Related claims: ${summary.claims}`)
  console.log(`Related feedback entries: ${summary.feedback}`)
  console.log(`Related audit logs: ${summary.auditLogs}`)
  if (includeNotifications) {
    console.log(`Related notifications: ${summary.notifications}`)
  }

  printBooksPreview(books)

  if (!apply) {
    console.log('No data deleted. Re-run with --apply to perform deletion.')
    console.log('Optional: add --include-notifications to also remove related notifications.')
    return
  }

  if (bookIds.length === 0) {
    console.log('Nothing to delete.')
    return
  }

  const deletedClaims = await Claim.deleteMany({ book: { $in: bookIds } })
  const deletedFeedback = await Feedback.deleteMany({ book: { $in: bookIds } })
  const deletedAuditLogs = await AuditLog.deleteMany({ book: { $in: bookIds } })

  let deletedNotifications = { deletedCount: 0 }
  if (includeNotifications) {
    deletedNotifications = await Notification.deleteMany(buildNotificationFilter(bookIds))
  }

  const deletedBooks = await Book.deleteMany({ _id: { $in: bookIds } })

  console.log('--- Deletion Completed ---')
  console.log(`Books deleted: ${deletedBooks.deletedCount || 0}`)
  console.log(`Claims deleted: ${deletedClaims.deletedCount || 0}`)
  console.log(`Feedback deleted: ${deletedFeedback.deletedCount || 0}`)
  console.log(`Audit logs deleted: ${deletedAuditLogs.deletedCount || 0}`)
  if (includeNotifications) {
    console.log(`Notifications deleted: ${deletedNotifications.deletedCount || 0}`)
  }
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Reset failed:', error.message)
    try {
      await mongoose.disconnect()
    } catch (_error) {
      // Ignore disconnect errors on failure path.
    }
    process.exit(1)
  })
