const mongoose = require('mongoose')
const dotenv = require('dotenv')
const User = require('../models/User')

dotenv.config({ path: '.env' })

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI)

    const recipients = await User.find({
      role: { $in: ['translator', 'spoc'] },
      status: 'approved',
      isActive: true
    }).select('language role')

    const summaryByLanguage = {}
    for (const item of recipients) {
      const language = String(item.language || '').trim() || 'UNSET'
      if (!summaryByLanguage[language]) {
        summaryByLanguage[language] = { translator: 0, spoc: 0 }
      }
      if (item.role === 'translator') summaryByLanguage[language].translator += 1
      if (item.role === 'spoc') summaryByLanguage[language].spoc += 1
    }

    console.log(JSON.stringify({
      totalEligibleRecipients: recipients.length,
      languagesWithEligibleRecipients: Object.keys(summaryByLanguage).length,
      byLanguage: summaryByLanguage
    }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2))
    process.exitCode = 1
  } finally {
    await mongoose.disconnect().catch(() => {})
  }
}

run()
