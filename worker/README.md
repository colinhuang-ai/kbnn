# Backend nhận phiếu nộp tiền phạt — Cloudflare Worker + D1

Nhận `POST` từ form trên [../index.html](../index.html), validate lại toàn bộ ở
server rồi lưu vào D1. Trả về mã hồ sơ dạng `STP{yy Phật lịch}{mm}-{6 số}`.

> Đây là phần backend của một trang **demo**. `Siam Treasury Portal` là tên hư
> cấu. Trước khi dùng thật, đọc mục [Trước khi lên production](#trước-khi-lên-production).

## Endpoint

| Method | Path           | Mô tả                                  |
| ------ | -------------- | -------------------------------------- |
| `POST` | `/api/fines`   | Nhận phiếu, trả mã hồ sơ               |
| `GET`  | `/api/health`  | Kiểm tra Worker + kết nối D1           |

### Request

```jsonc
{
  "fullname":  "Somchai Jaidee",
  "idnum":     "1 2345 67890 12 3",   // 13 số, dấu cách sẽ bị bỏ
  "phone":     "081 234 5678",        // chuẩn hoá về +66812345678
  "email":     "somchai@example.co.th",
  "decision":  "TP-1234/2569",
  "issuedate": "2026-07-15",          // tuỳ chọn, ISO dương lịch
  "agency":    "traffic-police",      // slug, xem allowlist trong src/index.ts
  "province":  "bangkok",             // slug
  "amount":    "2,500",               // baht, dấu phẩy được bỏ
  "note":      "…",                   // tuỳ chọn, tối đa 2000 ký tự
  "agree":     true,                  // bắt buộc true
  "lang":      "th"                   // "th" | "en"
}
```

### Response

| Mã                    | Khi nào                                     | Body                                                        |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `201`                 | Lưu thành công                              | `{ ok: true, case_code, received_at }`                      |
| `200`                 | Trùng phiếu trong 10 phút (bấm submit 2 lần)| `{ ok: true, case_code, duplicate: true, received_at }`     |
| `422`                 | Dữ liệu sai                                 | `{ ok: false, error, fields: { <id ô input>: <mã lỗi> } }`   |
| `400`                 | JSON hỏng, hoặc có field thẻ/OTP            | `{ ok: false, error }`                                      |
| `403`                 | Origin không được phép / Turnstile sai      | `{ ok: false, error }`                                      |
| `413` / `415`         | Body quá lớn / sai Content-Type             | `{ ok: false, error }`                                      |
| `429`                 | Vượt rate limit                             | `{ ok: false, error: "rate_limited" }`                       |
| `500`                 | Lỗi phía server (chi tiết chỉ có trong log) | `{ ok: false, error: "internal_error" }`                     |

Khoá trong `fields` trùng với `id` của input trên form (`fullname`, `idnum`,
`phone`, `email`, `decision`, `issuedate`, `agency`, `province`, `amount`,
`agree`) nên frontend đánh dấu được ô sai mà không cần bảng ánh xạ.

## Chạy local

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars     # rồi sửa IP_HASH_SALT thành chuỗi ngẫu nhiên
npx wrangler d1 migrations apply stp-fines --local
npm run dev                        # http://127.0.0.1:8787
```

Thử nhanh:

```bash
curl -i http://127.0.0.1:8787/api/health
```

Xem dữ liệu đã lưu:

```bash
npm run db:list
```

### Test cả trang web với backend

Mở `index.html` bằng `file://` sẽ **không** gọi được API: trình duyệt gửi
`Origin: null` và Worker từ chối. Phải serve qua HTTP:

```bash
python -m http.server 8788 --bind 127.0.0.1
```

Rồi trong [../index.html](../index.html) đặt:

```js
var API_ENDPOINT = 'http://127.0.0.1:8787/api/fines';
```

Cổng `8788` đã có sẵn trong `ALLOWED_ORIGINS`. Khi `API_ENDPOINT` rỗng, form
chạy chế độ demo: sinh mã hồ sơ trong trình duyệt, không gửi đi đâu — và trang
tự đổi banner + dòng cam kết cho khớp với việc dữ liệu có được gửi hay không.

## Deploy

```bash
cd worker

# 1. Tạo database, dán database_id vào wrangler.jsonc
npx wrangler d1 create stp-fines

# 2. Tạo bảng trên database thật (thiếu --remote là chỉ chạy ở local)
npx wrangler d1 migrations apply stp-fines --remote

# 3. Secret (KHÔNG đặt trong wrangler.jsonc)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put TURNSTILE_SECRET   # tuỳ chọn, xem bên dưới

# 4. Sửa ALLOWED_ORIGINS trong wrangler.jsonc thành domain thật, rồi:
npx wrangler deploy

# 5. Xem log chạy thật
npx wrangler tail
```

Sau đó đặt `API_ENDPOINT` trong `index.html` thành
`https://stp-fine-intake.<subdomain>.workers.dev/api/fines`.

## Những gì Worker đã làm sẵn

- **Validate lại toàn bộ ở server.** Validate ở trình duyệt chỉ để báo lỗi sớm;
  ai cũng có thể bỏ qua nó. `agency`/`province` kiểm tra theo allowlist slug nên
  giá trị bị bơm vào `<select>` sẽ bị chặn.
- **Prepared statement + `bind()`** ở mọi truy vấn, không nội suy chuỗi vào SQL.
- **Chuẩn hoá dữ liệu**: số CMND bỏ hết ký tự không phải số, điện thoại về dạng
  `+66…`, email hạ chữ thường, số tiền bỏ dấu phân cách.
- **Checksum CMND Thái Lan** (mod-11). Mặc định TẮT (`STRICT_THAI_ID: "false"`)
  vì người thử demo hay nhập số bừa. Bật `"true"` cho production.
  Số hợp lệ để test: `1101700207757`.
- **Chống gửi trùng**: cùng `order_no` + số CMND trong 10 phút thì trả lại đúng
  mã hồ sơ cũ thay vì tạo bản ghi mới.
- **Rate limit** 5 request/60 giây theo IP đã băm.
- **CORS theo allowlist** `ALLOWED_ORIGINS`, có xử lý preflight.
- **Từ chối field thẻ/OTP**: request chứa key khớp
  `card|cvv|cvc|otp|password|pin|secret|token` bị trả 400. Trang web đã cam kết
  không bao giờ hỏi những thứ đó, backend giữ đúng cam kết.
- **Không lưu IP thô**, chỉ lưu `SHA-256(IP_HASH_SALT + IP)`.
- **Không trả chi tiết lỗi DB ra ngoài**; xem bằng `wrangler tail`.

## Trước khi lên production

Những việc còn lại — cố ý không làm sẵn vì phụ thuộc yêu cầu thật của bạn:

1. **Dữ liệu cá nhân.** Bảng chứa họ tên, số CMND, điện thoại, email — thuộc
   phạm vi PDPA (Thái Lan). Cần quyết định: thời hạn lưu và cơ chế tự xoá, ai
   được đọc cột `national_id`, có mã hoá ở tầng ứng dụng hay không, và quy trình
   xử lý khi người dân yêu cầu xoá dữ liệu. Hiện `national_id` lưu dạng rõ vì
   nghiệp vụ nộp phạt cần đối chiếu; nếu không cần thì chỉ giữ `national_id_last4`.

2. **Bật Turnstile.** Chỉ cần `wrangler secret put TURNSTILE_SECRET` là Worker
   bắt buộc xác thực; nhớ thêm widget vào form và gửi kèm
   `cf-turnstile-response`. Không có bước này thì form public sẽ bị bot spam.
   Repo có sẵn skill `turnstile-spin` để dựng đầu-cuối.

3. **Rate limit hiện là lớp giảm tải, không phải hàng rào.** Bộ đếm của binding
   này là theo từng địa điểm Cloudflare, không phải toàn cầu, và Cloudflare nói
   rõ nó "eventually consistent". Cần chặn chắc thì thêm WAF rate limiting rule
   hoặc đếm trong Durable Object.

4. **Chưa có xác thực để đọc dữ liệu.** Worker chỉ ghi. Cần trang quản trị thì
   phải thêm endpoint đọc có Cloudflare Access hoặc kiểm tra token.

5. **Chưa gửi email/SMS biên nhận** như trang web đang hứa. Dùng Cloudflare
   Email Sending (có skill `cloudflare-email-service`) hoặc nhà cung cấp SMS,
   và nên đẩy qua Queue để không làm chậm response.

6. **`issue_date` đang lưu dương lịch** (do `<input type="date">` trả về vậy),
   trong khi giấy tờ Thái Lan thường ghi Phật lịch. Cần quyết định quy ước hiển
   thị và chuyển đổi.

7. **Time Travel** của D1 giữ 7 ngày (free) / 30 ngày (paid). Nếu cần lưu lâu
   hơn thì thêm `wrangler d1 export` định kỳ sang R2.

## File trong thư mục

| File                                        | Việc                                    |
| ------------------------------------------- | --------------------------------------- |
| `src/index.ts`                              | Toàn bộ Worker: route, validate, ghi D1 |
| `migrations/0001_create_fine_submissions.sql` | Bảng, index, trigger `updated_at`     |
| `wrangler.jsonc`                            | Binding D1, rate limit, vars            |
| `.dev.vars.example`                         | Mẫu secret cho local                    |
