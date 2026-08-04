-- ============================================================
--  YAKINIKU RESERVE — Cloudflare D1 Schema
--  ระบบจองที่นั่งร้านเนื้อย่างญี่ปุ่น (exclusive / จำกัดที่นั่ง)
-- ============================================================

-- ─── สมาชิก (ต้องเป็นสมาชิกก่อนจอง) ─────────────────────────
CREATE TABLE IF NOT EXISTS members (
  user_id     TEXT PRIMARY KEY,          -- LINE userId
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  picture_url TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

-- ─── การจอง ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,          -- เวลาที่จอง (ISO)
  reserve_date  TEXT    NOT NULL,          -- วันที่มาทาน YYYY-MM-DD
  user_id       TEXT    NOT NULL,          -- LINE userId (อ้างอิง members)
  name          TEXT    NOT NULL,
  phone         TEXT    DEFAULT '',
  seats         INTEGER DEFAULT 1,         -- จำนวนที่นั่งในรายการนี้
  amount        REAL    DEFAULT 0,         -- ยอดที่ต้องชำระ
  slip_url      TEXT    DEFAULT '',        -- ลิงก์สลิปโอนเงิน (Cloudinary)
  note          TEXT    DEFAULT '',        -- หมายเหตุจากลูกค้า
  status        TEXT    DEFAULT 'รอตรวจสอบ' -- รอตรวจสอบ / ยืนยันแล้ว / ยกเลิก
);

CREATE INDEX IF NOT EXISTS idx_res_date   ON reservations(reserve_date);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);

-- ─── ตั้งค่าระบบ (แอดมินแก้ได้: ราคา / โปร / จำนวนที่นั่ง/วัน) ─
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('capacity_per_day', '20'),     -- รับวันละกี่ที่
  ('price',            '1200'),   -- ราคาปกติต่อคน
  ('promo_price',      '999'),    -- ราคาโปรโมชั่นเปิดตัว
  ('promo_on',         '1'),      -- 1=เปิดโปร, 0=ปิด
  ('promptpay_id',     '0000000000'), -- เบอร์/เลขบัตร PromptPay ร้าน
  ('shop_name',        'YAKINIKU OMAKASE');
