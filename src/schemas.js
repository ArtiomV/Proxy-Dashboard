const { z } = require('zod');

const ClientCreateSchema = z.object({
  name: z.string().min(1).max(200),
  login: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(100),
  portName: z.string().max(100).default(''),
  billingType: z.enum(['per_gb', 'per_modem', 'flat']).default('per_modem'),
  price: z.coerce.number().min(0).max(100000).default(0),
  currency: z.enum(['RUB', 'USD', 'EUR']).default('RUB'),
  contact: z.string().max(500).default(''),
  notes: z.string().max(2000).default(''),
  inn: z.string().max(12).default(''),
  kpp: z.string().max(9).default(''),
  legalName: z.string().max(300).default(''),
  contractInfo: z.string().max(500).default(''),
  contractDate: z.string().max(40).default(''),   // #4 settlement date (YYYY-MM-DD)
  address: z.string().max(500).default(''),
  clientType: z.enum(['legal', 'individual']).default('legal'),
  autoActs: z.boolean().default(true),
  autoBills: z.boolean().default(true),
  allowDebt: z.boolean().default(false),
  maxDebt: z.coerce.number().min(0).max(10_000_000).optional(),
  referred_by: z.string().max(20).optional(),
});

const ClientUpdateSchema = ClientCreateSchema.partial().extend({
  password: z.string().min(6).max(100).optional(),
  billingPaused: z.boolean().optional(),
});

const PaymentSchema = z.object({
  amount: z.coerce.number().positive().max(10_000_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(500).default(''),
});

const BalanceAdjustSchema = z.object({
  amount: z.coerce.number(),
  note: z.string().min(1).max(500),
});

const LoginSchema = z.object({
  login: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

// ── B2C retail (WP1) ──────────────────────────────────────────────────────
// Внутренний login = 'u_' + uid (regex выше email не принимает — схему B2B
// не расширяем); email живёт в отдельной колонке clients.email.
const RegisterSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(100),
  ref: z.string().max(20).optional(),
  consent: z.literal(true),                       // чекбокс оферты/ПДн обязателен (WP8)
  turnstile: z.string().max(2048).optional(),     // токен Cloudflare Turnstile
  website: z.string().max(500).optional(),          // honeypot: заполнен → молчаливый ok в роуте (без 400, чтобы не подсказывать боту)
});

const ForgotPasswordSchema = z.object({
  email: z.string().email().max(200),
  turnstile: z.string().max(2048).optional(),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(8).max(100),
});

const ChangePasswordSchema = z.object({
  old: z.string().min(1).max(200),
  new: z.string().min(8).max(100),
});

// Установка/смена email из ЛК (POST /api/client/email) — общий для всех
// типов клиентов (TG-аккаунты и часть B2B без email).
const ClientEmailSchema = z.object({
  email: z.string().email().max(200),
});

// B2C Э4 (WP3): пополнение баланса эквайрингом (POST /api/client/topup).
// Границы суммы проверяет роут по настройкам (min/max динамические).
const TopupSchema = z.object({
  amount: z.coerce.number().positive().max(1000000),
  method: z.enum(['card', 'sbp']),
});

// Telegram Login Widget payload (https://core.telegram.org/widgets/login)
const TelegramAuthSchema = z.object({
  id: z.coerce.number().int().positive(),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  photo_url: z.string().max(500).optional(),
  auth_date: z.coerce.number().int().positive(),
  hash: z.string().min(1).max(200),
});

module.exports = { ClientCreateSchema, ClientUpdateSchema, PaymentSchema, BalanceAdjustSchema, LoginSchema,
  RegisterSchema, ForgotPasswordSchema, ResetPasswordSchema, ChangePasswordSchema, TelegramAuthSchema,
  ClientEmailSchema, TopupSchema };
