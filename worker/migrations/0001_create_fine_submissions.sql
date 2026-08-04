-- ============================================================
-- Bảng lưu phiếu đăng ký nộp tiền phạt gửi từ landing page.
--
-- LƯU Ý VỀ DỮ LIỆU CÁ NHÂN: bảng này chứa họ tên, số CMND, điện
-- thoại, email — thuộc dữ liệu cá nhân theo PDPA của Thái Lan.
-- Không có cột nào chứa số thẻ / mật khẩu / OTP, và Worker chủ
-- động từ chối request mang những field đó.
-- IP thô KHÔNG được lưu; chỉ lưu ip_hash = SHA-256(salt + IP)
-- để truy vết lạm dụng mà không giữ lại IP.
-- ============================================================

CREATE TABLE IF NOT EXISTS fine_submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Mã hồ sơ trả về cho người nộp, dạng STP{yy Phật lịch}{mm}-{6 số}
  case_code         TEXT    NOT NULL UNIQUE,

  -- Thông tin người nộp
  full_name         TEXT    NOT NULL,
  national_id       TEXT    NOT NULL,              -- 13 số, đã bỏ dấu cách
  national_id_last4 TEXT    NOT NULL,              -- để hiển thị/đối chiếu, tránh đọc cột đầy đủ
  phone             TEXT    NOT NULL,              -- đã chuẩn hoá về dạng +66xxxxxxxxx
  email             TEXT    NOT NULL,

  -- Thông tin quyết định xử phạt
  order_no          TEXT    NOT NULL,
  issue_date        TEXT,                          -- ISO 8601 'YYYY-MM-DD' (dương lịch), có thể NULL
  agency            TEXT    NOT NULL,              -- slug, khớp <option value> ở form
  province          TEXT    NOT NULL,              -- slug
  amount_thb        INTEGER NOT NULL,              -- baht nguyên, không phải satang

  note              TEXT,
  consent           INTEGER NOT NULL CHECK (consent IN (0, 1)),
  lang              TEXT    NOT NULL DEFAULT 'th' CHECK (lang IN ('th', 'en')),

  status            TEXT    NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','verifying','awaiting_payment','paid','rejected','cancelled')),

  -- Dấu vết kỹ thuật phục vụ chống lạm dụng
  ip_hash           TEXT,
  ip_country        TEXT,
  user_agent        TEXT,
  cf_ray            TEXT,

  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Tra cứu theo mã hồ sơ đã có UNIQUE index tự động từ ràng buộc UNIQUE.
CREATE INDEX IF NOT EXISTS idx_fs_created_at ON fine_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_status     ON fine_submissions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_email      ON fine_submissions(email);
CREATE INDEX IF NOT EXISTS idx_fs_order_no   ON fine_submissions(order_no);

-- Dùng để phát hiện gửi trùng (bấm submit hai lần) và để rà lạm dụng
CREATE INDEX IF NOT EXISTS idx_fs_dedupe     ON fine_submissions(order_no, national_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_ip_hash    ON fine_submissions(ip_hash, created_at DESC);

-- Tự cập nhật updated_at. SQLite mặc định tắt recursive_triggers nên
-- lệnh UPDATE bên trong trigger không kích hoạt lại chính nó.
CREATE TRIGGER IF NOT EXISTS trg_fs_updated_at
AFTER UPDATE ON fine_submissions
FOR EACH ROW
BEGIN
  UPDATE fine_submissions
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = NEW.id;
END;
