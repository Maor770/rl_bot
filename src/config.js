'use strict';
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  TZ: process.env.TZ || 'Asia/Jerusalem',

  // WhatsApp
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || '',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || '',
  BOT_PUBLIC_WHATSAPP_NUMBER: process.env.BOT_PUBLIC_WHATSAPP_NUMBER || '972552770695',

  // Google Sheets
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

  // OpenAI
  AI_ENABLED: (process.env.AI_ENABLED || '').toUpperCase() === 'TRUE',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',

  // App
  WEBSITE_BASE_URL: (process.env.WEBSITE_BASE_URL || '').replace(/\/+$/, ''),
  ADMIN_PHONE: process.env.ADMIN_PHONE || '',
};
