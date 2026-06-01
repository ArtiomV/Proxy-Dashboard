const { z } = require('zod');

const ClientCreateSchema = z.object({
  name: z.string().min(1).max(200),
  login: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(100),
  portName: z.string().max(100).default(''),
  billingType: z.enum(['per_gb', 'per_modem', 'flat']).default('per_gb'),
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
  slaUptimePct: z.coerce.number().min(0).max(100).optional(),
  slaMaxLatencyMs: z.coerce.number().int().min(1).max(60000).optional(),
  slaMaxErrorPct: z.coerce.number().min(0).max(100).optional(),
  slaAutoCredit: z.boolean().optional(),
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

module.exports = { ClientCreateSchema, ClientUpdateSchema, PaymentSchema, BalanceAdjustSchema, LoginSchema };
