/**
 * ============================================================
 * Siam Treasury Portal (DEMO) — backend nhận phiếu nộp tiền phạt
 * ------------------------------------------------------------
 * Cloudflare Worker, lưu dữ liệu form vào D1.
 *
 * Endpoint:
 *   POST /api/fines    nhận phiếu, trả về mã hồ sơ
 *   GET  /api/health   kiểm tra Worker + kết nối D1
 *
 * Nguyên tắc:
 *   - Validate lại TOÀN BỘ ở server. Validate ở trình duyệt chỉ để
 *     báo lỗi sớm cho người dùng, không phải lớp bảo vệ.
 *   - Luôn dùng prepared statement + bind(), không nội suy chuỗi vào SQL.
 *   - Không nhận và không lưu số thẻ / mật khẩu / OTP.
 *   - Không lưu IP thô, chỉ lưu SHA-256(IP_HASH_SALT + IP).
 * ============================================================
 */

/** Binding rate limit của Workers: env.SUBMIT_LIMITER.limit({ key }) */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  SUBMIT_LIMITER: RateLimitBinding;
  ALLOWED_ORIGINS: string;
  STRICT_THAI_ID: string;
  MAX_BODY_BYTES: string;
  IP_HASH_SALT: string; // secret
  TURNSTILE_SECRET?: string; // secret, tuỳ chọn
}

/* ---------------- Giá trị hợp lệ (khớp <option value> ở form) ---------------- */

const AGENCIES = new Set([
  'traffic-police',
  'local-police',
  'inspectorate',
  'revenue',
  'customs',
  'internal-trade',
  'immigration',
  'other',
]);

const PROVINCES = new Set([
  'bangkok',
  'chiang-mai',
  'chon-buri',
  'phuket',
  'khon-kaen',
  'nakhon-ratchasima',
  'other',
]);

const LIMITS = {
  fullName: 120,
  email: 254,
  orderNo: 64,
  note: 2000,
  amountMin: 10, // 10 THB
  amountMax: 10_000_000,
  issueDateFloor: '2015-01-01',
  dedupeWindowMin: 10,
};

/** Field mà form hợp lệ sẽ không bao giờ gửi — có mặt là dấu hiệu lừa đảo/nhầm lẫn. */
const FORBIDDEN_KEY = /(card|cvv|cvc|otp|password|passwd|pin|secret|token)/i;

/* --------------------------------- Tiện ích --------------------------------- */

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string | null, env: Env): boolean {
  // Không có header Origin (curl, same-origin form) thì không chặn.
  if (!origin) return true;
  const list = allowedOrigins(env);
  return list.includes('*') || list.includes(origin);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  const list = allowedOrigins(env);
  if (origin && (list.includes('*') || list.includes(origin))) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (!origin && list.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  // Không gửi Allow-Credentials: API không dùng cookie.
  return headers;
}

function json(body: unknown, status: number, origin: string | null, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin, env),
    },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Checksum mod-11 của số CMND Thái Lan (13 chữ số). */
function isValidThaiId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return ((11 - (sum % 11)) % 10) === Number(id[12]);
}

/** Chuẩn hoá số điện thoại Thái Lan về dạng +66xxxxxxxxx. Trả null nếu sai. */
function normalizePhone(raw: string): string | null {
  let value = raw.replace(/[^\d+]/g, '');
  if (value.startsWith('+66')) value = '0' + value.slice(3);
  else if (value.startsWith('66') && value.length >= 11) value = '0' + value.slice(2);
  // Di động 0[689]xxxxxxxx (10 số), cố định 0[2-7]xxxxxxx (9 số)
  if (!/^0\d{8,9}$/.test(value)) return null;
  return '+66' + value.slice(1);
}

function isValidEmail(value: string): boolean {
  if (value.length > LIMITS.email) return false;
  return /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

/** Mã hồ sơ STP{yy Phật lịch}{mm}-{6 số}, dùng CSPRNG thay vì Math.random. */
function makeCaseCode(now: Date): string {
  const be = String(now.getUTCFullYear() + 543).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = new Uint32Array(1);
  crypto.getRandomValues(rand);
  return `STP${be}${mm}-${100000 + (rand[0] % 900000)}`;
}

/* -------------------------------- Validate -------------------------------- */

type FieldErrors = Record<string, string>;

interface Submission {
  fullName: string;
  nationalId: string;
  phone: string;
  email: string;
  orderNo: string;
  issueDate: string | null;
  agency: string;
  province: string;
  amountThb: number;
  note: string | null;
  lang: string;
}

/**
 * Khoá trong FieldErrors trùng với id của input trên form (fullname, idnum,
 * phone, ...) để frontend đánh dấu đúng ô mà không cần bảng ánh xạ.
 */
function validate(body: Record<string, unknown>, env: Env): { data?: Submission; errors: FieldErrors } {
  const errors: FieldErrors = {};

  const fullName = asString(body.fullname);
  if (fullName.length < 2) errors.fullname = 'required';
  else if (fullName.length > LIMITS.fullName) errors.fullname = 'too_long';

  const nationalId = onlyDigits(asString(body.idnum));
  if (nationalId.length !== 13) errors.idnum = 'invalid';
  else if (env.STRICT_THAI_ID === 'true' && !isValidThaiId(nationalId)) errors.idnum = 'checksum';

  const phone = normalizePhone(asString(body.phone));
  if (!phone) errors.phone = 'invalid';

  const email = asString(body.email).toLowerCase();
  if (!isValidEmail(email)) errors.email = 'invalid';

  const orderNo = asString(body.decision);
  if (!orderNo) errors.decision = 'required';
  else if (orderNo.length > LIMITS.orderNo) errors.decision = 'too_long';

  // Ngày ra quyết định: không bắt buộc, nhưng nếu có thì phải hợp lý
  let issueDate: string | null = null;
  const rawDate = asString(body.issuedate);
  if (rawDate) {
    const today = new Date().toISOString().slice(0, 10);
    const parsed = new Date(rawDate + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(parsed.getTime())) {
      errors.issuedate = 'invalid';
    } else if (rawDate > today) {
      errors.issuedate = 'future';
    } else if (rawDate < LIMITS.issueDateFloor) {
      errors.issuedate = 'too_old';
    } else {
      issueDate = rawDate;
    }
  }

  const agency = asString(body.agency);
  if (!agency) errors.agency = 'required';
  else if (!AGENCIES.has(agency)) errors.agency = 'not_allowed';

  const province = asString(body.province);
  if (!province) errors.province = 'required';
  else if (!PROVINCES.has(province)) errors.province = 'not_allowed';

  // Form gửi "2,500" nên bỏ dấu phân cách trước khi so sánh
  const amountDigits = onlyDigits(asString(body.amount));
  const amountThb = amountDigits ? Number(amountDigits) : NaN;
  if (!amountDigits) errors.amount = 'required';
  else if (!Number.isSafeInteger(amountThb) || amountThb < LIMITS.amountMin || amountThb > LIMITS.amountMax) {
    errors.amount = 'out_of_range';
  }

  const note = asString(body.note);
  if (note.length > LIMITS.note) errors.note = 'too_long';

  if (body.agree !== true && body.agree !== 'true' && body.agree !== 1) errors.agree = 'required';

  const lang = asString(body.lang) === 'en' ? 'en' : 'th';

  if (Object.keys(errors).length > 0) return { errors };

  return {
    errors,
    data: {
      fullName,
      nationalId,
      phone: phone as string,
      email,
      orderNo,
      issueDate,
      agency,
      province,
      amountThb,
      note: note || null,
      lang,
    },
  };
}

/* -------------------------------- Turnstile -------------------------------- */

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const payload = (await res.json()) as { success?: boolean };
    return payload.success === true;
  } catch {
    return false;
  }
}

/* ------------------------------- Ghi vào D1 ------------------------------- */

interface InsertMeta {
  ipHash: string | null;
  ipCountry: string | null;
  userAgent: string | null;
  cfRay: string | null;
}

/**
 * Chèn phiếu và trả về mã hồ sơ. Mã sinh ngẫu nhiên nên có thể trùng —
 * ràng buộc UNIQUE sẽ bắt được, thử lại tối đa 5 lần.
 */
async function insertSubmission(
  env: Env,
  data: Submission,
  meta: InsertMeta,
  now: Date,
): Promise<string> {
  const sql = `
    INSERT INTO fine_submissions (
      case_code, full_name, national_id, national_id_last4, phone, email,
      order_no, issue_date, agency, province, amount_thb, note, consent, lang,
      ip_hash, ip_country, user_agent, cf_ray, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `;
  const createdAt = now.toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const caseCode = makeCaseCode(now);
    try {
      await env.DB.prepare(sql)
        .bind(
          caseCode,
          data.fullName,
          data.nationalId,
          data.nationalId.slice(-4),
          data.phone,
          data.email,
          data.orderNo,
          data.issueDate,
          data.agency,
          data.province,
          data.amountThb,
          data.note,
          data.lang,
          meta.ipHash,
          meta.ipCountry,
          meta.userAgent,
          meta.cfRay,
          createdAt,
          createdAt,
        )
        .run();
      return caseCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed') && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error('Không sinh được mã hồ sơ duy nhất sau 5 lần thử');
}

/** Bấm submit hai lần thì trả lại đúng mã cũ thay vì tạo hồ sơ trùng. */
async function findRecentDuplicate(env: Env, data: Submission, now: Date): Promise<string | null> {
  const since = new Date(now.getTime() - LIMITS.dedupeWindowMin * 60_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT case_code FROM fine_submissions
      WHERE order_no = ? AND national_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(data.orderNo, data.nationalId, since)
    .first<{ case_code: string }>();
  return row?.case_code ?? null;
}

/* --------------------------------- Handler --------------------------------- */

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');

  if (!isOriginAllowed(origin, env)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, origin, env);
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return json({ ok: false, error: 'unsupported_media_type' }, 415, origin, env);
  }

  const maxBytes = Number(env.MAX_BODY_BYTES || '16384');
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > maxBytes) {
    return json({ ok: false, error: 'payload_too_large' }, 413, origin, env);
  }

  const ip = request.headers.get('CF-Connecting-IP');
  const ipHash = ip && env.IP_HASH_SALT ? await sha256Hex(env.IP_HASH_SALT + ip) : null;

  // Rate limit theo IP đã băm (không đưa IP thô vào key)
  if (env.SUBMIT_LIMITER) {
    const { success } = await env.SUBMIT_LIMITER.limit({ key: ipHash ?? 'no-ip' });
    if (!success) {
      return json({ ok: false, error: 'rate_limited' }, 429, origin, env);
    }
  }

  // Đọc body dưới dạng text để tự kiểm tra kích thước thật (Content-Length có thể thiếu)
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return json({ ok: false, error: 'payload_too_large' }, 413, origin, env);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400, origin, env);
  }

  // Trang web cam kết không bao giờ hỏi thẻ/OTP — chặn luôn ở backend.
  const forbidden = Object.keys(body).filter((key) => FORBIDDEN_KEY.test(key));
  if (forbidden.length > 0) {
    return json({ ok: false, error: 'forbidden_field', fields: forbidden }, 400, origin, env);
  }

  if (env.TURNSTILE_SECRET) {
    const token = asString(body['cf-turnstile-response']) || asString(body.turnstileToken);
    if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET, ip))) {
      return json({ ok: false, error: 'captcha_failed' }, 403, origin, env);
    }
  }

  const { data, errors } = validate(body, env);
  if (!data) {
    return json({ ok: false, error: 'validation_failed', fields: errors }, 422, origin, env);
  }

  const now = new Date();
  try {
    const duplicate = await findRecentDuplicate(env, data, now);
    if (duplicate) {
      return json({ ok: true, case_code: duplicate, duplicate: true, received_at: now.toISOString() }, 200, origin, env);
    }

    const caseCode = await insertSubmission(
      env,
      data,
      {
        ipHash,
        ipCountry: (request.cf?.country as string | undefined) ?? null,
        // Cắt bớt để không phình dòng dữ liệu
        userAgent: (request.headers.get('User-Agent') || '').slice(0, 300) || null,
        cfRay: request.headers.get('CF-Ray'),
      },
      now,
    );

    return json({ ok: true, case_code: caseCode, received_at: now.toISOString() }, 201, origin, env);
  } catch (error) {
    // Không trả chi tiết lỗi DB ra ngoài; log lại để xem bằng `wrangler tail`
    console.error('insert failed', error instanceof Error ? error.stack : error);
    return json({ ok: false, error: 'internal_error' }, 500, origin, env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (url.pathname === '/api/fines' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      try {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: true, db: 'up' }, 200, origin, env);
      } catch {
        return json({ ok: false, db: 'down' }, 503, origin, env);
      }
    }

    if (url.pathname === '/api/fines' || url.pathname === '/api/health') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, origin, env);
    }

    return json({ ok: false, error: 'not_found' }, 404, origin, env);
  },
} satisfies ExportedHandler<Env>;
