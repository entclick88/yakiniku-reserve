# 🔥 YAKINIKU OMAKASE — ระบบจองที่นั่งร้านเนื้อย่างญี่ปุ่น (Exclusive)

ระบบจองที่นั่งแบบพิเศษ รับจำกัด **วันละ 20 ที่** เลียนแบบสถาปัตยกรรมระบบ GGO
(Cloudflare Worker + D1 + LINE LIFF + PromptPay + Cloudinary)

## จุดเด่นตามโจทย์
- ✅ **ต้องเป็นสมาชิกก่อนจอง** — LINE LIFF login แล้วสมัครสมาชิก (บันทึกใน D1)
- ✅ **รับวันละ 20 ที่** — Worker เช็คที่นั่งคงเหลือแบบเรียลไทม์ กันจองเกิน
- ✅ **จองสมบูรณ์เมื่อจ่ายเงิน + แนบสลิป** — PromptPay QR + อัปสลิปขึ้น Cloudinary
- ✅ **ราคา 1,200 / โปรเปิดตัว 999 บาท** — แอดมินเปิด-ปิดโปรได้เอง
- ✅ **เมนู + เรื่องราวเชฟ** (ประสบการณ์ญี่ปุ่น 40 ปี) แสดงในหน้า LIFF
- ✅ **แอดมินเห็นทุกการจองในรูปปฏิทิน** — คลิกวัน → เห็นรายชื่อ/สลิป/สถานะทั้งหมด
- ✅ **แอดมินส่งข้อความเข้า LINE ทุกคน** — broadcast ทั้งหมด หรือเฉพาะผู้จองวันนั้น

## โครงสร้าง
```
YAKINIKU-RESERVE/
├─ worker/
│  ├─ src/index.js      # Backend API (D1 + LINE push/multicast)
│  ├─ schema.sql        # ตาราง members / reservations / settings
│  └─ wrangler.toml     # ตั้งค่า Cloudflare Worker + D1 binding
├─ docs/
│  ├─ index.html        # หน้า LIFF ลูกค้า (สมัครสมาชิก + จอง + จ่ายเงิน)
│  └─ admin.html        # หน้าแอดมิน (ปฏิทิน + broadcast + ตั้งค่า)
└─ README.md
```

---

## ขั้นตอนติดตั้ง

### 1) สร้าง D1 database
```bash
cd worker
npx wrangler d1 create yakiniku-reserve
```
เอา `database_id` ที่ได้ไปแทนใน `wrangler.toml` (ช่อง `REPLACE_WITH_ACTUAL_D1_ID`)

### 2) สร้างตาราง
```bash
npx wrangler d1 execute yakiniku-reserve --file=./schema.sql --remote
```

### 3) ตั้ง secrets
```bash
npx wrangler secret put ADMIN_TOKEN   # รหัสเข้าหน้าแอดมิน (ตั้งเอง)
npx wrangler secret put LINE_TOKEN     # LINE Messaging API Channel access token
```

### 4) Deploy Worker
```bash
npx wrangler deploy
```
จะได้ URL เช่น `https://yakiniku-reserve-worker.xxx.workers.dev`

### 5) ตั้งค่าไฟล์หน้าเว็บ
- `docs/index.html` → แก้ `CONFIG` ด้านบน (`WORKER_URL`, `LIFF_ID`, `CLOUDINARY_CLOUD`, `CLOUDINARY_PRESET`)
- `docs/admin.html` → แก้ `WORKER_URL`

### 6) Cloudinary (สำหรับอัปสลิป)
สร้าง **unsigned upload preset** ใน Cloudinary → เอา cloud name + preset name ไปใส่ใน `CONFIG`

### 7) LINE
- สร้าง **LINE Login / Messaging API channel** + **LIFF app** → endpoint ชี้ไปหน้า `index.html` (GitHub Pages/Cloudflare Pages)
- เอา **LIFF ID** ใส่ใน `CONFIG.LIFF_ID`
- เปิด **Messaging API** เพื่อให้ Worker push/broadcast ได้ (ใช้ `LINE_TOKEN`)

### 8) Deploy หน้าเว็บ (docs/)
Push ขึ้น GitHub แล้วเปิด **GitHub Pages** ที่โฟลเดอร์ `docs/` (หรือ Cloudflare Pages)

---

## API สรุป (Worker)
| Method | Path | ใช้ทำอะไร | สิทธิ์ |
|---|---|---|---|
| GET  | `/api/config` | ราคา/โปร/ที่นั่ง/พร้อมเพย์ | public |
| GET  | `/api/availability?date=` / `?ym=` | ที่นั่งคงเหลือ | public |
| GET/POST | `/api/member` | เช็ค/สมัครสมาชิก | public |
| POST | `/api/reservations` | สร้างการจอง (เช็คสมาชิก+ที่นั่ง) | public |
| GET  | `/api/reservations?date=` | รายการจอง | admin |
| GET  | `/api/reservations/summary?ym=` | สรุปรายวัน (ปฏิทิน) | admin |
| PATCH| `/api/reservations/:id/status` | ยืนยัน/ยกเลิก + แจ้ง LINE | admin |
| GET/PATCH | `/api/settings` | อ่าน/แก้ค่าตั้งค่า | admin |
| POST | `/api/broadcast` | ส่งข้อความหาสมาชิก (all/รายวัน) | admin |
| GET  | `/api/members` | รายชื่อสมาชิก | admin |

## สถานะการจอง
`รอตรวจสอบ` → (แอดมินยืนยัน) → `ยืนยันแล้ว` / `ยกเลิก`

> เมนูและเรื่องเชฟแก้ได้ในตัวแปร `MENU` ที่หัวไฟล์ `docs/index.html`
