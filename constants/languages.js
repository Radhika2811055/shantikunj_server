const TRANSLATION_LANGUAGES = [
  'Gujarati',
  'Marathi',
  'Tamil',
  'Telugu',
  'Malayalam',
  'Kannada',
  'Bengali',
  'Oriya',
  'Assamese',
  'Kumaoni',
  'Garhwali',
  'Chattisgarhiya',
  'Bhojpuri',
  'Sindhi',
  'Punjabi',
  'Urdu',
  'English',
  'French',
  'Spanish',
  'Portuguese',
  'German',
  'Japanese',
  'Russian',
  'Lithuanian',
  'Chinese',
  'Nepali',
  'Dutch',
  'Malay',
  'South Korean'
]

const TRANSLATION_LANGUAGE_MAP = new Map(
  TRANSLATION_LANGUAGES.map((language) => [language.toLowerCase(), language])
)

const normalizeTranslationLanguage = (value) => {
  const key = String(value || '').trim().toLowerCase()
  return TRANSLATION_LANGUAGE_MAP.get(key) || null
}

const isSupportedTranslationLanguage = (value) => Boolean(normalizeTranslationLanguage(value))

module.exports = {
  TRANSLATION_LANGUAGES,
  normalizeTranslationLanguage,
  isSupportedTranslationLanguage
}
