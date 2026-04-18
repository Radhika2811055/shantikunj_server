const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const dotenv = require('dotenv')
const Book = require('../models/Book')
const Claim = require('../models/Claim')
const User = require('../models/User')

dotenv.config({ path: '.env' })

const run = async () => {
  let createdBookId = null

  try {
    await mongoose.connect(process.env.MONGO_URI)

    const admin = await User.findOne({ role: 'admin', status: 'approved', isActive: true }).select('_id email role')
    if (!admin) {
      console.log(JSON.stringify({ ok: false, error: 'No approved active admin user found' }, null, 2))
      process.exitCode = 2
      return
    }

    const nextBookNumber = `SMOKE_${Date.now()}`

    const token = jwt.sign(
      { userId: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    )

    const payload = {
      title: `Email Smoke Test ${Date.now()}`,
      bookNumber: nextBookNumber,
      description: 'Temporary smoke-test book for invite verification'
    }

    const response = await fetch('http://localhost:5000/api/books', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    })

    const body = await response.json()
    createdBookId = body?.book?._id || null

    console.log(JSON.stringify({
      ok: response.ok,
      status: response.status,
      adminEmail: admin.email,
      createdBookId,
      createdBookNumber: body?.book?.bookNumber || null,
      inviteSummary: body?.inviteSummary || null
    }, null, 2))

    if (createdBookId) {
      await Claim.deleteMany({ book: createdBookId })
      await Book.findByIdAndDelete(createdBookId)
      console.log(JSON.stringify({ cleanup: 'deleted_test_book_and_related_claims', bookId: createdBookId }, null, 2))
    }

    process.exitCode = response.ok ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message, createdBookId }, null, 2))

    if (createdBookId) {
      await Claim.deleteMany({ book: createdBookId }).catch(() => {})
      await Book.findByIdAndDelete(createdBookId).catch(() => {})
    }

    process.exitCode = 1
  } finally {
    await mongoose.disconnect().catch(() => {})
  }
}

run()
